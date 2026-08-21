import { describe, expect, it } from "vitest";
import type { RunEvent } from "../types.js";
import { statusFromEvents } from "./run-status.js";

/**
 * These are the cases the dashboard's status chip is wrong about if the
 * derivation is wrong, and every one of them is a distinction the log makes
 * only implicitly.
 */

function log(...lines: Array<Record<string, unknown> & { type: string }>): RunEvent[] {
  return lines.map((line, index) => ({
    timestamp: new Date(Date.UTC(2026, 7, 20, 18, 0, index)).toISOString(),
    ...line,
    index,
    type: line.type,
  }));
}

const REPLAY_START = { type: "run_start", kind: "replay", runId: "r-1", capabilityId: "cap" };
const DISCOVERY_START = { type: "run_start", kind: "discovery", runId: "d-1", capabilityId: "cap" };

describe("statusFromEvents: replay outcomes", () => {
  it("maps a successful run_end to succeeded", () => {
    const state = statusFromEvents(
      log(
        REPLAY_START,
        { type: "step_result", stepId: "step-1", ok: true },
        { type: "extracted", stepId: "step-1", outputName: "savingsBalance", value: "1250.00" },
        { type: "checkpoint_passed", description: "Balance visible" },
        { type: "run_end", status: "success", stepsExecuted: 4, humanIntervened: false },
      ),
      false,
    );

    expect(state.status).toBe("succeeded");
    expect(state.escalated).toBe(false);
    expect(state.result).toEqual({
      status: "success",
      outputs: { savingsBalance: "1250.00" },
      checkpointsPassed: ["Balance visible"],
      stepsExecuted: 4,
    });
  });

  it("maps a business outcome to its own status, not to failed", () => {
    // The whole point of the three-way split: "member not found" is an answer,
    // not a breakage, and a dashboard that paints it red teaches the operator
    // to ignore red.
    const state = statusFromEvents(
      log(REPLAY_START, { type: "run_end", status: "business_outcome", code: "MEMBER_NOT_FOUND", outcomeId: "not-found" }),
      false,
    );

    expect(state.status).toBe("business_outcome");
    expect(state.result).toMatchObject({ status: "business_outcome", code: "MEMBER_NOT_FOUND", outcomeId: "not-found" });
  });

  it("maps a hard failure to failed and keeps the debuggable detail", () => {
    const state = statusFromEvents(
      log(
        REPLAY_START,
        { type: "checkpoint_failed", description: "Balance visible", observed: "no such element" },
        { type: "run_end", status: "hard_failure", stepId: "step-3", reason: "Checkpoint not met", humanIntervened: false },
      ),
      false,
    );

    expect(state.status).toBe("failed");
    expect(state.result).toMatchObject({
      status: "hard_failure",
      stepId: "step-3",
      reason: "Checkpoint not met",
      observed: "no such element",
    });
  });
});

describe("statusFromEvents: discovery outcomes", () => {
  it("keeps discovery's vocabulary while classifying in replay's", () => {
    const state = statusFromEvents(
      log(DISCOVERY_START, { type: "run_end", outcome: "max_steps", status: "hard_failure", stepCount: 20 }),
      false,
    );

    expect(state.status).toBe("failed");
    expect(state.discoveryOutcome).toBe("max_steps");
    // Discovery runs produce a recording, not a ReplayResult.
    expect(state.result).toBeUndefined();
  });

  it("treats a human-unblocked discovery run as a success", () => {
    const state = statusFromEvents(
      log(
        DISCOVERY_START,
        { type: "escalation_raised", kind: "discovery_stuck", reason: "stuck" },
        { type: "escalation_resolved", decision: "resumed", actionCount: 1 },
        { type: "run_end", outcome: "escalated_completed", status: "hard_failure", humanIntervened: true },
      ),
      false,
    );

    // Not succeeded: a human unblocking a stuck discovery records no steps, so
    // no artifact is built for this outcome. The intervention is still on the
    // run -- what happened is visible, it just was not a recording.
    expect(state.status).toBe("failed");
    expect(state.discoveryOutcome).toBe("escalated_completed");
    expect(state.escalated).toBe(true);
  });

  it("prefers run_end.status over run_end.outcome when the two disagree", () => {
    // Both fields exist so one reader can classify both kinds; `status` is the
    // shared vocabulary, so it wins rather than the reader guessing.
    const state = statusFromEvents(
      log(DISCOVERY_START, { type: "run_end", outcome: "success", status: "hard_failure" }),
      false,
    );

    expect(state.status).toBe("failed");
    expect(state.discoveryOutcome).toBe("success");
  });

  it("classifies a legacy discovery log that only has `outcome`", () => {
    const state = statusFromEvents(
      log({ type: "run_start", kind: "discovery", goal: "find the balance" }, { type: "run_end", outcome: "dead_end" }),
      false,
    );

    expect(state.status).toBe("failed");
  });
});

describe("statusFromEvents: liveness", () => {
  const unfinished = log(REPLAY_START, { type: "step_result", stepId: "step-1", ok: true });

  it("reads an unfinished log as running while the process is alive", () => {
    expect(statusFromEvents(unfinished, true).status).toBe("running");
  });

  it("reads the same bytes as crashed when nothing is driving them", () => {
    // The two cases are byte-identical on disk — a run_start with no run_end —
    // so the only thing separating them is the caller's knowledge that no
    // process owns this run. That is the entire crash derivation.
    expect(statusFromEvents(unfinished, false).status).toBe("crashed");
  });

  it("reports a pending escalation while live", () => {
    const events = log(
      REPLAY_START,
      { type: "escalation_raised", kind: "replay_hard_failure", reason: "element missing" },
      { type: "escalation_console_started", consoleUrl: "http://localhost:1234/" },
    );

    expect(statusFromEvents(events, true).status).toBe("escalation_pending");
    expect(statusFromEvents(events, true).escalated).toBe(true);
  });

  it("stops reporting a pending escalation once it resolves", () => {
    const events = log(
      REPLAY_START,
      { type: "escalation_raised", kind: "replay_hard_failure", reason: "element missing" },
      { type: "escalation_resolved", decision: "resumed", actionCount: 0 },
    );

    expect(statusFromEvents(events, true).status).toBe("running");
  });

  it("calls a dead run parked in an escalation crashed, not awaiting-operator", () => {
    // Nobody is listening for the operator's decision, so leaving it in the
    // queue would be a lie that never resolves.
    const events = log(REPLAY_START, { type: "escalation_raised", kind: "replay_hard_failure", reason: "x" });

    expect(statusFromEvents(events, false).status).toBe("crashed");
  });
});

describe("statusFromEvents: escalation and progress", () => {
  it("records a run that escalated and then succeeded as both", () => {
    const state = statusFromEvents(
      log(
        REPLAY_START,
        { type: "step_result", stepId: "step-1", ok: true },
        { type: "escalation_raised", kind: "replay_hard_failure", reason: "search box missing", screenshotPath: "/e/x.png" },
        { type: "human_action", actionType: "click", detail: 'click "#search"' },
        { type: "human_action", actionType: "resume", detail: "resume" },
        { type: "escalation_resolved", decision: "resumed", actionCount: 2 },
        { type: "step_result", stepId: "step-2", ok: true },
        { type: "run_end", status: "success", stepsExecuted: 2, humanIntervened: true },
      ),
      false,
    );

    // Collapsing these into one field would lose the more interesting half.
    expect(state.status).toBe("succeeded");
    expect(state.escalated).toBe(true);
    expect(state.humanIntervention).toMatchObject({
      kind: "replay_hard_failure",
      reason: "search box missing",
      decision: "resumed",
      screenshotPath: "/e/x.png",
    });
    expect(state.humanIntervention?.actions.map((a) => a.type)).toEqual(["click", "resume"]);
  });

  it("marks a finished run as escalated on humanIntervened alone", () => {
    // A run whose escalation lines were written by a separate operator-server
    // logger still reports the fact on run_end.
    const state = statusFromEvents(log(REPLAY_START, { type: "run_end", status: "success", humanIntervened: true }), false);
    expect(state.escalated).toBe(true);
  });

  it("counts only successful step_results and tracks the current step", () => {
    const state = statusFromEvents(
      log(
        REPLAY_START,
        { type: "step_result", stepId: "step-1", ok: true },
        { type: "step_result", stepId: "step-2", ok: false, error: "timeout" },
        { type: "step_retry", stepId: "step-2", reason: "recovery", recoveryRetries: 1 },
        { type: "step_result", stepId: "step-2", ok: true },
        { type: "checkpoint_passed", description: "not a step" },
      ),
      true,
    );

    expect(state.progress.stepsCompleted).toBe(2);
    expect(state.progress.currentStepId).toBe("step-2");
    // Not in the log at all; the registry fills it from the artifact.
    expect(state.progress.stepsTotal).toBeUndefined();
  });

  it("survives a log with nothing in it", () => {
    const state = statusFromEvents([], false);
    expect(state.status).toBe("crashed");
    expect(state.progress.stepsCompleted).toBe(0);
  });
});
