import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityArtifact } from "../artifact/schema.js";
import { redactTranscriptText } from "../guardrails/redact.js";
import { createRunLogger } from "../logging/logger.js";
import { startAuthenticatedSession } from "../shared/session.js";
import { readonlyCredentials, tellerCredentials } from "../shared/credentials.js";
import { buildArtifact } from "./build-artifact.js";
import { CAPABILITY_PRESETS, resolveTarget } from "./capability-presets.js";
import { runDiscovery } from "./loop.js";

function parseArgs(argv: string[]): { capability: string; role: "teller" | "readonly" } {
  const capIdx = argv.indexOf("--capability");
  const capability = capIdx !== -1 ? argv[capIdx + 1] : undefined;
  const roleIdx = argv.indexOf("--role");
  const role = roleIdx !== -1 ? argv[roleIdx + 1] : "teller";
  if (!capability || !CAPABILITY_PRESETS[capability]) {
    console.error(
      `Usage: npm run discover -- --capability <${Object.keys(CAPABILITY_PRESETS).join("|")}> [--role teller|readonly]`,
    );
    process.exit(1);
  }
  if (role !== "teller" && role !== "readonly") {
    console.error(`--role must be "teller" or "readonly", got "${role}"`);
    process.exit(1);
  }
  return { capability, role };
}

async function main() {
  const { capability: capabilityId, role } = parseArgs(process.argv.slice(2));
  const preset = CAPABILITY_PRESETS[capabilityId]!;

  const runId = `${preset.id}-${Date.now()}`;
  const evidenceDir = join(process.cwd(), "evidence", "discovery-run");
  const logger = createRunLogger(runId, evidenceDir);

  console.log(`Starting discovery run "${runId}" for capability "${preset.id}"...`);
  const credentials = role === "teller" ? tellerCredentials() : readonlyCredentials();
  const target = resolveTarget();
  const session = await startAuthenticatedSession(target.baseUrl, credentials);

  try {
    const result = await runDiscovery({
      goal: preset.goal,
      params: preset.params,
      page: session.page,
      dialogEvents: session.dialogEvents,
      logger,
    });

    const knownSensitiveValues = collectSensitiveValues(result.outputs, result.transcript);
    const redactedTranscript = JSON.parse(
      redactTranscriptText(JSON.stringify(result.transcript, null, 2), knownSensitiveValues),
    );
    writeFileSync(join(evidenceDir, `${runId}.transcript.json`), JSON.stringify(redactedTranscript, null, 2));

    if (result.outcome !== "success") {
      console.error(`Discovery did not succeed: outcome=${result.outcome}, reason=${result.reason}`);
      await session.close();
      process.exit(1);
    }

    const artifact: CapabilityArtifact = buildArtifact({
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

    console.log(`\nDiscovery succeeded in ${result.steps.length} step(s).`);
    console.log(`Artifact saved to ${artifactPath}`);
    console.log(`Evidence saved to ${evidenceDir}/${runId}.*`);
  } finally {
    await session.close();
  }
}

/** Pulls every sensitive output's runtime value out of the transcript so it can be redacted before persisting. */
function collectSensitiveValues(outputs: { name: string; sensitive: boolean }[], transcript: unknown): (string | number)[] {
  const sensitiveNames = new Set(outputs.filter((o) => o.sensitive).map((o) => o.name));
  if (sensitiveNames.size === 0) return [];
  const text = JSON.stringify(transcript);
  const values: (string | number)[] = [];
  for (const name of sensitiveNames) {
    const match = new RegExp(`Extracted ${name} = ([^.\\\\]+)\\.`).exec(text);
    if (match?.[1]) values.push(match[1]);
  }
  return values;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
