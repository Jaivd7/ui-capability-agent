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
  context: InterventionContext;
  raisedAt: string;
  page: Page;
  logger: RunLogger;
  actions: HumanAction[];
  screenshotPath: string;
  policy: HumanActionPolicy;
  /** irreversible_confirmation only: runs the real pending step on approval. */
  executeApprovedStep?: (() => Promise<void>) | undefined;
  /** Ran before a resume/approve, so a session that died while waiting is caught. */
  preResumeCheck?: ((p: PendingIntervention) => Promise<string | null>) | undefined;
  record(action: HumanAction): void;
  resolve(decision: "resumed" | "aborted"): void;
}

export interface InterventionRegistry {
  register(
    pending: Omit<PendingIntervention, "record" | "resolve">,
    settle: (outcome: EscalationOutcome) => void,
  ): PendingIntervention;
  get(runId: string): PendingIntervention | undefined;
  list(): PendingIntervention[];
  /** Resolves every waiting intervention as aborted. Used by graceful shutdown. */
  abortAll(reason: string): void;
}

export function createInterventionRegistry(): InterventionRegistry {
  const pending = new Map<string, PendingIntervention>();

  return {
    register(base, settle) {
      const entry: PendingIntervention = {
        ...base,
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
        resolve(decision) {
          if (!pending.has(entry.runId)) return; // already settled; a stale tab double-submitted
          pending.delete(entry.runId);
          entry.logger.log({
            type: "escalation_resolved",
            runId: entry.runId,
            decision,
            actionCount: entry.actions.length,
          });
          settle({ decision, actions: entry.actions });
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
