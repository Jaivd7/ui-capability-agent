import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The allowlist + irreversible-action policy, loaded from a JSON file
 * (config/guardrails.json) rather than hardcoded — this is meant to be
 * something an operations team edits per deployment/tenant without
 * touching code, not a compile-time constant. Deliberately a flat, simple
 * shape: three allowlist dimensions (origin, route, action type) plus one
 * policy choice for irreversible actions. A real multi-tenant deployment
 * would key this by tenant/app (see REPORT.md §4); this project has one
 * target app, so one config file is the honest amount of infrastructure
 * to build for it.
 */
const GuardrailsConfigSchema = z.object({
  allowedOrigins: z.array(z.string()).min(1),
  allowedRoutePatterns: z.array(z.string()).min(1),
  allowedActionTypes: z.array(z.string()).min(1),
  // "block" is the only implemented policy — see policy.ts and
  // LEARNING_NOTES.md's Phase 4 entry for why "require confirmation" isn't
  // a second option here: Phase 5's escalation mechanism is the actual
  // confirmation path (a blocked irreversible step is one of the trigger
  // conditions for raising a human handoff), not a config toggle on this
  // layer that would need its own UI to mean anything.
  irreversibleActionPolicy: z.literal("block"),
});

export type GuardrailsConfig = z.infer<typeof GuardrailsConfigSchema>;

let cached: GuardrailsConfig | null = null;

export function loadGuardrailsConfig(path = "config/guardrails.json"): GuardrailsConfig {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  cached = GuardrailsConfigSchema.parse(raw);
  return cached;
}

/** Test-only escape hatch: bypasses the file-backed cache to inject a config in-memory. */
export function setGuardrailsConfigForTest(config: GuardrailsConfig): void {
  cached = config;
}
