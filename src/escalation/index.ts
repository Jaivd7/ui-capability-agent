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
