import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArtifact } from "../artifact/index.js";
import { readonlyCredentials, tellerCredentials } from "../shared/credentials.js";
import { startAuthenticatedSession } from "../shared/session.js";
import { createRunLogger } from "../logging/logger.js";
import { loadGuardrailsConfig } from "../guardrails/config.js";
import { evaluateGuardrails } from "../guardrails/policy.js";
import { createEscalationHandler } from "../escalation/operator-server.js";
import { redactValue } from "../guardrails/redact.js";
import type { CapabilityArtifact } from "../artifact/schema.js";
import { runReplay, type ParamValue } from "./engine.js";
import type { ReplayResult } from "./result.js";

interface Args {
  capability: string;
  role: "teller" | "readonly";
  params: Record<string, ParamValue>;
  evidenceDir: string;
  escalate: boolean;
}

function parseArgs(argv: string[]): Args {
  const capIdx = argv.indexOf("--capability");
  const capability = capIdx !== -1 ? argv[capIdx + 1] : undefined;
  if (!capability) {
    console.error(
      "Usage: npm run replay -- --capability <id> [--param name=value ...] [--role teller|readonly] [--evidence-dir replay-run] [--escalate]",
    );
    process.exit(1);
  }
  const roleIdx = argv.indexOf("--role");
  const role = (roleIdx !== -1 ? argv[roleIdx + 1] : "teller") as "teller" | "readonly";
  const evidenceDirIdx = argv.indexOf("--evidence-dir");
  const evidenceDir = evidenceDirIdx !== -1 ? argv[evidenceDirIdx + 1]! : "replay-run";
  const escalate = argv.includes("--escalate");

  const params: Record<string, ParamValue> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--param") continue;
    const pair = argv[i + 1];
    const eq = pair?.indexOf("=") ?? -1;
    if (!pair || eq === -1) {
      console.error(`--param must be name=value, got "${pair}"`);
      process.exit(1);
    }
    const name = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    params[name] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }

  return { capability, role, params, evidenceDir, escalate };
}

async function main() {
  const { capability, role, params, evidenceDir, escalate } = parseArgs(process.argv.slice(2));

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
