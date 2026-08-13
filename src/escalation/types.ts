/**
 * The escalation seam: pause automation, cede control of the *same* live
 * session to a human, capture what they did, then resume or abort. Built
 * once and reused from three trigger points (discovery stuck, replay hard
 * failure, a guardrail-blocked irreversible step needing a human decision)
 * rather than three separate ad hoc mechanisms — see REPORT.md §5 for why
 * that reuse matters for the "who is in control" question the brief asks
 * about: there is exactly one place control transfer happens, so there's
 * exactly one place to answer that question correctly.
 */

export type InterventionKind = "discovery_stuck" | "replay_hard_failure" | "irreversible_confirmation";

export interface InterventionContext {
  runId: string;
  capabilityId: string;
  kind: InterventionKind;
  /** Why automation stopped — shown verbatim to the operator. */
  reason: string;
  currentUrl: string;
  currentStepId?: string;
  currentStepDescription?: string;
  /** Discovery only. */
  goal?: string;
  /** irreversible_confirmation only: what approving would actually do. */
  pendingAction?: { description: string; locatorSummary: string };
}

export interface HumanAction {
  timestamp: string;
  type: "click" | "fill" | "select" | "navigate" | "approve_step" | "reject" | "resume" | "abort";
  detail: string;
}

export type EscalationOutcome =
  | { decision: "resumed"; actions: HumanAction[] }
  | { decision: "aborted"; actions: HumanAction[] };

export interface HumanIntervention {
  raisedAt: string;
  resolvedAt: string;
  kind: InterventionKind;
  reason: string;
  decision: "resumed" | "aborted";
  actions: HumanAction[];
  screenshotPath?: string;
}

/**
 * The extension point discovery and replay both accept: raise an
 * intervention for the given context and don't return until a human (or,
 * in this project's tests, a script driving the same HTTP surface a human
 * would) resolves it. Implemented by src/escalation/operator-server.ts;
 * kept as an interface here so the engine and loop modules depend on the
 * *shape* of escalation, not its concrete transport.
 *
 * `executeApprovedStep` is set only for `irreversible_confirmation`: the
 * one action the operator console can trigger that isn't a free-form
 * manual command, because it must run through the exact same recorded
 * locator/value resolution the artifact declares, not a hand-typed CSS
 * selector — approving *is* executing the real step, not narrating it.
 */
export type EscalationHandler = (
  ctx: InterventionContext,
  executeApprovedStep?: () => Promise<void>,
) => Promise<EscalationOutcome>;
