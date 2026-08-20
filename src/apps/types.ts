import type { Page } from "playwright";
import type { Target } from "../artifact/schema.js";

/**
 * Everything that is true about one target application rather than about the
 * engine driving it.
 *
 * The take-home had exactly one target, so these facts were spread across five
 * files as literals: a `target()` factory in the discovery presets, a hardcoded
 * `performLogin`, a two-member `SessionRole` union, a recovery registry keyed
 * by app id, and the app's name inside the discovery system prompt. Pointing
 * the core at a second application is the test of whether that was
 * configuration or coupling — this module is where the answer lives.
 *
 * Guardrail policy deliberately does NOT live here. It stays in
 * `config/guardrails.json`, keyed by app id, because "operator-editable without
 * a code change" is a property the original design argued for and adding a
 * second app is not a reason to give it up.
 */

export interface Credentials {
  username: string;
  password: string;
  /**
   * Fields beyond username/password that a particular sign-on form needs —
   * MERIDIAN CORE has a branch selector. Kept open rather than adding a
   * `branch?` to every app's credentials, since the next app's third field
   * won't be a branch.
   */
  extra?: Record<string, string>;
}

export type RecoveryScope = "restart_flow" | "retry_step";

export interface RecoveryContext {
  page: Page;
  target: Target;
  /** The role this run authenticated as, so recovery restores it rather than escalating it. */
  sessionRole: string;
  /**
   * Which attempt at recovering *this* outcome this is, 1-based. Supplied by
   * the engine, which already counts them, so an action that backs off does not
   * need module-level state of its own — that would be shared across concurrent
   * runs, which is precisely the bug this project has already fixed once.
   */
  attempt: number;
}

export interface RecoveryActionImpl {
  scope: RecoveryScope;
  run: (ctx: RecoveryContext) => Promise<void>;
}

export interface AppAdapter {
  /** Matches `artifact.target.app`; the key everything else is looked up by. */
  id: string;
  /** Shown to the operator, and injected into the discovery system prompt. */
  displayName: string;
  /** Built from the environment so a deployment can be repointed without a code change. */
  target: (env: NodeJS.ProcessEnv) => Target;
  /**
   * Role name -> credentials. A plain record rather than a union because role
   * vocabularies are per-app: this target has teller/supervisor, the mock app
   * has teller/readonly, and the next one will have something else.
   */
  roles: Record<string, Credentials>;
  /**
   * The one piece of this that genuinely needed code rather than configuration.
   * Sign-on forms differ in route, field names, control types and success
   * condition; parameterizing those into strings would be inventing a small
   * DSL to express what a four-line function already says clearly.
   *
   * Runs via direct Playwright calls before the discovery loop starts, which is
   * what keeps credentials structurally out of both the model's context and any
   * recorded artifact — for every app, not just the original one.
   */
  login: (page: Page, target: Target, credentials: Credentials) => Promise<void>;
  /**
   * Whether the session has been lost. Used before resuming a run that paused
   * for a human, since this target expires sessions on idle and an approval
   * takes minutes.
   */
  isLoggedOut: (page: Page) => Promise<boolean>;
  /** App-level "how to fix it" implementations, referenced by name from an artifact's knownOutcomes. */
  recoveryActions: Record<string, RecoveryActionImpl>;
  /**
   * How the model should locate elements on *this* surface, injected into the
   * discovery system prompt.
   *
   * This exists because the right answer is not universal, which was invisible
   * while there was one target. An app with a real accessibility tree should be
   * located by role and label. An app with no labels, roles, ids or test ids at
   * all — which is what MERIDIAN CORE is — has to be located by `name`
   * attribute, and pretending otherwise produces either ambiguous locators or
   * positional ones. Both are worse than the honest answer.
   */
  locatorGuidance: string;
}
