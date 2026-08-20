import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The allowlist + irreversible-action policy, loaded from a JSON file
 * (config/guardrails.json) rather than hardcoded — this is meant to be
 * something an operations team edits per deployment without touching code.
 *
 * Now keyed by app id. The original version's own comment said a real
 * deployment "would key this by tenant/app… this project has one target app,
 * so one config file is the honest amount of infrastructure": a second target
 * arrived, so this is that change, and deliberately no more than that. A
 * flat file (no `apps` key) is still accepted and applies to every app, so
 * nothing that referenced the old shape breaks.
 */
const AppGuardrailsSchema = z.object({
  allowedOrigins: z.array(z.string()).min(1),
  allowedRoutePatterns: z.array(z.string()).min(1),
  allowedActionTypes: z.array(z.string()).min(1),
  // "block" is the only implemented policy — see policy.ts and
  // LEARNING_NOTES.md's Phase 4 entry for why "require confirmation" isn't a
  // second option here: escalation is the actual confirmation path, not a
  // config toggle on this layer.
  irreversibleActionPolicy: z.literal("block"),
  /**
   * Dollar amount at or above which an irreversible step must be confirmed by
   * a human rather than executed unattended. Absent means every irreversible
   * step is blocked, which is the stricter reading and therefore the safe
   * default — see policy.ts for the fail-closed rule.
   */
  irreversibleAmountThreshold: z.number().nonnegative().optional(),
});

export type GuardrailsConfig = z.infer<typeof AppGuardrailsSchema>;

const GuardrailsFileSchema = z.union([
  z.object({ apps: z.record(z.string(), AppGuardrailsSchema) }),
  AppGuardrailsSchema,
]);

/**
 * Resolved relative to this file rather than the process working directory.
 * The old default was `"config/guardrails.json"`, which silently required
 * every entry point to be launched from the repo root — fine for a CLI, wrong
 * for a long-lived server.
 */
const DEFAULT_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "guardrails.json");

const cache = new Map<string, GuardrailsConfig>();
let loadedFrom: string | null = null;

function readFile(path: string): Record<string, GuardrailsConfig> {
  const resolved = isAbsolute(path) ? path : join(process.cwd(), path);
  const parsed = GuardrailsFileSchema.parse(JSON.parse(readFileSync(resolved, "utf-8")));
  if ("apps" in parsed) return parsed.apps;
  // Flat legacy shape: one policy, applied to whichever app asks.
  return { "*": parsed as GuardrailsConfig };
}

export function loadGuardrailsConfig(app: string, path = DEFAULT_CONFIG_PATH): GuardrailsConfig {
  const cached = cache.get(app);
  if (cached && loadedFrom === path) return cached;

  const byApp = readFile(path);
  loadedFrom = path;
  const config = byApp[app] ?? byApp["*"];
  if (!config) {
    throw new Error(
      `No guardrail policy configured for app "${app}". Add it to ${path} — refusing to run an app with no allowlist.`,
    );
  }
  cache.set(app, config);
  return config;
}

/** Test-only escape hatch: bypasses the file-backed cache to inject a config in-memory. */
export function setGuardrailsConfigForTest(app: string, config: GuardrailsConfig): void {
  cache.set(app, config);
}

/** Test-only: drops everything injected or loaded, so one test can't leak policy into the next. */
export function resetGuardrailsConfigForTest(): void {
  cache.clear();
  loadedFrom = null;
}
