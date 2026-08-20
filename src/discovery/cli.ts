import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactTranscriptText } from "../guardrails/redact.js";
import { createRunLogger } from "../logging/logger.js";
import { startAuthenticatedSession } from "../shared/session.js";
import type { Page } from "playwright";
import type { ParamValue } from "../artifact/template.js";
import { isKnownRole, listRoles, resolveTargetFor } from "../apps/index.js";
import { startCliEscalation } from "../escalation/index.js";
import { buildArtifact } from "./build-artifact.js";
import { CAPABILITY_PRESETS } from "./capability-presets.js";
import { runDiscovery, type DiscoveryResult } from "./loop.js";
import { formatScoreReport, scoreRecording } from "./score-recording.js";
// Importing the replay engine here does not put an LLM anywhere near replay —
// the structural claim is the other direction (the Anthropic SDK is imported
// only under src/discovery/), and this runs replay with no model in the loop.
import { runReplay } from "../replay/engine.js";
import { loadGuardrailsConfig } from "../guardrails/config.js";
import { evaluateGuardrails } from "../guardrails/policy.js";
import type { ReplayResult } from "../replay/result.js";
import type { CapabilityArtifact } from "../artifact/schema.js";

function parseArgs(argv: string[]): {
  capability: string;
  role: string;
  escalate: boolean;
  verify: boolean;
} {
  const capIdx = argv.indexOf("--capability");
  const capability = capIdx !== -1 ? argv[capIdx + 1] : undefined;
  const roleIdx = argv.indexOf("--role");
  // Validated against the preset's app below — role vocabularies are per-app.
  const role = (roleIdx !== -1 ? argv[roleIdx + 1] : "") ?? "";
  if (capability !== undefined && capability.startsWith("--")) {
    console.error(`--capability requires a value, got "${capability}"`);
    process.exit(1);
  }
  const escalate = argv.includes("--escalate");
  const verify = !argv.includes("--no-verify");
  if (!capability || !CAPABILITY_PRESETS[capability]) {
    console.error(
      `Usage: npm run discover -- --capability <${Object.keys(CAPABILITY_PRESETS).join("|")}> [--role teller|readonly] [--escalate] [--no-verify]`,
    );
    process.exit(1);
  }
  return { capability, role, escalate, verify };
}

async function main() {
  const { capability: capabilityId, role, escalate, verify } = parseArgs(process.argv.slice(2));
  const preset = CAPABILITY_PRESETS[capabilityId]!;

  const runId = `${preset.id}-${Date.now()}`;
  const evidenceDir = join(process.cwd(), "evidence", preset.app, "discovery-run");
  mkdirSync(evidenceDir, { recursive: true });
  const logger = createRunLogger(runId, evidenceDir);

  console.log(`Starting discovery run "${runId}" for capability "${preset.id}"...`);
  if (escalate) console.log("Escalation enabled: getting stuck will pause and open an operator console.");
  const target = resolveTargetFor(preset.app);
  // Default to the role the capability declares it needs. Defaulting a
  // supervisor-gated capability to a teller session just fails at the host.
  const resolvedRole = role || preset.preconditions.requiredRole || listRoles(preset.app)[0]!;
  if (!isKnownRole(preset.app, resolvedRole)) {
    console.error(
      `--role "${resolvedRole}" is not a role of app "${preset.app}". Known roles: ${listRoles(preset.app).join(", ")}.`,
    );
    process.exit(1);
  }
  const session = await startAuthenticatedSession({
    app: preset.app,
    role: resolvedRole,
    baseUrl: target.baseUrl,
  });

  const cliEscalation = escalate
    ? await startCliEscalation({ page: session.page, logger, evidenceDir, app: preset.app })
    : undefined;
  if (cliEscalation) console.log(`Operator console will be served at ${cliEscalation.url}`);

  try {
    const result = await runDiscovery({
      runId,
      capabilityId: preset.id,
      target,
      sessionRole: resolvedRole,
      goal: preset.goal,
      params: preset.params,
      page: session.page,
      dialogEvents: session.dialogEvents,
      logger,
      ...(cliEscalation ? { escalate: cliEscalation.handler } : {}),
    });

    const knownSensitiveValues = sensitiveValuesFrom(result.extractedValues);
    const redactedTranscript = JSON.parse(
      redactTranscriptText(JSON.stringify(result.transcript, null, 2), knownSensitiveValues),
    );
    writeFileSync(join(evidenceDir, `${runId}.transcript.json`), JSON.stringify(redactedTranscript, null, 2));

    if (result.outcome !== "success") {
      // escalated_completed still doesn't produce an artifact -- discovery
      // deliberately doesn't try to synthesize recorded steps from a
      // human's manual actions (see loop.ts's RunDiscoveryOptions doc).
      console.error(`Discovery did not produce an artifact: outcome=${result.outcome}, reason=${result.reason}`);
      if (result.humanIntervention) {
        console.error(
          `Human intervention: ${result.humanIntervention.decision} (${result.humanIntervention.actions.length} action(s))`,
        );
      }
      // A richer signal on failure, independent of whether escalation was
      // enabled for this run.
      await session.page.screenshot({ path: join(evidenceDir, `${runId}.failure.png`) }).catch(() => undefined);
      const html = await session.page.content().catch(() => null);
      if (html) writeFileSync(join(evidenceDir, `${runId}.failure.dom.html`), html);
      await session.close();
      process.exit(1);
    }

    const capabilitiesDir = join(process.cwd(), "capabilities", preset.app);
    const artifactPath = join(capabilitiesDir, `${preset.id}.json`);

    let built;
    try {
      built = buildArtifact({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        // A re-recording is a new revision of the same capability. This used
        // to be hardcoded to 1, so re-recording after a UI change silently
        // left `version` claiming to be the original.
        version: nextVersion(artifactPath),
        target,
        preconditions: preset.preconditions,
        params: preset.params,
        discoveryResult: result,
        knownOutcomes: preset.knownOutcomes,
        ...(preset.irreversibleStepLabels ? { irreversibleStepLabels: preset.irreversibleStepLabels } : {}),
      });
    } catch (err) {
      // The run itself succeeded and its evidence is already on disk; what
      // failed is the compile. Say so plainly rather than dumping a stack —
      // the message names the offending site and the reviewer needs to act on
      // the recording, not debug the compiler.
      console.error(`\nDiscovery completed but the artifact was rejected:\n  ${err instanceof Error ? err.message : String(err)}`);
      console.error(`\nThe run's evidence is still in ${evidenceDir}/${runId}.*`);
      await session.close();
      process.exit(1);
    }
    const { artifact, compileFindings } = built;

    // The differential probe. Replays the artifact we just compiled with a
    // *different* valid argument set, no LLM, on this same live session. The
    // flow demonstrably worked seconds ago with the recorded arguments, so
    // anything that fails here is fitted to those arguments rather than to the
    // app — which is the only way to catch a checkpoint asserting page data
    // that is neither a parameter nor an extracted value (a member's name).
    // Costs a few seconds and no API spend.
    const probe =
      verify && preset.verifyParams
        ? await runDifferentialProbe(artifact, preset.verifyParams, session.page, evidenceDir, runId, resolvedRole)
        : undefined;
    if (!probe) {
      // Say so rather than letting an absent check look like a passed one.
      const why = !verify
        ? "--no-verify was passed"
        : "this capability mutates a shared, stateful target, so a probe would run a second real transaction";
      console.log(`\nDifferential probe SKIPPED: ${why}.`);
    }

    const score = scoreRecording(artifact, {
      extractedValues: result.extractedValues,
      compileFindings,
      ...(probe && preset.verifyParams ? { probe: { params: preset.verifyParams, result: probe } } : {}),
      probeSkipped: !probe,
    });
    console.log(formatScoreReport(score, artifact.id));

    mkdirSync(capabilitiesDir, { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    writeFileSync(join(evidenceDir, `${runId}.artifact.json`), JSON.stringify(artifact, null, 2));
    // Findings only, never the offending values — this file is committed.
    writeFileSync(
      join(evidenceDir, `${runId}.quality.json`),
      JSON.stringify({ capabilityId: artifact.id, ...score }, null, 2),
    );
    logger.log({
      type: "recording_score",
      capabilityId: artifact.id,
      score: score.score,
      grade: score.grade,
      errors: score.findings.filter((f) => f.severity === "error").length,
      warnings: score.findings.filter((f) => f.severity === "warn").length,
    });

    console.log(`\nDiscovery succeeded in ${result.steps.length} step(s).`);
    console.log(`Artifact saved to ${artifactPath}`);
    console.log(`Evidence saved to ${evidenceDir}/${runId}.*`);
  } finally {
    await cliEscalation?.close();
    await session.close();
  }
}

/**
 * The real runtime values to scrub from the transcript before it is written.
 *
 * This used to regex-scrape the transcript for "Extracted <name> = (...)" —
 * which never worked: the loop masks that string with redactValue before the
 * model ever sees it, so the scrape recovered the literal text "[REDACTED]"
 * and fed *that* to the redactor. The transcript came out clean because of
 * redactTranscriptText's blanket currency regex, not because of this
 * function. The loop now returns what it actually read (raw and transformed
 * forms both, since a currency output's number form is not a substring of its
 * "$3,482.10" page form), so there is no scraping and no implicit coupling to
 * a log-line format.
 */
function sensitiveValuesFrom(extracted: DiscoveryResult["extractedValues"]): (string | number)[] {
  const values: (string | number)[] = [];
  for (const record of Object.values(extracted)) {
    if (!record.sensitive) continue;
    values.push(record.value, record.raw.trim());
  }
  return values.filter((v) => String(v) !== "");
}

/**
 * Reads the current revision of this capability, if one exists, so a
 * re-recording increments rather than resetting it.
 */
function nextVersion(artifactPath: string): number {
  if (!existsSync(artifactPath)) return 1;
  try {
    const existing = JSON.parse(readFileSync(artifactPath, "utf-8")) as { version?: unknown };
    return typeof existing.version === "number" && existing.version > 0 ? existing.version + 1 : 1;
  } catch {
    return 1;
  }
}

async function runDifferentialProbe(
  artifact: CapabilityArtifact,
  params: Record<string, ParamValue>,
  page: Page,
  evidenceDir: string,
  runId: string,
  sessionRole: string,
): Promise<ReplayResult | undefined> {
  console.log(`\nVerifying the recording against a different argument set: ${JSON.stringify(params)}`);
  const probeLogger = createRunLogger(`${runId}.probe`, evidenceDir);
  const guardrailsConfig = loadGuardrailsConfig(artifact.target.app);
  try {
    return await runReplay({
      runId: `${runId}-probe`,
      artifact,
      params,
      page,
      logger: probeLogger,
      sessionRole,
      guardrail: (step, ctx) => evaluateGuardrails(step, ctx, guardrailsConfig),
    });
  } catch (err) {
    // A probe that cannot even start (e.g. an unresolved template) is itself
    // the finding; it must never take the recording down with it.
    return {
      status: "hard_failure",
      stepId: "(probe)",
      stepDescription: "(differential probe)",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
