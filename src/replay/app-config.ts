import type { Page } from "playwright";
import type { Target } from "../artifact/schema.js";
import { performLogin } from "../shared/login.js";
import { credentialsForRole, type SessionRole } from "../shared/credentials.js";

/**
 * App-level recovery actions, keyed by target.app then by the action name a
 * knownOutcome's `recovery.action` field references. This is the other half
 * of the artifact/engine split explained in docs/artifact-schema.md: the
 * artifact declares *where in the flow* to look for a recoverable condition
 * (capability-specific), this registry owns *how to fix it* (app-generic,
 * implemented once, reused by every capability against this app).
 *
 * Each action reports how much of the flow needs to re-run after it —
 * reauth invalidates page state built up by prior steps (a fresh login
 * lands on a blank /members page), so the only sound recovery is restarting
 * the whole step sequence; dismissAndRetry/reloadAndRetry are narrower and
 * only need the one step that hit the condition retried.
 */
export type RecoveryScope = "restart_flow" | "retry_step";

export interface RecoveryContext {
  page: Page;
  target: Target;
  /** The role this run authenticated as, so recovery restores it rather than escalating it. */
  sessionRole: SessionRole;
}

export interface RecoveryActionImpl {
  scope: RecoveryScope;
  run: (ctx: RecoveryContext) => Promise<void>;
}

const LEGACY_CORE_BANKING_ACTIONS: Record<string, RecoveryActionImpl> = {
  reauth: {
    scope: "restart_flow",
    run: async (ctx) => {
      // The run's own role, not a hardcoded teller. Re-authenticating with
      // more privilege than the run started with turns a permission-denied
      // business outcome into a silently-succeeding wrong answer.
      await performLogin(ctx.page, ctx.target.baseUrl, credentialsForRole(ctx.sessionRole));
    },
  },
  dismissAndRetry: {
    scope: "retry_step",
    run: async (ctx) => {
      // Generic dismiss: press Escape, which closes any focused native or
      // in-page modal without needing to know its specific markup.
      await ctx.page.keyboard.press("Escape").catch(() => undefined);
    },
  },
  reloadAndRetry: {
    scope: "retry_step",
    run: async (ctx) => {
      await ctx.page.reload();
    },
  },
};

const APP_RECOVERY_REGISTRY: Record<string, Record<string, RecoveryActionImpl>> = {
  "legacy-core-banking": LEGACY_CORE_BANKING_ACTIONS,
};

export function getRecoveryAction(app: string, actionName: string): RecoveryActionImpl {
  const action = APP_RECOVERY_REGISTRY[app]?.[actionName];
  if (!action) {
    throw new Error(`No recovery action "${actionName}" registered for app "${app}".`);
  }
  return action;
}
