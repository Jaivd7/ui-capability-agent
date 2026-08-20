import type { Page } from "playwright";
import type { CapabilityArtifact, Step, ValueRef } from "../artifact/schema.js";
import { assertCondition, detectorMatches } from "../shared/assert.js";
import { extractValue } from "../shared/extract.js";
import { resolveLocator } from "../shared/locator.js";
import type { FrameLocator, LocatorChain } from "../artifact/schema.js";
import { redactValue } from "../guardrails/redact.js";
import type { GuardrailContext, GuardrailDecision } from "../guardrails/policy.js";
import type { RunLogger } from "../logging/logger.js";
import type { EscalationHandler, HumanIntervention, InterventionContext } from "../escalation/types.js";
import { getRecoveryAction } from "./app-config.js";
import { listRoles } from "../apps/index.js";
import { materializeArtifact } from "./materialize.js";
import type { ReplayHardFailure, ReplayResult } from "./result.js";

const ACTION_TIMEOUT_MS = 10_000;
/** Deliberately short: a knownOutcome detector is usually absent, and a business-as-usual
 * replay shouldn't pay a long wait for every "is this condition present?" probe. */
const DETECTOR_TIMEOUT_MS = 1_000;
const MAX_FLOW_RESTARTS = 2;
const MAX_STEP_RETRIES = 2;
/**
 * How many times one step may be re-executed because a *recoverable*
 * knownOutcome fired with a retry_step action. Separate from MAX_STEP_RETRIES,
 * which answers plain transient slowness and is gated on `step.retryable`: a
 * named, detected condition that a recovery action just resolved deserves a
 * retry whether or not the step opted into one.
 */
const MAX_RECOVERY_RETRIES_PER_STEP = 2;

export type { ParamValue } from "../artifact/template.js";
import type { ParamValue } from "../artifact/template.js";

/**
 * A step-execution outcome that hasn't yet been resolved into a caller-facing
 * ReplayResult — used internally to distinguish "keep going," "a knownOutcome
 * fired," and "the whole flow needs to restart after reauth," none of which
 * are meaningful to a caller of runReplay.
 */
type StepOutcome =
  | { kind: "continue" }
  | { kind: "restart_flow" }
  /** A recoverable condition was resolved in place; re-execute the step that hit it. */
  | { kind: "retry_step" }
  | { kind: "resolved"; result: ReplayResult };

/** What to do next in the main step loop, after a step's outcome (possibly escalation) resolves. */
type LoopSignal = { kind: "continue" } | { kind: "restart_flow" } | { kind: "return"; result: ReplayResult };

/** Checked before every step executes — see src/guardrails/policy.ts for the concrete policy. */
export type GuardrailHook = (step: Step, ctx: GuardrailContext) => GuardrailDecision;

export interface ReplayOptions {
  runId: string;
  artifact: CapabilityArtifact;
  params: Record<string, ParamValue>;
  page: Page;
  logger: RunLogger;
  /**
   * The role this run's session authenticated as. Used to re-authenticate with
   * the same privilege on recovery, and to fail fast when the artifact
   * declares a `requiredRole` the session doesn't have.
   */
  sessionRole?: string;
  guardrail?: GuardrailHook;
  /**
   * When set, a guardrail-blocked irreversible step becomes a human
   * confirmation request instead of an immediate hard failure, and an
   * otherwise-terminal hard failure gets one chance for a human to
   * intervene on the same live session before replay gives up. Allowlist
   * violations (domain/route/action-type) never go through this — see the
   * guardrail-check block below for why that's a hard boundary, not a
   * confirmable one.
   */
  escalate?: EscalationHandler;
}

/**
 * Executes a saved artifact with no LLM in the loop — the production
 * replay path. Validates inputs, walks the recorded steps deterministically
 * using the same locator-resolution and assertion logic discovery used to
 * record them, detects the three-tier outcome (success / business outcome /
 * hard failure) per docs/artifact-schema.md's error taxonomy, and verifies
 * the final checkpoint(s) before declaring success.
 */
export async function runReplay(rawOpts: ReplayOptions): Promise<ReplayResult> {
  validateParams(rawOpts.artifact, rawOpts.params);

  // Resolve every `${param}` in the artifact once, before anything touches the
  // browser, so the rest of this function (and every helper it calls) works
  // with concrete strings and an unresolved placeholder aborts the run rather
  // than surfacing mid-flow. See src/replay/materialize.ts.
  const opts: ReplayOptions = {
    ...rawOpts,
    artifact: materializeArtifact(rawOpts.artifact, rawOpts.params),
  };

  const outputs: Record<string, string | number> = {};
  const recoveryAttempts = new Map<string, number>();
  // Records the most recent escalation this run went through, so it can be
  // attached to the eventual *success* result too (not just a hard
  // failure) — an approved irreversible step continues the flow normally
  // afterward, and that success should still show a human was involved,
  // not just the JSONL log.
  let lastIntervention: HumanIntervention | undefined;

  const roleFailure = checkRequiredRole(opts);
  if (roleFailure) {
    logRunStart(opts);
    logFinalResult(opts, roleFailure);
    return roleFailure;
  }

  logRunStart(opts);

  for (let flowAttempt = 1; flowAttempt <= MAX_FLOW_RESTARTS + 1; flowAttempt++) {
    await navigateToEntry(opts);
    if (flowAttempt > 1) opts.logger.log({ type: "flow_restart", attempt: flowAttempt });

    // A restart re-runs the whole recorded sequence, so anything extracted by
    // the abandoned attempt is stale. Leaving it in place let the post-run
    // completeness check below pass on evidence from a run that was thrown
    // away.
    for (const key of Object.keys(outputs)) delete outputs[key];

    let needsFlowRestart = false;
    for (const step of opts.artifact.steps) {
      const guardCtx: GuardrailContext = { currentUrl: opts.page.url() };
      if (step.type === "navigate") {
        guardCtx.targetUrl = new URL(step.urlTemplate, opts.artifact.target.baseUrl).toString();
      }
      const guardDecision = opts.guardrail?.(step, guardCtx);

      let outcome: StepOutcome;
      if (guardDecision && !guardDecision.allowed) {
        if (guardDecision.code === "irreversible_blocked" && opts.escalate) {
          const confirmation = await handleIrreversibleConfirmation(opts, step, guardDecision, outputs, recoveryAttempts);
          outcome = confirmation.outcome;
          lastIntervention = confirmation.intervention;
        } else {
          // Allowlist violations (action type / origin / route) are a hard
          // boundary and never offered for human override — only the
          // reversible/irreversible classification has a legitimate
          // confirmation path. Approving past the allowlist through this
          // console would defeat the point of having one. See
          // LEARNING_NOTES.md's Phase 5 entry.
          const result: ReplayResult = {
            status: "hard_failure",
            stepId: step.id,
            stepDescription: step.description,
            reason: `Blocked by guardrail: ${guardDecision.reason ?? "not permitted"}.`,
          };
          logFinalResult(opts, result);
          return result;
        }
      } else {
        outcome = await runStepWithRetries(opts, step, outputs, recoveryAttempts);
      }

      const signal = await toLoopSignal(opts, outcome, outputs);
      if (signal.kind === "restart_flow") {
        needsFlowRestart = true;
        break;
      }
      if (signal.kind === "return") {
        logFinalResult(opts, signal.result);
        return signal.result;
      }
      // "continue": proceed to the next step.
    }

    if (needsFlowRestart) continue;

    // The inner loop completed every step without a restart or an early
    // resolution — the flow is done, verify the final checkpoint(s).
    const verification = await verifyCheckpoints(opts);
    if (verification.failure) {
      const resolved = await resolveHardFailure(opts, verification.failure, outputs);
      logFinalResult(opts, resolved);
      return resolved;
    }
    const missing = missingOutputsFailure(opts, outputs);
    if (missing) {
      const resolved = await resolveHardFailure(opts, missing, outputs);
      logFinalResult(opts, resolved);
      return resolved;
    }
    const result: ReplayResult = {
      status: "success",
      outputs,
      // What actually verified, not a copy of the declarations. The previous
      // version returned the same list on every success regardless of what
      // ran, which made it worthless as evidence.
      checkpointsPassed: verification.passed,
      stepsExecuted: opts.artifact.steps.length,
      ...(lastIntervention !== undefined ? { humanIntervention: lastIntervention } : {}),
    };
    logFinalResult(opts, result);
    return result;
  }

  const failure: ReplayHardFailure = {
    status: "hard_failure",
    stepId: "(flow)",
    stepDescription: "(entire flow)",
    reason: `Exceeded ${MAX_FLOW_RESTARTS} flow restart(s) attempting recovery; giving up.`,
  };
  const resolved = await resolveHardFailure(opts, failure, outputs);
  logFinalResult(opts, resolved);
  return resolved;
}

async function toLoopSignal(
  opts: ReplayOptions,
  outcome: StepOutcome,
  outputs: Record<string, string | number>,
): Promise<LoopSignal> {
  if (outcome.kind === "restart_flow") return { kind: "restart_flow" };
  // retry_step is resolved inside runStepWithRetries and never reaches here;
  // treating it as "carry on" keeps the main loop total.
  if (outcome.kind === "continue" || outcome.kind === "retry_step") return { kind: "continue" };
  // A hard failure that already carries a humanIntervention record just
  // came *from* an escalation decision (e.g. the operator rejected an
  // irreversible-confirmation request) — don't immediately raise a second
  // escalation on the failure that resulted from the first one resolving.
  const alreadyEscalated = outcome.result.status === "hard_failure" && outcome.result.humanIntervention !== undefined;
  const result =
    outcome.result.status === "hard_failure" && !alreadyEscalated
      ? await resolveHardFailure(opts, outcome.result, outputs)
      : outcome.result;
  return { kind: "return", result };
}

/**
 * A guardrail blocked a step specifically because it's irreversible — the
 * one violation kind with a legitimate human-confirmation path. Pauses on
 * the live session, shows the operator exactly what they'd be authorizing,
 * and only ever executes the step for real if a human explicitly approves
 * it through the console (never as a silent automatic fallback).
 */
async function handleIrreversibleConfirmation(
  opts: ReplayOptions,
  step: Step,
  guardDecision: GuardrailDecision,
  outputs: Record<string, string | number>,
  recoveryAttempts: Map<string, number>,
): Promise<{ outcome: StepOutcome; intervention: HumanIntervention }> {
  const raisedAt = new Date().toISOString();
  const ctx: InterventionContext = {
    runId: opts.runId,
    capabilityId: opts.artifact.id,
    kind: "irreversible_confirmation",
    reason: guardDecision.reason ?? "Step is marked irreversible.",
    currentUrl: opts.page.url(),
    currentStepId: step.id,
    currentStepDescription: step.description,
    pendingAction: { description: step.description, locatorSummary: summarizeStepTarget(step) },
  };
  const escalationOutcome = await opts.escalate!(ctx, () => executeStep(opts, step, outputs));
  const intervention: HumanIntervention = {
    raisedAt,
    resolvedAt: new Date().toISOString(),
    kind: "irreversible_confirmation",
    reason: ctx.reason,
    decision: escalationOutcome.decision,
    actions: escalationOutcome.actions,
  };

  if (escalationOutcome.decision === "aborted") {
    return {
      intervention,
      outcome: {
        kind: "resolved",
        result: {
          status: "hard_failure",
          stepId: step.id,
          stepDescription: step.description,
          reason: "Irreversible action rejected by operator.",
          humanIntervention: intervention,
        },
      },
    };
  }

  // Approved: executeApprovedStep (passed to opts.escalate above) already
  // ran the real step — via the exact same executeStep used for every
  // other step, not a hand-typed console command — so this is exactly as
  // if the step had succeeded on its own, plus the intervention record.
  opts.logger.log({ type: "step_result", stepId: step.id, ok: true, attempt: 1, humanApproved: true });
  const kOutcome = await checkKnownOutcomes(opts, step.id, recoveryAttempts);
  if (kOutcome.kind === "resolved" && kOutcome.result.status === "hard_failure") {
    return { intervention, outcome: { kind: "resolved", result: { ...kOutcome.result, humanIntervention: intervention } } };
  }
  return { intervention, outcome: kOutcome };
}

/**
 * The last chance before a hard failure becomes final: if escalation is
 * configured, pause on the live session and let a human try to fix
 * whatever's wrong, then re-verify the artifact's checkpoints from wherever
 * they leave the page. If the checkpoints now pass, the run completes as a
 * success (annotated with what the human did); if not, the original
 * failure stands, still annotated so the evidence shows a human tried.
 */
async function resolveHardFailure(
  opts: ReplayOptions,
  failure: ReplayHardFailure,
  outputs: Record<string, string | number>,
): Promise<ReplayResult> {
  if (!opts.escalate) return failure;

  const raisedAt = new Date().toISOString();
  const ctx: InterventionContext = {
    runId: opts.runId,
    capabilityId: opts.artifact.id,
    kind: "replay_hard_failure",
    reason: failure.reason,
    currentUrl: opts.page.url(),
    currentStepId: failure.stepId,
    currentStepDescription: failure.stepDescription,
  };
  const escalationOutcome = await opts.escalate(ctx);
  const intervention: HumanIntervention = {
    raisedAt,
    resolvedAt: new Date().toISOString(),
    kind: "replay_hard_failure",
    reason: failure.reason,
    decision: escalationOutcome.decision,
    actions: escalationOutcome.actions,
  };

  if (escalationOutcome.decision === "aborted") {
    return { ...failure, humanIntervention: intervention };
  }

  const verification = await verifyCheckpoints(opts);
  if (verification.failure) {
    return { ...verification.failure, humanIntervention: intervention };
  }
  // Checkpoints passing is not the same as the capability having delivered its
  // contract. A human recovering a run that failed *because* an extract never
  // happened would otherwise get `success` with an empty outputs map — and the
  // operator console has no extract action, so this is reachable rather than
  // theoretical.
  const missing = missingOutputsFailure(opts, outputs);
  if (missing) {
    return { ...missing, humanIntervention: intervention };
  }
  return {
    status: "success",
    outputs,
    checkpointsPassed: verification.passed,
    stepsExecuted: opts.artifact.steps.length,
    humanIntervention: intervention,
  };
}

/**
 * One emitter for both exits. These were two identical object literals, which
 * is how the `app`/`baseUrl`/`role` fields a run-history view needs came to be
 * missing from a log that already carried everything else.
 */
function logRunStart(opts: ReplayOptions): void {
  opts.logger.log({
    type: "run_start",
    kind: "replay",
    runId: opts.runId,
    capabilityId: opts.artifact.id,
    capabilityVersion: opts.artifact.version,
    app: opts.artifact.target.app,
    baseUrl: opts.artifact.target.baseUrl,
    role: opts.sessionRole ?? defaultRoleFor(opts.artifact.target.app),
    params: redactParamsForLog(opts.artifact, opts.params),
  });
}

function missingOutputsFailure(
  opts: ReplayOptions,
  outputs: Record<string, string | number>,
): ReplayHardFailure | null {
  const missing = opts.artifact.outputs.filter((o) => !(o.name in outputs));
  if (missing.length === 0) return null;
  return {
    status: "hard_failure",
    stepId: opts.artifact.steps[opts.artifact.steps.length - 1]?.id ?? "(none)",
    stepDescription: "(post-run output check)",
    reason: `Declared output(s) never produced: ${missing.map((o) => o.name).join(", ")}.`,
  };
}

/**
 * Only reached when a caller invoked runReplay without declaring the role its
 * session holds. The first role an app declares is its least-privileged
 * ordinary operator by convention.
 */
function defaultRoleFor(app: string): string {
  return listRoles(app)[0] ?? "teller";
}

function summarizeStepTarget(step: Step): string {
  if (step.type === "navigate") return `navigate -> ${step.urlTemplate}`;
  if ("locator" in step) {
    const first = step.locator[0];
    return first ? `${first.strategy} locator, ${step.locator.length} candidate(s)` : "(no locator)";
  }
  return "(no target)";
}

async function navigateToEntry(opts: ReplayOptions): Promise<void> {
  const route = opts.artifact.preconditions.startRoute ?? opts.artifact.target.entryRoute;
  const url = new URL(route, opts.artifact.target.baseUrl).toString();
  await opts.page.goto(url, { timeout: ACTION_TIMEOUT_MS, waitUntil: "load" });
}

async function runStepWithRetries(
  opts: ReplayOptions,
  step: Step,
  outputs: Record<string, string | number>,
  recoveryAttempts: Map<string, number>,
): Promise<StepOutcome> {
  const maxAttempts = step.retryable ? MAX_STEP_RETRIES : 1;
  let lastError: unknown;
  // Two independent budgets. `attempt` answers plain transient slowness and is
  // gated on `step.retryable`; `recoveryRetries` answers a *named* condition
  // that a recovery action just resolved, which deserves another go whether or
  // not the step opted into retries.
  let attempt = 1;
  let recoveryRetries = 0;

  while (attempt <= maxAttempts) {
    try {
      await executeStep(opts, step, outputs);
      opts.logger.log({ type: "step_result", stepId: step.id, ok: true, attempt });
      const outcome = await checkKnownOutcomes(opts, step.id, recoveryAttempts);
      if (outcome.kind !== "retry_step") return outcome;
      if (++recoveryRetries > MAX_RECOVERY_RETRIES_PER_STEP) break;
      opts.logger.log({ type: "step_retry", stepId: step.id, reason: "recovery", recoveryRetries });
      continue;
    } catch (err) {
      lastError = err;
      opts.logger.log({
        type: "step_result",
        stepId: step.id,
        ok: false,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      // The failure itself might BE a recognized condition (e.g. the button
      // vanished because a session-expired redirect happened) — check before
      // treating a raw execution error as an unrecognized hard failure.
      const outcomeFromFailure = await checkKnownOutcomes(opts, step.id, recoveryAttempts);
      if (outcomeFromFailure.kind === "retry_step") {
        if (++recoveryRetries > MAX_RECOVERY_RETRIES_PER_STEP) break;
        opts.logger.log({ type: "step_retry", stepId: step.id, reason: "recovery", recoveryRetries });
        continue;
      }
      if (outcomeFromFailure.kind !== "continue") return outcomeFromFailure;
      attempt += 1;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    kind: "resolved",
    result: {
      status: "hard_failure",
      stepId: step.id,
      stepDescription: step.description,
      reason:
        lastError === undefined
          ? `Recovered from a detected condition ${MAX_RECOVERY_RETRIES_PER_STEP} time(s) and the step still did not settle.`
          : "Step execution failed and no known outcome matched the resulting state.",
      ...(lastError === undefined ? {} : { observed: message }),
    },
  };
}

/**
 * `timeoutMs` is declared on every step in the schema and was read nowhere —
 * a per-step tuning knob that silently did nothing.
 */
function stepTimeout(step: Step): number {
  return step.timeoutMs ?? ACTION_TIMEOUT_MS;
}

/**
 * Resolves a step's locator and records the interesting cases.
 *
 * Falling through to a later candidate means the chain's first choice has
 * stopped working — the earliest signal of UI drift this system gets, and
 * previously invisible because nothing logged which rung resolved. A match
 * count above one means the locator is ambiguous and something else in the
 * chain (or `requireUnique`) decided which element won.
 */
async function resolveStepTarget(opts: ReplayOptions, step: Step & { frame: FrameLocator[]; locator: LocatorChain }) {
  const resolved = await resolveLocator(opts.page, step.frame, step.locator, {
    timeoutMs: stepTimeout(step),
    requireUnique: true,
  });
  if (resolved.candidateIndex > 0 || resolved.matchCount > 1) {
    opts.logger.log({
      type: "locator_resolved",
      stepId: step.id,
      candidateIndex: resolved.candidateIndex,
      strategy: resolved.candidate.strategy,
      matchCount: resolved.matchCount,
      ...(resolved.candidateIndex > 0 ? { usedFallback: true } : {}),
    });
  }
  return resolved;
}

async function executeStep(
  opts: ReplayOptions,
  step: Step,
  outputs: Record<string, string | number>,
): Promise<void> {
  const { page } = opts;
  switch (step.type) {
    case "navigate": {
      const url = new URL(step.urlTemplate, opts.artifact.target.baseUrl);
      await page.goto(url.toString(), { timeout: stepTimeout(step), waitUntil: "load" });
      return;
    }
    case "click": {
      const resolved = await resolveStepTarget(opts, step);
      await resolved.locator.click({ timeout: stepTimeout(step) });
      return;
    }
    case "fill": {
      const resolved = await resolveStepTarget(opts, step);
      await resolved.locator.fill(resolveValueRef(step.value, opts.params), { timeout: stepTimeout(step) });
      return;
    }
    case "select": {
      const resolved = await resolveStepTarget(opts, step);
      await resolved.locator.selectOption(resolveValueRef(step.value, opts.params), { timeout: stepTimeout(step) });
      return;
    }
    case "check": {
      const resolved = await resolveStepTarget(opts, step);
      if (step.checked) await resolved.locator.check({ timeout: stepTimeout(step) });
      else await resolved.locator.uncheck({ timeout: stepTimeout(step) });
      return;
    }
    case "waitFor": {
      await assertCondition(
        page,
        step.frame,
        step.locator,
        step.assertion,
        step.expected,
        step.attributeName,
        stepTimeout(step),
      );
      return;
    }
    case "extract": {
      const resolved = await resolveStepTarget(opts, step);
      const declaredOutput = opts.artifact.outputs.find((o) => o.name === step.outputName);
      // Default the transform from the output's declared type when the
      // recorded step didn't set one (e.g. a currency-typed output whose
      // extract step only specified `from: "innerText"`) — the call
      // contract in `outputs[]` should hold regardless of what discovery
      // happened to record; see LEARNING_NOTES.md's Phase 2 entry.
      const transform = step.read.transform ?? defaultTransformForType(declaredOutput?.type);
      const value = await extractValue(resolved.locator, {
        from: step.read.from,
        ...(step.read.attributeName !== undefined ? { attributeName: step.read.attributeName } : {}),
        ...(transform !== undefined ? { transform } : {}),
      });
      outputs[step.outputName] = value;
      const sensitive = declaredOutput?.sensitive ?? false;
      opts.logger.log({
        type: "extracted",
        stepId: step.id,
        outputName: step.outputName,
        value: redactValue(value, sensitive),
      });
      return;
    }
  }
}

function defaultTransformForType(type: string | undefined): "trim" | "currency" | "number" | "date" | undefined {
  switch (type) {
    case "currency":
      return "currency";
    case "number":
      return "number";
    case "date":
      return "date";
    default:
      return undefined;
  }
}

/**
 * Checks every knownOutcome whose checkAfterStepId is either unset (global —
 * checked after every step) or matches the step that just ran/failed.
 * Business outcomes short-circuit immediately. Recoverable outcomes trigger
 * their named recovery action, bounded by the outcome's own maxAttempts;
 * exhausting it becomes a hard failure naming the outcome that couldn't be
 * recovered from, not a generic step failure.
 */
async function checkKnownOutcomes(
  opts: ReplayOptions,
  afterStepId: string,
  recoveryAttempts: Map<string, number>,
): Promise<StepOutcome> {
  const applicable = opts.artifact.knownOutcomes.filter(
    (o) => o.checkAfterStepId === undefined || o.checkAfterStepId === afterStepId,
  );
  for (const outcome of applicable) {
    const matched = await detectorMatches(opts.page, outcome.detect.frame, outcome.detect.locator, DETECTOR_TIMEOUT_MS);
    if (!matched) continue;

    if (outcome.classification === "business") {
      opts.logger.log({ type: "known_outcome", outcomeId: outcome.id, classification: "business" });
      return {
        kind: "resolved",
        result: { status: "business_outcome", code: outcome.outcome.code, message: outcome.outcome.message, outcomeId: outcome.id },
      };
    }

    // Recoverable.
    const used = recoveryAttempts.get(outcome.id) ?? 0;
    if (used >= outcome.recovery.maxAttempts) {
      opts.logger.log({ type: "known_outcome", outcomeId: outcome.id, classification: "recoverable", exhausted: true });
      return {
        kind: "resolved",
        result: {
          status: "hard_failure",
          stepId: afterStepId,
          stepDescription: `(recoverable condition "${outcome.id}")`,
          reason: `Recoverable condition "${outcome.id}" detected but exhausted its ${outcome.recovery.maxAttempts} recovery attempt(s).`,
        },
      };
    }
    const attempt = used + 1;
    recoveryAttempts.set(outcome.id, attempt);
    opts.logger.log({ type: "known_outcome", outcomeId: outcome.id, classification: "recoverable", action: outcome.recovery.action });

    const action = getRecoveryAction(opts.artifact.target.app, outcome.recovery.action);
    await action.run({
      page: opts.page,
      target: opts.artifact.target,
      sessionRole: opts.sessionRole ?? defaultRoleFor(opts.artifact.target.app),
      // The engine already counts these, so an action that backs off between
      // attempts doesn't need state of its own.
      attempt,
    });

    // "retry_step" used to map to "continue", which advanced the main loop to
    // the *next* step — so dismissAndRetry and reloadAndRetry performed their
    // recovery and then skipped the very step that needed retrying, or fell
    // straight through to a hard failure. The scope now means what it says.
    return { kind: action.scope === "restart_flow" ? "restart_flow" : "retry_step" };
  }
  return { kind: "continue" };
}

interface CheckpointVerification {
  failure: ReplayHardFailure | null;
  /** Descriptions of the checkpoints that actually verified, in order. */
  passed: string[];
}

async function verifyCheckpoints(opts: ReplayOptions): Promise<CheckpointVerification> {
  const passed: string[] = [];
  for (const checkpoint of opts.artifact.checkpoints) {
    try {
      await assertCondition(
        opts.page,
        checkpoint.frame,
        checkpoint.locator,
        checkpoint.assertion,
        checkpoint.expected,
        checkpoint.attributeName,
        ACTION_TIMEOUT_MS,
      );
      passed.push(checkpoint.description);
      opts.logger.log({ type: "checkpoint_passed", description: checkpoint.description });
    } catch (err) {
      const observed = err instanceof Error ? err.message : String(err);
      opts.logger.log({ type: "checkpoint_failed", description: checkpoint.description, observed });
      return {
        passed,
        failure: {
          status: "hard_failure",
          stepId: "(checkpoint)",
          stepDescription: checkpoint.description,
          reason: `Checkpoint not met: ${checkpoint.description}`,
          observed,
        },
      };
    }
  }
  return { failure: null, passed };
}

/**
 * `preconditions.requiredRole` was declared on the artifact and read by
 * nothing, while the schema doc claimed it let replay "fail fast with a clear
 * message instead of discovering the denial mid-flow". The mid-flow detector
 * stays as the backstop — it catches a role the caller misreported — but when
 * the mismatch is knowable up front, say so before touching the app.
 */
function checkRequiredRole(opts: ReplayOptions): ReplayResult | null {
  const required = opts.artifact.preconditions.requiredRole;
  if (!required || !opts.sessionRole || opts.sessionRole === required) return null;
  return {
    status: "business_outcome",
    code: "PERMISSION_DENIED",
    message: `This capability requires the "${required}" role; the session is authenticated as "${opts.sessionRole}".`,
    outcomeId: "(precondition:requiredRole)",
  };
}

function resolveValueRef(ref: ValueRef, params: Record<string, ParamValue>): string {
  if (ref.kind === "literal") return ref.value;
  const value = params[ref.param];
  if (value === undefined) throw new Error(`Missing required param "${ref.param}".`);
  return String(value);
}

function validateParams(artifact: CapabilityArtifact, params: Record<string, ParamValue>): void {
  const missing = artifact.inputParams.filter((p) => p.required && !(p.name in params));
  if (missing.length > 0) {
    throw new Error(`Missing required param(s): ${missing.map((p) => p.name).join(", ")}.`);
  }
}

function redactParamsForLog(
  artifact: CapabilityArtifact,
  params: Record<string, ParamValue>,
): Record<string, unknown> {
  const sensitiveNames = new Set(artifact.inputParams.filter((p) => p.sensitive).map((p) => p.name));
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, redactValue(v, sensitiveNames.has(k))]),
  );
}

function logFinalResult(opts: ReplayOptions, result: ReplayResult): void {
  opts.logger.log({ type: "run_end", status: result.status, ...summarizeResult(result) });
}

function summarizeResult(result: ReplayResult): Record<string, unknown> {
  if (result.status === "success") {
    return {
      stepsExecuted: result.stepsExecuted,
      outputNames: Object.keys(result.outputs),
      humanIntervened: result.humanIntervention !== undefined,
    };
  }
  if (result.status === "business_outcome") {
    return { code: result.code, outcomeId: result.outcomeId };
  }
  return { stepId: result.stepId, reason: result.reason, humanIntervened: result.humanIntervention !== undefined };
}
