import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArtifact } from "../artifact/index.js";
import { readonlyCredentials, tellerCredentials } from "../shared/credentials.js";
import { startAuthenticatedSession } from "../shared/session.js";
import { createRunLogger } from "../logging/logger.js";
import { runReplay, type ParamValue } from "./engine.js";

interface Args {
  capability: string;
  role: "teller" | "readonly";
  params: Record<string, ParamValue>;
  evidenceDir: string;
}

function parseArgs(argv: string[]): Args {
  const capIdx = argv.indexOf("--capability");
  const capability = capIdx !== -1 ? argv[capIdx + 1] : undefined;
  if (!capability) {
    console.error(
      "Usage: npm run replay -- --capability <id> [--param name=value ...] [--role teller|readonly] [--evidence-dir replay-run]",
    );
    process.exit(1);
  }
  const roleIdx = argv.indexOf("--role");
  const role = (roleIdx !== -1 ? argv[roleIdx + 1] : "teller") as "teller" | "readonly";
  const evidenceDirIdx = argv.indexOf("--evidence-dir");
  const evidenceDir = evidenceDirIdx !== -1 ? argv[evidenceDirIdx + 1]! : "replay-run";

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

  return { capability, role, params, evidenceDir };
}

async function main() {
  const { capability, role, params, evidenceDir } = parseArgs(process.argv.slice(2));

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
  const credentials = role === "teller" ? tellerCredentials() : readonlyCredentials();
  const session = await startAuthenticatedSession(artifact.target.baseUrl, credentials);

  try {
    const result = await runReplay({
      artifact,
      params,
      page: session.page,
      dialogEvents: session.dialogEvents,
      logger,
    });

    writeFileSync(join(evidenceOutDir, `${runId}.result.json`), JSON.stringify(result, null, 2));

    console.log(`\nResult: ${result.status}`);
    if (result.status === "success") {
      console.log("Outputs:", JSON.stringify(result.outputs, null, 2));
    } else if (result.status === "business_outcome") {
      console.log(`${result.code}: ${result.message}`);
    } else {
      console.log(`Failed at step "${result.stepId}" (${result.stepDescription}): ${result.reason}`);
      if (result.expected !== undefined) console.log(`  expected: ${result.expected}`);
      if (result.observed !== undefined) console.log(`  observed: ${result.observed}`);
    }
    console.log(`\nEvidence saved to ${evidenceOutDir}/${runId}.*`);

    process.exit(result.status === "hard_failure" ? 1 : 0);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
