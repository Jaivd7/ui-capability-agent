import type { GuardrailsConfig } from "./config.js";

export interface GuardrailDecision {
  allowed: boolean;
  reason?: string;
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
}

function checkActionType(step: StepLike, config: GuardrailsConfig): GuardrailDecision {
  if (!config.allowedActionTypes.includes(step.type)) {
    return { allowed: false, reason: `Action type "${step.type}" is not in the allowed action types.` };
  }
  return { allowed: true };
}

/**
 * The irreversible check is the only one that fires almost exclusively at
 * replay time in practice: discovery never marks a recorded step
 * irreversible on its own (see LEARNING_NOTES.md's Phase 2 entry — that's a
 * deliberate choice, not an oversight), so this is really a check against
 * whatever a human reviewer marked true when approving an artifact for
 * unattended replay. That's the realistic trigger this guardrail defends
 * against: a reviewer (or a bad edit) flags a step irreversible, and the
 * system must refuse to execute it unattended regardless.
 */
function checkIrreversible(step: StepLike, config: GuardrailsConfig): GuardrailDecision {
  if (step.irreversible && config.irreversibleActionPolicy === "block") {
    return {
      allowed: false,
      reason: "Step is marked irreversible; current policy blocks irreversible actions from unattended execution.",
    };
  }
  return { allowed: true };
}

function checkUrl(url: string, config: GuardrailsConfig): GuardrailDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `Malformed URL: "${url}".` };
  }
  if (!config.allowedOrigins.includes(parsed.origin)) {
    return { allowed: false, reason: `Origin "${parsed.origin}" is not in the allowed origins.` };
  }
  const routeOk = config.allowedRoutePatterns.some((pattern) => new RegExp(pattern).test(parsed.pathname));
  if (!routeOk) {
    return { allowed: false, reason: `Route "${parsed.pathname}" does not match any allowed route pattern.` };
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

  const irreversibleCheck = checkIrreversible(step, config);
  if (!irreversibleCheck.allowed) return irreversibleCheck;

  const currentUrlCheck = checkUrl(ctx.currentUrl, config);
  if (!currentUrlCheck.allowed) return currentUrlCheck;

  if (ctx.targetUrl) {
    const targetUrlCheck = checkUrl(ctx.targetUrl, config);
    if (!targetUrlCheck.allowed) return targetUrlCheck;
  }

  return { allowed: true };
}
