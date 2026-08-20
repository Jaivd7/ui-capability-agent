import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArtifact } from "../artifact/index.js";
import { computeContentHash } from "../artifact/hash.js";
import { readonlyCredentials, tellerCredentials } from "../shared/credentials.js";
import { startAuthenticatedSession } from "../shared/session.js";
import { createRunLogger } from "../logging/logger.js";
import { loadGuardrailsConfig } from "../guardrails/config.js";
import { evaluateGuardrails } from "../guardrails/policy.js";
import { createEscalationHandler } from "../escalation/operator-server.js";
import { redactValue } from "../guardrails/redact.js";
import type { CapabilityArtifact, ParamType } from "../artifact/schema.js";
import type { ParamValue } from "../artifact/template.js";
import { runReplay } from "./engine.js";
import type { ReplayResult } from "./result.js";

interface Args {
  capability: string;
  role: "teller" | "readonly";
  /** Kept as raw strings here; coerced per the artifact's declared param types
   * once the artifact is loaded (see coerceParams). */
  rawParams: Record<string, string>;
  evidenceDir: string;
  escalate: boolean;
  allowHashMismatch: boolean;
}

function parseArgs(argv: string[]): Args {
  const capIdx = argv.indexOf("--capability");
  const capability = capIdx !== -1 ? argv[capIdx + 1] : undefined;
  if (!capability) {
    console.error(
      "Usage: npm run replay -- --capability <id> [--param name=value ...] [--role teller|readonly] [--evidence-dir replay-run] [--escalate] [--allow-hash-mismatch]",
    );
    process.exit(1);
  }
  const roleIdx = argv.indexOf("--role");
  const role = (roleIdx !== -1 ? argv[roleIdx + 1] : "teller") as "teller" | "readonly";
  const evidenceDirIdx = argv.indexOf("--evidence-dir");
  const evidenceDir = evidenceDirIdx !== -1 ? argv[evidenceDirIdx + 1]! : "replay-run";
  const escalate = argv.includes("--escalate");
  const allowHashMismatch = argv.includes("--allow-hash-mismatch");

  const rawParams: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--param") continue;
    const pair = argv[i + 1];
    const eq = pair?.indexOf("=") ?? -1;
    if (!pair || eq === -1) {
      console.error(`--param must be name=value, got "${pair}"`);
      process.exit(1);
    }
    rawParams[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  return { capability, role, rawParams, evidenceDir, escalate, allowHashMismatch };
}

/**
 * Coerces CLI strings using the artifact's own declared param types rather
 * than guessing from the text. The previous "looks numeric -> Number()" rule
 * turned `--param memberId=0042` into 42 for a param declared `string` — a
 * silent corruption that was harmless while params only reached `fill`, and
 * is not harmless now that they also reach locators, URLs and assertions.
 */
function coerceParams(
  artifact: CapabilityArtifact,
  raw: Record<string, string>,
): Record<string, ParamValue> {
  const declared = new Map(artifact.inputParams.map((p) => [p.name, p.type]));
  const out: Record<string, ParamValue> = {};
  for (const [name, text] of Object.entries(raw)) {
    const type = declared.get(name);
    if (type === undefined) {
      console.warn(`Warning: --param ${name} is not declared by this capability; passing through as a string.`);
      out[name] = text;
      continue;
    }
    out[name] = coerceOne(name, text, type);
  }
  return out;
}

function coerceOne(name: string, text: string, type: ParamType): ParamValue {
  switch (type) {
    case "string":
    case "date":
      // Left verbatim on purpose: leading zeros, formatting and locale are all
      // meaningful to the app, and the artifact declared this as text.
      return text;
    case "boolean": {
      const lowered = text.trim().toLowerCase();
      if (["true", "1", "yes"].includes(lowered)) return true;
      if (["false", "0", "no"].includes(lowered)) return false;
      console.error(`--param ${name} must be a boolean (true/false), got "${text}"`);
      return process.exit(1);
    }
    case "number":
    case "currency": {
      const cleaned = text.replace(/[$,\s]/g, "");
      // Number("") is 0, not NaN — check emptiness before parsing.
      const value = cleaned === "" ? Number.NaN : Number(cleaned);
      if (!Number.isFinite(value)) {
        console.error(`--param ${name} must be a ${type}, got "${text}"`);
        return process.exit(1);
      }
      return value;
    }
  }
}

async function main() {
  const { capability, role, rawParams, evidenceDir, escalate, allowHashMismatch } = parseArgs(
    process.argv.slice(2),
  );

  const artifactPath = join(process.cwd(), "capabilities", `${capability}.json`);
  if (!existsSync(artifactPath)) {
    console.error(`No capability artifact at ${artifactPath}. Run discovery first.`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(artifactPath, "utf-8"));
  const parsed = parseArtifact(raw);
  if (!parsed.success) {
    console.error(`Artifact failed schema validation:\n${parsed.errors.join("\n")}`);
    process.exit(1);
  }
  const artifact = parsed.artifact;

  // contentHash is documented as the drift-detection signal, but nothing ever
  // recomputed it — an artifact hand-edited after recording replayed happily
  // with a stale fingerprint, which made the field decorative. Checking it at
  // load is what turns it into an actual integrity guarantee.
  const actualHash = computeContentHash(artifact);
  if (actualHash !== artifact.contentHash) {
    const detail =
      `Artifact contentHash does not match its content.\n` +
      `  recorded: ${artifact.contentHash}\n` +
      `  actual:   ${actualHash}\n` +
      `This means the artifact was edited after it was recorded, or was produced by a different compiler.`;
    if (!allowHashMismatch) {
      console.error(`${detail}\nRe-record it, or pass --allow-hash-mismatch if the edit was deliberate.`);
      process.exit(1);
    }
    console.warn(`Warning: ${detail}\nContinuing because --allow-hash-mismatch was passed.`);
  }

  const params = coerceParams(artifact, rawParams);

  for (const p of artifact.inputParams) {
    if (p.required && !(p.name in params)) {
      console.error(`Missing required --param ${p.name} (${p.type}). Example: ${p.example ?? "n/a"}`);
      process.exit(1);
    }
  }

  const runId = `${artifact.id}-${Date.now()}`;
  const evidenceOutDir = join(process.cwd(), "evidence", evidenceDir);
  mkdirSync(evidenceOutDir, { recursive: true });
  const logger = createRunLogger(runId, evidenceOutDir);

  console.log(`Replaying "${artifact.id}" v${artifact.version} (run "${runId}")...`);
  if (escalate) console.log("Escalation enabled: a stuck run will pause and open an operator console.");
  const credentials = role === "teller" ? tellerCredentials() : readonlyCredentials();
  const session = await startAuthenticatedSession(artifact.target.baseUrl, credentials);

  try {
    const guardrailsConfig = loadGuardrailsConfig();
    const result = await runReplay({
      runId,
      artifact,
      params,
      page: session.page,
      dialogEvents: session.dialogEvents,
      logger,
      guardrail: (step, ctx) => evaluateGuardrails(step, ctx, guardrailsConfig),
      ...(escalate ? { escalate: createEscalationHandler(session.page, logger, evidenceOutDir) } : {}),
    });

    // The in-memory `result` keeps real values (a real caller invoking this
    // programmatically needs the actual balance, not a masked one) --
    // `evidenceResult` is the copy that's actually persisted/printed,
    // redacted the same way transcripts and run logs already are. Evidence
    // meant to sit in a public repo gets the same treatment as everything
    // else this project writes to disk.
    const evidenceResult = redactResultForEvidence(result, artifact);
    writeFileSync(join(evidenceOutDir, `${runId}.result.json`), JSON.stringify(evidenceResult, null, 2));

    // A richer signal on failure, independent of whether escalation was
    // enabled (escalation already captures its own screenshot at the
    // moment it pauses — this covers the plain, non-interactive failure
    // path too, since that's the default way replay runs in production).
    if (result.status === "hard_failure") {
      await session.page.screenshot({ path: join(evidenceOutDir, `${runId}.failure.png`) }).catch(() => undefined);
      const html = await session.page.content().catch(() => null);
      if (html) writeFileSync(join(evidenceOutDir, `${runId}.failure.dom.html`), html);
    }

    console.log(`\nResult: ${result.status}`);
    if (result.status === "success") {
      console.log("Outputs:", JSON.stringify(evidenceResult.status === "success" ? evidenceResult.outputs : {}, null, 2));
    } else if (result.status === "business_outcome") {
      console.log(`${result.code}: ${result.message}`);
    } else {
      console.log(`Failed at step "${result.stepId}" (${result.stepDescription}): ${result.reason}`);
      if (result.expected !== undefined) console.log(`  expected: ${result.expected}`);
      if (result.observed !== undefined) console.log(`  observed: ${result.observed}`);
    }
    if ("humanIntervention" in result && result.humanIntervention) {
      console.log(`Human intervention: ${result.humanIntervention.decision} (${result.humanIntervention.actions.length} action(s))`);
    }
    console.log(`\nEvidence saved to ${evidenceOutDir}/${runId}.*`);

    process.exit(result.status === "hard_failure" ? 1 : 0);
  } finally {
    await session.close();
  }
}

/** Masks any output flagged sensitive in the artifact's contract before the result is written/printed as evidence. */
function redactResultForEvidence(result: ReplayResult, artifact: CapabilityArtifact): ReplayResult {
  if (result.status !== "success") return result;
  const sensitiveNames = new Set(artifact.outputs.filter((o) => o.sensitive).map((o) => o.name));
  if (sensitiveNames.size === 0) return result;
  const outputs = Object.fromEntries(
    Object.entries(result.outputs).map(([k, v]) => [k, redactValue(v, sensitiveNames.has(k))]),
  );
  return { ...result, outputs: outputs as Record<string, string | number> };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
