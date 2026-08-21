import type { HumanAction, HumanIntervention, InterventionKind } from "../../escalation/types.js";
import type { ReplayResult } from "../../replay/result.js";
import {
  isTerminalStatus,
  statusFromResult,
  type RunEvent,
  type RunProgress,
  type RunStatus,
} from "../types.js";

/**
 * Classifying a run from its log alone.
 *
 * The log is the durable record — the registry's in-memory map is a cache that
 * dies with the process — so every status the dashboard shows has to be
 * derivable from these lines. Two things make that harder than reading a
 * field:
 *
 *  1. Discovery and replay ended up with different end-of-run vocabularies.
 *     Replay's `run_end.status` is success/business_outcome/hard_failure;
 *     discovery's `run_end.outcome` is success/dead_end/max_steps/timeout/
 *     escalated_completed/escalated_aborted. Discovery additively emits
 *     `status` in replay's vocabulary as well (see src/discovery/loop.ts), so
 *     `status` is preferred and `outcome` is kept verbatim as
 *     `discoveryOutcome` rather than being flattened away.
 *  2. A crashed run and a running run are byte-identical on disk. See
 *     `isLive` below.
 */

/** Re-exported so callers classifying a run need only this module. */
export { isTerminalStatus, statusFromResult };

export interface DerivedRunState {
  status: RunStatus;
  /**
   * Derived, never a status: a run can be both escalated and successful, and
   * the interesting half is which one.
   */
  escalated: boolean;
  progress: RunProgress;
  /**
   * Best-effort reconstruction, replay only. The log summarises a result
   * rather than embedding it (src/replay/engine.ts `summarizeResult`), so a
   * few fields cannot be recovered — notably a business outcome's `message`
   * and a success's output *values*, which are rebuilt from the redacted
   * `extracted` lines. `<runId>.result.json` is the authoritative copy and
   * callers that have it should prefer it.
   */
  result?: ReplayResult;
  /** Discovery's own vocabulary, kept for fidelity. */
  discoveryOutcome?: string;
  humanIntervention?: HumanIntervention;
}

const INTERVENTION_KINDS: readonly InterventionKind[] = [
  "discovery_stuck",
  "replay_hard_failure",
  "irreversible_confirmation",
];

const HUMAN_ACTION_TYPES: readonly HumanAction["type"][] = [
  "click",
  "fill",
  "select",
  "navigate",
  "approve_step",
  "reject",
  "resume",
  "abort",
];

/**
 * @param isLive whether a process in *this* server is currently driving the
 * run. It cannot be inferred from the events, which is the entire point: an
 * unfinished log says "no run_end yet" and says nothing about whether the
 * writer is still alive. The caller knows (the registry's live map at request
 * time; "nothing is running" during the boot sweep) and has to say so.
 */
export function statusFromEvents(events: RunEvent[], isLive: boolean): DerivedRunState {
  const runStart = findLast(events, "run_start");
  const runEnd = findLast(events, "run_end");
  const kind = kindOf(runStart, runEnd);

  const escalationsRaised = events.filter((e) => e.type === "escalation_raised");
  const escalationsResolved = events.filter((e) => e.type === "escalation_resolved");
  const lastRaised = escalationsRaised.at(-1);
  // Counted rather than flagged: a single run can escalate more than once, and
  // "raised twice, resolved once" is still pending.
  const escalationPending = escalationsRaised.length > escalationsResolved.length;

  const result = kind === "replay" ? reconstructResult(events, runEnd) : undefined;
  const discoveryOutcome =
    kind === "discovery" && typeof runEnd?.outcome === "string" ? runEnd.outcome : undefined;
  const humanIntervention = reconstructIntervention(events, lastRaised, escalationsResolved.at(-1));

  return {
    status: deriveStatus({ runEnd, result, discoveryOutcome, escalationPending, isLive }),
    escalated: runEnd?.humanIntervened === true || escalationsRaised.length > 0,
    progress: deriveProgress(events),
    ...(result ? { result } : {}),
    ...(discoveryOutcome !== undefined ? { discoveryOutcome } : {}),
    ...(humanIntervention ? { humanIntervention } : {}),
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function deriveStatus(input: {
  runEnd: RunEvent | undefined;
  result: ReplayResult | undefined;
  discoveryOutcome: string | undefined;
  escalationPending: boolean;
  isLive: boolean;
}): RunStatus {
  const { runEnd, result, discoveryOutcome, escalationPending, isLive } = input;

  if (runEnd) {
    // Going through statusFromResult where a result was reconstructed keeps
    // this from drifting away from the mapping the rest of the server uses.
    if (result) return statusFromResult(result);
    const fromStatus = fromReplayVocabulary(runEnd.status);
    if (fromStatus) return fromStatus;
    if (discoveryOutcome !== undefined) return fromDiscoveryOutcome(discoveryOutcome);
    // A run_end we can't classify still means the run *ended*, so it is not
    // `crashed` — that word is reserved for "the process died mid-run", which
    // is a different problem with a different fix.
    return "failed";
  }

  // No run_end. `crashed` wins over `escalation_pending` when the run isn't
  // live: a run parked in an escalation whose process is gone is not waiting
  // for an operator — nothing will pick up what they do. Showing it as
  // "awaiting operator" would park it in the queue forever.
  if (!isLive) return "crashed";
  return escalationPending ? "escalation_pending" : "running";
}

function fromReplayVocabulary(status: unknown): RunStatus | undefined {
  switch (status) {
    case "success":
      return "succeeded";
    case "business_outcome":
      return "business_outcome";
    case "hard_failure":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * Discovery's outcomes collapse to two: it either produced a usable recording
 * or it didn't.
 *
 * `escalated_completed` is *not* success, though it was until this comment was
 * written. A human unblocking a stuck discovery does not produce a recording —
 * their console actions are not appended to `steps`, and both `cli.ts` and
 * `discovery-runner.ts` already decline to build an artifact for any outcome
 * other than `success`. Counting it here contradicted them, and put a run that
 * yielded nothing into history as succeeded. What the human did is still
 * recorded on the run; it just did not produce the artifact the run existed for.
 */
function fromDiscoveryOutcome(outcome: string): RunStatus {
  return outcome === "success" ? "succeeded" : "failed";
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function deriveProgress(events: RunEvent[]): RunProgress {
  let stepsCompleted = 0;
  let current: RunEvent | undefined;

  for (const event of events) {
    if (event.type === "step_result" && event.ok === true) stepsCompleted += 1;
    // A retry is still "where the run is", so it updates the cursor without
    // counting toward completion.
    if (event.type === "step_result" || event.type === "step_retry") current = event;
  }

  const currentStepId = typeof current?.stepId === "string" ? current.stepId : undefined;
  // step_result doesn't carry a description today; escalation and failure
  // events do, so read whichever spelling is present rather than requiring one.
  const description = current?.stepDescription ?? current?.description;

  return {
    // stepsTotal is the artifact's step count, which is not in the log — the
    // registry fills it in from the catalog when it can.
    stepsCompleted,
    ...(currentStepId !== undefined ? { currentStepId } : {}),
    ...(typeof description === "string" ? { currentStepDescription: description } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

function reconstructResult(events: RunEvent[], runEnd: RunEvent | undefined): ReplayResult | undefined {
  if (!runEnd) return undefined;

  switch (runEnd.status) {
    case "success":
      return {
        status: "success",
        outputs: extractedOutputs(events),
        checkpointsPassed: events
          .filter((e) => e.type === "checkpoint_passed" && typeof e.description === "string")
          .map((e) => e.description as string),
        stepsExecuted:
          typeof runEnd.stepsExecuted === "number"
            ? runEnd.stepsExecuted
            : events.filter((e) => e.type === "step_result" && e.ok === true).length,
      };
    case "business_outcome":
      return {
        status: "business_outcome",
        code: str(runEnd.code) ?? "",
        // Not logged: the run_end line carries code and outcomeId only. The
        // artifact's knownOutcome (and result.json) hold the message.
        message: str(runEnd.message) ?? "",
        outcomeId: str(runEnd.outcomeId) ?? "",
      };
    case "hard_failure": {
      const observed = str(findLast(events, "checkpoint_failed")?.observed);
      return {
        status: "hard_failure",
        stepId: str(runEnd.stepId) ?? "(unknown)",
        stepDescription: str(runEnd.stepDescription) ?? "",
        reason: str(runEnd.reason) ?? "Run failed.",
        ...(str(runEnd.expected) !== undefined ? { expected: str(runEnd.expected) as string } : {}),
        ...(observed !== undefined ? { observed } : {}),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Output values come from the `extracted` lines, which the engine writes
 * already redacted. That's the correct fidelity for a log-derived record:
 * evidence on disk is redacted, and reconstructing from it must not invent
 * cleartext it never had.
 */
function extractedOutputs(events: RunEvent[]): Record<string, string | number> {
  const outputs: Record<string, string | number> = {};
  for (const event of events) {
    if (event.type !== "extracted") continue;
    const name = str(event.outputName);
    if (name === undefined) continue;
    // Last write wins: a flow restart re-extracts everything.
    if (typeof event.value === "string" || typeof event.value === "number") outputs[name] = event.value;
  }
  return outputs;
}

/**
 * A HumanIntervention exists only once a human is done: `raisedAt`/`resolvedAt`
 * are both required by the type, so a still-open escalation deliberately
 * reconstructs to nothing. That case is the `escalation_pending` status, which
 * carries its own summary.
 */
function reconstructIntervention(
  events: RunEvent[],
  raised: RunEvent | undefined,
  resolved: RunEvent | undefined,
): HumanIntervention | undefined {
  if (!raised || !resolved) return undefined;

  const kind = INTERVENTION_KINDS.find((k) => k === raised.kind);
  const decision = resolved.decision === "aborted" ? "aborted" : "resumed";
  const screenshotPath = str(raised.screenshotPath);

  const actions: HumanAction[] = events
    .filter((e) => e.type === "human_action" && e.index > raised.index && e.index < resolved.index)
    .map((e) => ({
      timestamp: e.timestamp,
      type: HUMAN_ACTION_TYPES.find((t) => t === e.actionType) ?? "click",
      detail: str(e.detail) ?? "",
    }));

  return {
    raisedAt: raised.timestamp,
    resolvedAt: resolved.timestamp,
    kind: kind ?? "replay_hard_failure",
    reason: str(raised.reason) ?? "",
    decision,
    actions,
    ...(screenshotPath !== undefined ? { screenshotPath } : {}),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Last, not first: a run that restarted its flow logs a second `run_start`,
 * and the end of the log is always the more recent truth.
 */
function findLast(events: RunEvent[], type: string): RunEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === type) return event;
  }
  return undefined;
}

function kindOf(runStart: RunEvent | undefined, runEnd: RunEvent | undefined): "replay" | "discovery" {
  if (runStart?.kind === "discovery" || runStart?.kind === "replay") return runStart.kind;
  // Older logs predate `kind` on run_start. `outcome` on run_end is discovery's
  // alone, and `goal` on run_start is too.
  if (runEnd?.outcome !== undefined || runStart?.goal !== undefined) return "discovery";
  return "replay";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
