import { getAppAdapter, type RecoveryActionImpl } from "../apps/index.js";

export type { RecoveryActionImpl, RecoveryContext, RecoveryScope } from "../apps/index.js";

/**
 * Looks up an app-level recovery action by the name an artifact's
 * `knownOutcomes` references.
 *
 * This is the other half of the artifact/engine split documented in
 * docs/artifact-schema.md: the artifact declares *where in this flow* to look
 * for a recoverable condition (capability-specific), and the app adapter owns
 * *how to fix it* (app-generic, implemented once, reused by every capability
 * against that app).
 *
 * The registry used to live here as an object literal keyed by app id. It
 * moved to src/apps/ when a second target arrived, along with the other four
 * things that turned out to be per-app rather than universal — this file is
 * now just the lookup the replay engine calls.
 */
export function getRecoveryAction(app: string, actionName: string): RecoveryActionImpl {
  const action = getAppAdapter(app).recoveryActions[actionName];
  if (!action) {
    throw new Error(`No recovery action "${actionName}" registered for app "${app}".`);
  }
  return action;
}
