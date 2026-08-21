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
  /**
   * replay_hard_failure only: declared outputs this run has not captured.
   *
   * Handing back re-checks the capability's contract, and that contract
   * includes its outputs — so a console that cannot supply a missing one can
   * only ever hand back into the same failure. This is what the console offers
   * to read off the page.
   */
  missingOutputs?: Array<{ name: string; type: string; sensitive: boolean; description?: string }>;
}

export interface HumanAction {
  timestamp: string;
  type: "click" | "fill" | "select" | "navigate" | "extract" | "approve_step" | "reject" | "resume" | "abort";
  /** Human-readable, and already redacted — see action-policy.ts. */
  detail: string;
  /** The selector or path acted on, when there was one. */
  target?: string;
  /** Only carried for actions whose value is not sensitive by nature (select, navigate). */
  value?: string;
  /** True when the policy refused this action, or walked the page back after it. */
  blocked?: boolean;
  blockReason?: string;
  /** True when the target matches a step the artifact marks irreversible. Recorded, not prevented. */
  irreversibleTarget?: boolean;
}

export type EscalationOutcome =
  | { decision: "resumed"; actions: HumanAction[]; capturedOutputs?: Record<string, string | number> }
  | { decision: "aborted"; actions: HumanAction[]; capturedOutputs?: Record<string, string | number> };

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
