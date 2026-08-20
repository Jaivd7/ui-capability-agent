import type { GuardrailsConfig } from "./config.js";

export type GuardrailViolationCode =
  | "action_type_not_allowed"
  | "irreversible_blocked"
  | "origin_not_allowed"
  | "route_not_allowed";

export interface GuardrailDecision {
  allowed: boolean;
  reason?: string;
  /**
   * Present only when `allowed` is false. Lets a caller distinguish an
   * allowlist violation (a hard boundary — see engine.ts's escalation
   * wiring, which never offers human confirmation for these) from
   * `irreversible_blocked` (the one violation kind that has a legitimate
   * human-confirmation path, because that's specifically what the
   * reversible/irreversible classification exists to gate).
   */
  code?: GuardrailViolationCode;
}

/**
 * The minimal shape the policy actually reads — deliberately narrower than
 * the full artifact `Step` union so this module doesn't depend on it. A
 * real artifact Step satisfies this structurally, so replay can pass one
 * directly; discovery, which only knows a proposed action's tool name and
 * hasn't assembled a full Step yet, can pass a trivial literal instead of
 * needing to fake the rest of the shape just to run this check.
 */
export interface StepLike {
  type: string;
  irreversible?: boolean;
}

/** Context the guardrail check needs beyond the step itself — computed once per step by the caller. */
export interface GuardrailContext {
  /** Where the page currently is, before this step executes. */
  currentUrl: string;
  /** For navigate steps only: where this step is about to send the page. */
  targetUrl?: string;
  /**
   * The monetary value at stake in this invocation, if any, used to decide
   * whether an irreversible step is small enough to run unattended.
   *
   * Derived by the caller from the capability's own declared param types
   * rather than from a field the artifact adds. An artifact naming which of
   * its params is "the risky one" would be an artifact influencing the policy
   * applied to it, which is the pattern docs/artifact-schema.md already argues
   * against. `type: "currency"` is a fact the call contract already states for
   * its own reasons, and reading it here borrows nothing new.
   */
  amount?: number;
}

function checkActionType(step: StepLike, config: GuardrailsConfig): GuardrailDecision {
  if (!config.allowedActionTypes.includes(step.type)) {
    return {
      allowed: false,
      code: "action_type_not_allowed",
      reason: `Action type "${step.type}" is not in the allowed action types.`,
    };
  }
  return { allowed: true };
}

/**
 * Risk-based approval for an irreversible step.
 *
 * Blocking every irreversible action unconditionally is the safest rule and
 * also an unusable one: it means a human clicks Approve for a $5 transfer and
 * a $50,000 transfer identically, which trains them to click Approve. A
 * threshold puts the human where the risk is.
 *
 * **Fail closed is the load-bearing part.** No threshold configured, no amount
 * resolvable, an amount that isn't finite — every one of those blocks. The
 * only path to "allowed" is a threshold that exists and an amount that is
 * demonstrably below it. Getting the derivation wrong therefore makes the
 * system stricter, never looser, which is the only direction a safety check is
 * allowed to be wrong in.
 *
 * A capability with no monetary parameter at all — Place Account Hold, say —
 * consequently always escalates. That falls out of the rule rather than being
 * a special case for it, which is the right shape: the riskiest action in the
 * set gets the strictest treatment without anyone having to remember to say so.
 */
function checkIrreversible(step: StepLike, config: GuardrailsConfig, ctx: GuardrailContext): GuardrailDecision {
  if (!step.irreversible || config.irreversibleActionPolicy !== "block") {
    return { allowed: true };
  }

  const threshold = config.irreversibleAmountThreshold;
  if (threshold !== undefined && ctx.amount !== undefined && Number.isFinite(ctx.amount) && ctx.amount < threshold) {
    return { allowed: true };
  }

  const reason =
    threshold === undefined
      ? "Step is marked irreversible; current policy blocks irreversible actions from unattended execution."
      : ctx.amount === undefined
        ? `Step is marked irreversible and no monetary amount could be resolved for it, so it is treated as above the ${threshold} approval threshold.`
        : `Step is marked irreversible and its amount (${ctx.amount}) is at or above the ${threshold} approval threshold.`;
  return { allowed: false, code: "irreversible_blocked", reason };
}

function checkUrl(url: string, config: GuardrailsConfig): GuardrailDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, code: "origin_not_allowed", reason: `Malformed URL: "${url}".` };
  }
  if (!config.allowedOrigins.includes(parsed.origin)) {
    return {
      allowed: false,
      code: "origin_not_allowed",
      reason: `Origin "${parsed.origin}" is not in the allowed origins.`,
    };
  }
  const routeOk = config.allowedRoutePatterns.some((pattern) => new RegExp(pattern).test(parsed.pathname));
  if (!routeOk) {
    return {
      allowed: false,
      code: "route_not_allowed",
      reason: `Route "${parsed.pathname}" does not match any allowed route pattern.`,
    };
  }
  return { allowed: true };
}

/**
 * The single policy entry point, called identically by the discovery loop
 * (before the model's proposed action executes) and the replay engine
 * (before a recorded step executes) — see the GuardrailHook wiring in each.
 * Same policy, same enforcement point shape, whichever path is driving.
 */
export function evaluateGuardrails(step: StepLike, ctx: GuardrailContext, config: GuardrailsConfig): GuardrailDecision {
  const actionCheck = checkActionType(step, config);
  if (!actionCheck.allowed) return actionCheck;

  const irreversibleCheck = checkIrreversible(step, config, ctx);
  if (!irreversibleCheck.allowed) return irreversibleCheck;

  const currentUrlCheck = checkUrl(ctx.currentUrl, config);
  if (!currentUrlCheck.allowed) return currentUrlCheck;

  if (ctx.targetUrl) {
    const targetUrlCheck = checkUrl(ctx.targetUrl, config);
    if (!targetUrlCheck.allowed) return targetUrlCheck;
  }

  return { allowed: true };
}
