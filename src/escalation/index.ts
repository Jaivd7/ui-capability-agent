import { getAppAdapter } from "../apps/index.js";
import { loadGuardrailsConfig } from "../guardrails/config.js";
import type { CapabilityArtifact } from "../artifact/schema.js";
import type { RunLogger } from "../logging/logger.js";
import type { Page } from "playwright";
import { createEscalationHandler } from "./intervention.js";
import { createInterventionRegistry } from "./intervention-registry.js";
import { startStandaloneConsole } from "./standalone-console.js";
import type { EscalationHandler } from "./types.js";

export { createInterventionRegistry } from "./intervention-registry.js";
export type { InterventionRegistry, PendingIntervention } from "./intervention-registry.js";
export { escalationRouter } from "./routes.js";
export { createEscalationHandler, raiseIntervention } from "./intervention.js";
export { startStandaloneConsole } from "./standalone-console.js";
export type { HumanActionPolicy } from "./action-policy.js";

/**
 * The values from *this invocation* that the artifact marks sensitive.
 *
 * `HumanActionPolicy.sensitiveValues` existed and was passed an empty array at
 * every construction site, so `describeAction`'s known-sensitive branch was
 * dead code and an operator retyping a member's e-mail during an escalation got
 * it logged as `a[REDACTED]m` — shape-preserving partial masking, which is the
 * fallback for values nothing knows about, not the treatment a declared
 * sensitive param is supposed to get.
 *
 * Inputs rather than outputs, deliberately: this exists for a value the
 * operator *retypes*, and re-entering an e-mail or phone number into a form the
 * automation failed on is the realistic case. Nobody retypes a balance.
 */
export function sensitiveParamValues(
  artifact: CapabilityArtifact | undefined,
  params: Record<string, unknown> | undefined,
): (string | number)[] {
  if (!artifact || !params) return [];
  const out: (string | number)[] = [];
  for (const param of artifact.inputParams) {
    if (!param.sensitive) continue;
    const value = params[param.name];
    if (typeof value === "string" && value !== "") out.push(value);
    else if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  }
  return out;
}

export interface CliEscalationOptions {
  page: Page;
  logger: RunLogger;
  evidenceDir: string;
  app: string;
  artifact?: CapabilityArtifact | undefined;
  sensitiveValues?: readonly (string | number)[];
}

/**
 * The CLI path: a private registry plus a throwaway console on an ephemeral
 * port, wired to the same router and the same action policy the dashboard uses.
 */
export async function startCliEscalation(
  opts: CliEscalationOptions,
): Promise<{ handler: EscalationHandler; close: () => Promise<void>; url: string }> {
  const registry = createInterventionRegistry();
  const console_ = await startStandaloneConsole(registry);
  const adapter = getAppAdapter(opts.app);

  const handler = createEscalationHandler({
    page: opts.page,
    logger: opts.logger,
    evidenceDir: opts.evidenceDir,
    registry,
    policy: {
      guardrails: loadGuardrailsConfig(opts.app),
      app: opts.app,
      artifact: opts.artifact,
      sensitiveValues: opts.sensitiveValues ?? [],
    },
    basePathFor: console_.basePathFor,
    // A session that expired while the operator was deciding cannot simply be
    // resumed: reauth lands on a blank menu, so a half-completed transaction is
    // gone. Refusing is the honest answer; silently re-walking the flow to
    // re-reach a button someone approved minutes ago against different page
    // state is precisely what must never happen automatically.
    preResumeCheck: async (pending) => {
      const loggedOut = await adapter.isLoggedOut(pending.page).catch(() => false);
      if (!loggedOut) return null;
      return "The session expired while awaiting operator input; the run cannot safely resume. Re-invoke the capability.";
    },
  });

  return { handler, close: console_.close, url: console_.url };
}
