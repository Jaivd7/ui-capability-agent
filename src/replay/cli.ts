import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isKnownRole, listRoles } from "../apps/index.js";
import { startAuthenticatedSession } from "../shared/session.js";
import { createRunLogger } from "../logging/logger.js";
import { loadGuardrailsConfig } from "../guardrails/config.js";
import { evaluateGuardrails } from "../guardrails/policy.js";
import { startCliEscalation } from "../escalation/index.js";
import { redactValue } from "../guardrails/redact.js";
import type { CapabilityArtifact } from "../artifact/schema.js";
import { runReplay } from "./engine.js";
import { CapabilityLoadError, loadCapabilityById } from "./load-capability.js";
import { ParamValidationError, validateInvocation } from "./coerce.js";
import type { ReplayResult } from "./result.js";

interface Args {
  capability: string;
  role: string;
  /** Kept as raw strings here; coerced per the artifact's declared param types
   * once the artifact is loaded (see coerceParams). */
  rawParams: Record<string, string>;
  evidenceDir: string;
  escalate: boolean;
  allowHashMismatch: boolean;
}

/**
 * Reads `--flag value`, rejecting the case where the "value" is itself a flag.
 * `--capability --escalate` previously yielded the capability "--escalate" and
 * then failed with a confusing missing-file error.
 */
function flagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const capability = flagValue(argv, "--capability");
  if (!capability) {
    console.error(
      "Usage: npm run replay -- --capability <id> [--param name=value ...] [--role teller|readonly] [--evidence-dir replay-run] [--escalate] [--allow-hash-mismatch]",
    );
    process.exit(1);
  }
  // An unchecked cast here meant `--role telller` silently authenticated as
  // readonly and the run failed later with a confusing PERMISSION_DENIED.
  // Validated against the target app's own role vocabulary once the artifact
  // is loaded — role names are a property of the app, not of the engine.
  const role = flagValue(argv, "--role") ?? "";
  const evidenceDir = flagValue(argv, "--evidence-dir") ?? "replay-run";
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

async function main() {
  const { capability, role, rawParams, evidenceDir, escalate, allowHashMismatch } = parseArgs(
    process.argv.slice(2),
  );

  let artifact;
  try {
    artifact = loadCapabilityById(capability, { allowHashMismatch });
  } catch (err) {
    if (err instanceof CapabilityLoadError) {
      console.error(err.message);
      if (err.detail) console.error(err.detail);
      if (err.code === "hash_mismatch") {
        console.error("Re-record it, or pass --allow-hash-mismatch if the edit was deliberate.");
      }
      process.exit(1);
    }
    throw err;
  }
  if (allowHashMismatch) {
    console.warn("Warning: --allow-hash-mismatch was passed; the artifact's contentHash was not enforced.");
  }

  let params;
  try {
    params = validateInvocation(artifact, rawParams).params;
  } catch (err) {
    if (err instanceof ParamValidationError) {
      for (const f of err.fields) console.error(`--param ${f.name} ${f.problem}`);
      process.exit(1);
    }
    throw err;
  }

  const runId = `${artifact.id}-${Date.now()}`;
  const evidenceOutDir = join(process.cwd(), "evidence", artifact.target.app, evidenceDir);
  mkdirSync(evidenceOutDir, { recursive: true });
  const logger = createRunLogger(runId, evidenceOutDir);

  console.log(`Replaying "${artifact.id}" v${artifact.version} (run "${runId}")...`);
  if (escalate) console.log("Escalation enabled: a stuck run will pause and open an operator console.");
  const app = artifact.target.app;
  const resolvedRole = role || listRoles(app)[0]!;
  if (!isKnownRole(app, resolvedRole)) {
    console.error(
      `--role "${resolvedRole}" is not a role of app "${app}". Known roles: ${listRoles(app).join(", ")}.`,
    );
    process.exit(1);
  }
  const session = await startAuthenticatedSession({
    app,
    role: resolvedRole,
    baseUrl: artifact.target.baseUrl,
  });

  const cliEscalation = escalate
    ? await startCliEscalation({
        page: session.page,
        logger,
        evidenceDir: evidenceOutDir,
        app,
        artifact,
      })
    : undefined;
  if (cliEscalation) console.log(`Operator console will be served at ${cliEscalation.url}`);

  try {
    const guardrailsConfig = loadGuardrailsConfig(app);
    const result = await runReplay({
      runId,
      artifact,
      params,
      page: session.page,
      logger,
      sessionRole: resolvedRole,
      guardrail: (step, ctx) => evaluateGuardrails(step, ctx, guardrailsConfig),
      ...(cliEscalation ? { escalate: cliEscalation.handler } : {}),
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
    await cliEscalation?.close();
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
