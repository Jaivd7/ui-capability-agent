import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactTranscriptText } from "../guardrails/redact.js";
import { createRunLogger } from "../logging/logger.js";
import { startAuthenticatedSession } from "../shared/session.js";
import { readonlyCredentials, tellerCredentials } from "../shared/credentials.js";
import { createEscalationHandler } from "../escalation/operator-server.js";
import { buildArtifact } from "./build-artifact.js";
import { CAPABILITY_PRESETS, resolveTarget } from "./capability-presets.js";
import { runDiscovery, type DiscoveryResult } from "./loop.js";

function parseArgs(argv: string[]): { capability: string; role: "teller" | "readonly"; escalate: boolean } {
  const capIdx = argv.indexOf("--capability");
  const capability = capIdx !== -1 ? argv[capIdx + 1] : undefined;
  const roleIdx = argv.indexOf("--role");
  const role = roleIdx !== -1 ? argv[roleIdx + 1] : "teller";
  const escalate = argv.includes("--escalate");
  if (!capability || !CAPABILITY_PRESETS[capability]) {
    console.error(
      `Usage: npm run discover -- --capability <${Object.keys(CAPABILITY_PRESETS).join("|")}> [--role teller|readonly] [--escalate]`,
    );
    process.exit(1);
  }
  if (role !== "teller" && role !== "readonly") {
    console.error(`--role must be "teller" or "readonly", got "${role}"`);
    process.exit(1);
  }
  return { capability, role, escalate };
}

async function main() {
  const { capability: capabilityId, role, escalate } = parseArgs(process.argv.slice(2));
  const preset = CAPABILITY_PRESETS[capabilityId]!;

  const runId = `${preset.id}-${Date.now()}`;
  const evidenceDir = join(process.cwd(), "evidence", "discovery-run");
  mkdirSync(evidenceDir, { recursive: true });
  const logger = createRunLogger(runId, evidenceDir);

  console.log(`Starting discovery run "${runId}" for capability "${preset.id}"...`);
  if (escalate) console.log("Escalation enabled: getting stuck will pause and open an operator console.");
  const credentials = role === "teller" ? tellerCredentials() : readonlyCredentials();
  const target = resolveTarget();
  const session = await startAuthenticatedSession(target.baseUrl, credentials);

  try {
    const result = await runDiscovery({
      runId,
      capabilityId: preset.id,
      goal: preset.goal,
      params: preset.params,
      page: session.page,
      dialogEvents: session.dialogEvents,
      logger,
      ...(escalate ? { escalate: createEscalationHandler(session.page, logger, evidenceDir) } : {}),
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

    const { artifact, compileFindings } = buildArtifact({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      version: 1,
      target,
      preconditions: preset.preconditions,
      params: preset.params,
      discoveryResult: result,
      knownOutcomes: preset.knownOutcomes,
    });

    const capabilitiesDir = join(process.cwd(), "capabilities");
    mkdirSync(capabilitiesDir, { recursive: true });
    const artifactPath = join(capabilitiesDir, `${artifact.id}.json`);
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    writeFileSync(join(evidenceDir, `${runId}.artifact.json`), JSON.stringify(artifact, null, 2));

    if (compileFindings.length > 0) {
      console.log("\nCompiler notes:");
      for (const f of compileFindings) {
        console.log(`  ${f.severity.toUpperCase()} ${f.where}: ${f.message}`);
      }
    }

    console.log(`\nDiscovery succeeded in ${result.steps.length} step(s).`);
    console.log(`Artifact saved to ${artifactPath}`);
    console.log(`Evidence saved to ${evidenceDir}/${runId}.*`);
  } finally {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
