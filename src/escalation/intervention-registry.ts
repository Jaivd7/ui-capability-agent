import type { Page } from "playwright";
import type { RunLogger } from "../logging/logger.js";
import type { HumanActionPolicy } from "./action-policy.js";
import type { EscalationOutcome, HumanAction, InterventionContext } from "./types.js";

/**
 * The interventions currently waiting on a human, keyed by run.
 *
 * The old console created a fresh Express app on an ephemeral port per
 * intervention, and registered its mutation routes *inside* the `listen`
 * callback so they could close over the promise's `resolve`. The coupling to
 * break was never the promise — it was that the route table and the run state
 * shared a lexical scope, which is what made one server per run necessary.
 *
 * Moving the resolver into a registry entry keeps the property that matters:
 * `raiseIntervention` still returns a promise that does not settle until a
 * human sends a terminal signal, so the calling engine stays suspended
 * mid-flow with its page and its session exactly as it left them. Only the
 * transport changed.
 */
export interface PendingIntervention {
  runId: string;
  /**
   * Unique per intervention, not per run.
   *
   * A single replay can escalate twice — an irreversible confirmation, then a
   * hard failure later in the same flow — and the registry is keyed by run, so
   * both consoles live at the same URL. The first console's tab is still open
   * and still has a Resume button; without an identity to check, submitting it
   * resolved whichever intervention happened to be pending, which by then was a
   * different one asking a different question.
   */
  interventionId: string;
  context: InterventionContext;
  raisedAt: string;
  page: Page;
  logger: RunLogger;
  actions: HumanAction[];
  /** Values the operator read off the page, merged into the run's outputs on resume. */
  captured: Record<string, string | number>;
  screenshotPath: string;
  policy: HumanActionPolicy;
  /** irreversible_confirmation only: runs the real pending step on approval. */
  executeApprovedStep?: (() => Promise<void>) | undefined;
  /** Ran before a resume/approve, so a session that died while waiting is caught. */
  preResumeCheck?: ((p: PendingIntervention) => Promise<string | null>) | undefined;
  record(action: HumanAction): void;
  /** Records a value read off the live page against one of the capability's declared outputs. */
  capture(name: string, value: string | number): void;
  resolve(decision: "resumed" | "aborted"): void;
}

export interface InterventionRegistry {
  register(
    pending: Omit<PendingIntervention, "record" | "resolve" | "capture" | "interventionId" | "captured">,
    settle: (outcome: EscalationOutcome) => void,
  ): PendingIntervention;
  get(runId: string): PendingIntervention | undefined;
  list(): PendingIntervention[];
  /** Resolves every waiting intervention as aborted. Used by graceful shutdown. */
  abortAll(reason: string): void;
}

export function createInterventionRegistry(): InterventionRegistry {
  const pending = new Map<string, PendingIntervention>();
  let counter = 0;

  return {
    register(base, settle) {
      counter += 1;
      const entry: PendingIntervention = {
        ...base,
        interventionId: `${base.runId}#${counter}`,
        captured: {},
        record(action) {
          entry.actions.push(action);
          entry.logger.log({
            type: "human_action",
            runId: entry.runId,
            actionType: action.type,
            detail: action.detail,
            ...(action.blocked ? { blocked: true, blockReason: action.blockReason } : {}),
            ...(action.irreversibleTarget ? { irreversibleTarget: true } : {}),
          });
        },
        capture(name, value) {
          entry.captured[name] = value;
        },
        resolve(decision) {
          // Identity, not presence: `pending.has(runId)` was true again as soon
          // as a *second* intervention registered for the same run, so a stale
          // submission from the first console resolved the second one.
          if (pending.get(entry.runId)?.interventionId !== entry.interventionId) return;
          pending.delete(entry.runId);
          entry.logger.log({
            type: "escalation_resolved",
            runId: entry.runId,
            decision,
            actionCount: entry.actions.length,
          });
          settle({
            decision,
            actions: entry.actions,
            ...(Object.keys(entry.captured).length > 0 ? { capturedOutputs: { ...entry.captured } } : {}),
          });
        },
      };
      pending.set(entry.runId, entry);
      return entry;
    },

    get: (runId) => pending.get(runId),
    list: () => [...pending.values()],

    abortAll(reason) {
      for (const entry of [...pending.values()]) {
        entry.record({
          timestamp: new Date().toISOString(),
          type: "abort",
          detail: reason,
        });
        // Resolving rather than dropping is the point: the suspended engine
        // unwinds through its ordinary abort path and writes a real terminal
        // record saying why, instead of simply stopping and later being
        // classified as a crash.
        entry.resolve("aborted");
      }
    },
  };
}
