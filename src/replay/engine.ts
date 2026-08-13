import type { Page } from "playwright";
import type { CapabilityArtifact, Step, ValueRef } from "../artifact/schema.js";
import { assertCondition, detectorMatches } from "../shared/assert.js";
import { extractValue } from "../shared/extract.js";
import { LocatorResolutionError, resolveLocator } from "../shared/locator.js";
import type { DialogEvent } from "../shared/session.js";
import { redactValue } from "../guardrails/redact.js";
import type { RunLogger } from "../logging/logger.js";
import { getRecoveryAction } from "./app-config.js";
import type { ReplayResult } from "./result.js";

const ACTION_TIMEOUT_MS = 10_000;
/** Deliberately short: a knownOutcome detector is usually absent, and a business-as-usual
 * replay shouldn't pay a long wait for every "is this condition present?" probe. */
const DETECTOR_TIMEOUT_MS = 1_000;
const MAX_FLOW_RESTARTS = 2;
const MAX_STEP_RETRIES = 2;

export type ParamValue = string | number | boolean;

/**
 * A step-execution outcome that hasn't yet been resolved into a caller-facing
 * ReplayResult — used internally to distinguish "keep going," "a knownOutcome
 * fired," and "the whole flow needs to restart after reauth," none of which
 * are meaningful to a caller of runReplay.
 */
type StepOutcome =
  | { kind: "continue" }
  | { kind: "restart_flow" }
  | { kind: "resolved"; result: ReplayResult };

export interface GuardrailDecision {
  allowed: boolean;
  reason?: string;
}

/** Extension point Phase 4 populates — checked before every step executes. */
export type GuardrailHook = (step: Step, params: Record<string, ParamValue>) => GuardrailDecision;

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  params: Record<string, ParamValue>;
  page: Page;
  dialogEvents: DialogEvent[];
  logger: RunLogger;
  guardrail?: GuardrailHook;
}

/**
 * Executes a saved artifact with no LLM in the loop — the production
 * replay path. Validates inputs, walks the recorded steps deterministically
 * using the same locator-resolution and assertion logic discovery used to
 * record them, detects the three-tier outcome (success / business outcome /
 * hard failure) per docs/artifact-schema.md's error taxonomy, and verifies
 * the final checkpoint(s) before declaring success.
 */
export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  validateParams(opts.artifact, opts.params);

  const outputs: Record<string, string | number> = {};
  const recoveryAttempts = new Map<string, number>();

  opts.logger.log({
    type: "run_start",
    kind: "replay",
    capabilityId: opts.artifact.id,
    capabilityVersion: opts.artifact.version,
    params: redactParamsForLog(opts.artifact, opts.params),
  });

  for (let flowAttempt = 1; flowAttempt <= MAX_FLOW_RESTARTS + 1; flowAttempt++) {
    await navigateToEntry(opts);
    if (flowAttempt > 1) opts.logger.log({ type: "flow_restart", attempt: flowAttempt });

    let needsFlowRestart = false;
    for (const step of opts.artifact.steps) {
      const guardDecision = opts.guardrail?.(step, opts.params);
      if (guardDecision && !guardDecision.allowed) {
        const result: ReplayResult = {
          status: "hard_failure",
          stepId: step.id,
          stepDescription: step.description,
          reason: `Blocked by guardrail: ${guardDecision.reason ?? "not permitted"}.`,
        };
        logFinalResult(opts, result);
        return result;
      }

      const outcome = await runStepWithRetries(opts, step, outputs, recoveryAttempts);
      if (outcome.kind === "restart_flow") {
        needsFlowRestart = true;
        break;
      }
      if (outcome.kind === "resolved") {
        logFinalResult(opts, outcome.result);
        return outcome.result;
      }
      // "continue": proceed to the next step.
    }

    if (needsFlowRestart) continue;

    // The inner loop completed every step without a restart or an early
    // resolution — the flow is done, verify the final checkpoint(s).
    const checkpointResult = await verifyCheckpoints(opts);
    if (checkpointResult) {
      logFinalResult(opts, checkpointResult);
      return checkpointResult;
    }
    const missingOutputs = opts.artifact.outputs.filter((o) => !(o.name in outputs));
    if (missingOutputs.length > 0) {
      const result: ReplayResult = {
        status: "hard_failure",
        stepId: opts.artifact.steps[opts.artifact.steps.length - 1]?.id ?? "(none)",
        stepDescription: "(post-run output check)",
        reason: `Declared output(s) never produced: ${missingOutputs.map((o) => o.name).join(", ")}.`,
      };
      logFinalResult(opts, result);
      return result;
    }
    const result: ReplayResult = {
      status: "success",
      outputs,
      checkpointsPassed: opts.artifact.checkpoints.map((c) => c.description),
      stepsExecuted: opts.artifact.steps.length,
    };
    logFinalResult(opts, result);
    return result;
  }

  const result: ReplayResult = {
    status: "hard_failure",
    stepId: "(flow)",
    stepDescription: "(entire flow)",
    reason: `Exceeded ${MAX_FLOW_RESTARTS} flow restart(s) attempting recovery; giving up.`,
  };
  logFinalResult(opts, result);
  return result;
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await executeStep(opts, step, outputs);
      opts.logger.log({ type: "step_result", stepId: step.id, ok: true, attempt });
      return checkKnownOutcomes(opts, step.id, recoveryAttempts);
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
      if (outcomeFromFailure.kind !== "continue") return outcomeFromFailure;
      if (attempt < maxAttempts) continue;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    kind: "resolved",
    result: {
      status: "hard_failure",
      stepId: step.id,
      stepDescription: step.description,
      reason: "Step execution failed and no known outcome matched the resulting state.",
      observed: message,
    },
  };
}

async function executeStep(
  opts: ReplayOptions,
  step: Step,
  outputs: Record<string, string | number>,
): Promise<void> {
  const { page } = opts;
  switch (step.type) {
    case "navigate": {
      const url = new URL(substituteUrlTemplate(step.urlTemplate, opts.params), opts.artifact.target.baseUrl);
      await page.goto(url.toString(), { timeout: ACTION_TIMEOUT_MS, waitUntil: "load" });
      return;
    }
    case "click": {
      const resolved = await resolveLocator(page, step.frame, step.locator, { timeoutMs: ACTION_TIMEOUT_MS });
      await resolved.locator.click({ timeout: ACTION_TIMEOUT_MS });
      return;
    }
    case "fill": {
      const resolved = await resolveLocator(page, step.frame, step.locator, { timeoutMs: ACTION_TIMEOUT_MS });
      await resolved.locator.fill(resolveValueRef(step.value, opts.params), { timeout: ACTION_TIMEOUT_MS });
      return;
    }
    case "select": {
      const resolved = await resolveLocator(page, step.frame, step.locator, { timeoutMs: ACTION_TIMEOUT_MS });
      await resolved.locator.selectOption(resolveValueRef(step.value, opts.params), { timeout: ACTION_TIMEOUT_MS });
      return;
    }
    case "check": {
      const resolved = await resolveLocator(page, step.frame, step.locator, { timeoutMs: ACTION_TIMEOUT_MS });
      if (step.checked) await resolved.locator.check({ timeout: ACTION_TIMEOUT_MS });
      else await resolved.locator.uncheck({ timeout: ACTION_TIMEOUT_MS });
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
        ACTION_TIMEOUT_MS,
      );
      return;
    }
    case "extract": {
      const resolved = await resolveLocator(page, step.frame, step.locator, { timeoutMs: ACTION_TIMEOUT_MS });
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
    recoveryAttempts.set(outcome.id, used + 1);
    opts.logger.log({ type: "known_outcome", outcomeId: outcome.id, classification: "recoverable", action: outcome.recovery.action });

    const action = getRecoveryAction(opts.artifact.target.app, outcome.recovery.action);
    await action.run({ page: opts.page, target: opts.artifact.target });

    return { kind: action.scope === "restart_flow" ? "restart_flow" : "continue" };
  }
  return { kind: "continue" };
}

async function verifyCheckpoints(opts: ReplayOptions): Promise<ReplayResult | null> {
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
    } catch (err) {
      return {
        status: "hard_failure",
        stepId: "(checkpoint)",
        stepDescription: checkpoint.description,
        reason: `Checkpoint not met: ${checkpoint.description}`,
        observed: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return null;
}

function resolveValueRef(ref: ValueRef, params: Record<string, ParamValue>): string {
  if (ref.kind === "literal") return ref.value;
  const value = params[ref.param];
  if (value === undefined) throw new Error(`Missing required param "${ref.param}".`);
  return String(value);
}

function substituteUrlTemplate(template: string, params: Record<string, ParamValue>): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing required param "${name}" for urlTemplate.`);
    return String(value);
  });
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
    return { stepsExecuted: result.stepsExecuted, outputNames: Object.keys(result.outputs) };
  }
  if (result.status === "business_outcome") {
    return { code: result.code, outcomeId: result.outcomeId };
  }
  return { stepId: result.stepId, reason: result.reason };
}
