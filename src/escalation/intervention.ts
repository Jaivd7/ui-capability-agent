import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { RunLogger } from "../logging/logger.js";
import type { HumanActionPolicy } from "./action-policy.js";
import type { InterventionRegistry, PendingIntervention } from "./intervention-registry.js";
import type { EscalationHandler, EscalationOutcome, InterventionContext } from "./types.js";

export interface RaiseInterventionOptions {
  page: Page;
  context: InterventionContext;
  logger: RunLogger;
  evidenceDir: string;
  registry: InterventionRegistry;
  policy: HumanActionPolicy;
  /** Where this run's console is mounted, e.g. `/runs/<id>/escalation`. */
  basePath: string;
  /** irreversible_confirmation only: runs the actual pending step on approval. */
  executeApprovedStep?: (() => Promise<void>) | undefined;
  /** Called once the intervention is registered, so a run registry can flip its status. */
  onRaised?: ((pending: PendingIntervention) => void) | undefined;
  /** Returns a refusal message if the run must not resume — e.g. the session died while waiting. */
  preResumeCheck?: ((pending: PendingIntervention) => Promise<string | null>) | undefined;
}

export interface InterventionResult {
  outcome: EscalationOutcome;
  screenshotPath: string;
}

/**
 * Pauses automation and hands the *same* live page to a human.
 *
 * "Same session, not a fresh one" is structural rather than asserted: the
 * registry entry holds the identical `page` reference the engine was driving,
 * and this function's promise does not settle until a terminal signal arrives,
 * so the engine stays suspended exactly where it was. Nothing is torn down and
 * nothing is rebuilt.
 *
 * This used to stand up its own Express server on an ephemeral port. It no
 * longer starts anything: the routes live on whichever server mounted the
 * escalation router, and this just registers the run as waiting.
 */
export async function raiseIntervention(opts: RaiseInterventionOptions): Promise<InterventionResult> {
  const { page, context, logger, evidenceDir, registry } = opts;

  mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = join(evidenceDir, `${context.runId}.escalation.png`);
  await page.screenshot({ path: screenshotPath }).catch(() => undefined);

  logger.log({
    type: "escalation_raised",
    runId: context.runId,
    kind: context.kind,
    reason: context.reason,
    currentUrl: context.currentUrl,
    currentStepId: context.currentStepId,
    screenshotPath,
  });

  return new Promise<InterventionResult>((resolve) => {
    const pending = registry.register(
      {
        runId: context.runId,
        context,
        raisedAt: new Date().toISOString(),
        page,
        logger,
        actions: [],
        screenshotPath,
        policy: opts.policy,
        executeApprovedStep: opts.executeApprovedStep,
        preResumeCheck: opts.preResumeCheck,
      },
      (outcome) => resolve({ outcome, screenshotPath }),
    );

    logger.log({ type: "escalation_console_started", runId: context.runId, consoleUrl: opts.basePath });
    console.log(`\n>>> ESCALATION: automation paused. Operator console: ${opts.basePath}\n`);
    opts.onRaised?.(pending);
  });
}

export interface EscalationHandlerDeps {
  page: Page;
  logger: RunLogger;
  evidenceDir: string;
  registry: InterventionRegistry;
  policy: HumanActionPolicy;
  basePathFor: (runId: string) => string;
  onRaised?: ((pending: PendingIntervention) => void) | undefined;
  onResolved?: ((runId: string) => void) | undefined;
  preResumeCheck?: ((pending: PendingIntervention) => Promise<string | null>) | undefined;
}

/**
 * Adapts `raiseIntervention` to the `EscalationHandler` shape both engines
 * already accept — which is why relocating the console required no change at
 * all to `runReplay` or `runDiscovery`.
 */
export function createEscalationHandler(deps: EscalationHandlerDeps): EscalationHandler {
  return async (ctx, executeApprovedStep) => {
    const { outcome } = await raiseIntervention({
      page: deps.page,
      context: ctx,
      logger: deps.logger,
      evidenceDir: deps.evidenceDir,
      registry: deps.registry,
      policy: deps.policy,
      basePath: deps.basePathFor(ctx.runId),
      executeApprovedStep,
      onRaised: deps.onRaised,
      preResumeCheck: deps.preResumeCheck,
    });
    deps.onResolved?.(ctx.runId);
    return outcome;
  };
}
