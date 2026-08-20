import type { Page } from "playwright";
import type { CapabilityArtifact, FrameLocator } from "../artifact/schema.js";
import { resolveFrameRoot } from "../shared/locator.js";
import type { GuardrailsConfig } from "../guardrails/config.js";
import { evaluateGuardrails } from "../guardrails/policy.js";
import { redactValue } from "../guardrails/redact.js";
import type { HumanAction } from "./types.js";

/**
 * What a human is allowed to do to a live session through the operator
 * console.
 *
 * The console used to do none of this. `POST /action` called `page.goto`,
 * `page.click`, `page.fill` and `page.selectOption` directly, with no policy
 * check anywhere — so a paused run was a way to drive an authenticated banking
 * session anywhere at all, including to the target's own global
 * fault-injection settings, which `config/guardrails.json` explicitly refuses
 * to allowlist. The brief is direct about this: "Don't let the wrapper become
 * a way around the guardrails."
 *
 * Neither extreme is the fix. Applying the identical policy makes the console
 * useless — it could only re-run recorded steps, and the reason a run paused is
 * that the recorded steps didn't work. Trusting the human is the status quo.
 * The line drawn here:
 *
 *   **Origin and route are properties of the session, not of who is driving
 *   it.** The context holds a real authenticated operator session against a
 *   real financial system, and "this session may only touch these routes on
 *   this origin" is the containment claim the whole system makes. A human
 *   clicking buttons does not change what that session is.
 *
 *   **Action type and irreversibility are properties of unattendedness** — and
 *   attendance is precisely what an escalation restores. So the vocabulary is
 *   narrowed rather than the allowlist, and an irreversible action is recorded
 *   rather than prevented.
 */

export type HumanActionKind = "click" | "fill" | "select" | "navigate";

/**
 * Deliberately narrower than `config.allowedActionTypes`. There is no
 * `evaluate`, no `press`, no `route`, no `addScriptTag` — and there should not
 * be. Adding one later is a policy change, and keeping the list here makes it
 * a visible one rather than a convenience someone slips into a route handler.
 */
const CONSOLE_VOCABULARY: readonly HumanActionKind[] = ["click", "fill", "select", "navigate"];

export interface HumanActionPolicy {
  guardrails: GuardrailsConfig;
  app: string;
  /** The artifact being replayed, when there is one — used to notice an irreversible target. */
  artifact?: CapabilityArtifact | undefined;
  /** This run's sensitive values, so an operator retyping one doesn't put it in the log. */
  sensitiveValues: readonly (string | number)[];
}

export interface HumanActionRequest {
  type?: string;
  target?: string;
  value?: string;
  /**
   * Which document the target lives in, empty or absent for the main one.
   *
   * Comes from the console's picker, which enumerates iframes as well as the
   * top document — a legacy frameset is one of the surfaces this project
   * exists for, and a console that could only reach the outer document would
   * be unable to fix exactly those pages.
   */
  frame?: FrameLocator[];
}

export type HumanActionDecision =
  | { allowed: true; kind: HumanActionKind }
  | { allowed: false; code: string; reason: string };

/** Checked *before* the action runs. A rejection is a 403 and a logged, visible refusal. */
export function checkHumanAction(
  req: HumanActionRequest,
  ctx: { currentUrl: string },
  policy: HumanActionPolicy,
): HumanActionDecision {
  const kind = req.type as HumanActionKind | undefined;
  if (!kind || !CONSOLE_VOCABULARY.includes(kind)) {
    return {
      allowed: false,
      code: "action_kind_not_allowed",
      reason: `"${String(req.type)}" is not an action this console performs.`,
    };
  }
  if (!policy.guardrails.allowedActionTypes.includes(kind)) {
    return {
      allowed: false,
      code: "action_type_not_allowed",
      reason: `Action type "${kind}" is not permitted for this app.`,
    };
  }

  if (kind === "navigate") {
    const raw = (req.value ?? "").trim();
    if (!raw) return { allowed: false, code: "missing_value", reason: "A path or URL is required." };
    // Checked before parsing: `javascript:` and `data:` interact badly with an
    // origin comparison, since they have no meaningful origin to compare.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) {
      return { allowed: false, code: "unsafe_scheme", reason: "Only http and https URLs are permitted." };
    }
    let target: string;
    try {
      target = new URL(raw, ctx.currentUrl).toString();
    } catch {
      return { allowed: false, code: "invalid_url", reason: `"${raw}" is not a usable URL.` };
    }
    // The identical check a recorded navigate step gets. No override exists,
    // because the containment claim is about the session.
    const decision = evaluateGuardrails({ type: "navigate" }, { currentUrl: ctx.currentUrl, targetUrl: target }, policy.guardrails);
    if (!decision.allowed) {
      return {
        allowed: false,
        code: decision.code ?? "not_allowed",
        reason: decision.reason ?? "Navigation is outside this app's allowlist.",
      };
    }
    return { allowed: true, kind };
  }

  if (!req.target) {
    return { allowed: false, code: "missing_target", reason: "A CSS selector is required." };
  }
  // Where the page already is still has to be in scope: if a run somehow
  // paused off-allowlist, the console is read-only until it comes back.
  const here = evaluateGuardrails({ type: kind }, { currentUrl: ctx.currentUrl }, policy.guardrails);
  if (!here.allowed) {
    return {
      allowed: false,
      code: here.code ?? "not_allowed",
      reason: here.reason ?? "The page is currently outside this app's allowlist.",
    };
  }
  return { allowed: true, kind };
}

export interface PerformedAction {
  action: HumanAction;
  /** Set when the action left the allowlist and the page was walked back. */
  escaped?: string;
}

/**
 * Runs a permitted action, then re-checks where it left the page.
 *
 * The post-check exists because a click can *cause* navigation: an allowlist
 * enforced only on explicit navigates is one link away from being decorative.
 */
export async function performHumanAction(
  page: Page,
  req: HumanActionRequest,
  kind: HumanActionKind,
  policy: HumanActionPolicy,
): Promise<PerformedAction> {
  const target = req.target ?? "";
  const value = req.value ?? "";
  // Page-level for the main document, frame-scoped otherwise. CSS cannot cross
  // a frame boundary, so this is the only way a target inside one is reachable.
  const root = resolveFrameRoot(page, req.frame ?? []);
  const locator = root.locator(target);

  if (kind !== "navigate") {
    // Mirrors resolveLocator's requireUnique. `page.click` silently takes the
    // first of several matches, which is the exact behaviour that produced a
    // wrong balance earlier in this project; an operator deserves the same
    // protection a recorded step gets.
    const count = await locator.count();
    if (count > 1) {
      throw new HumanActionError(
        "selector_ambiguous",
        `"${target}" matches ${count} elements. Narrow it — the console will not guess which one you meant.`,
      );
    }
    if (count === 0) {
      throw new HumanActionError("selector_not_found", `"${target}" matches nothing on this page.`);
    }
  }

  switch (kind) {
    case "click":
      await locator.click({ timeout: 5000 });
      break;
    case "fill":
      await locator.fill(value, { timeout: 5000 });
      break;
    case "select":
      await locator.selectOption(value, { timeout: 5000 });
      break;
    case "navigate":
      await page.goto(new URL(value, page.url()).toString(), { timeout: 10_000 });
      break;
  }

  let escaped: string | undefined;
  const after = evaluateGuardrails({ type: "navigate" }, { currentUrl: page.url(), targetUrl: page.url() }, policy.guardrails);
  if (!after.allowed) {
    escaped = page.url();
    await page.goBack({ timeout: 10_000 }).catch(() => undefined);
  }

  const action: HumanAction = {
    timestamp: new Date().toISOString(),
    type: kind,
    detail: describeAction(kind, target, value, policy),
    ...(target ? { target } : {}),
    ...(kind === "navigate" || kind === "select" ? { value } : {}),
    ...(escaped !== undefined ? { blocked: true, blockReason: `left the allowlist (${escaped}); page was walked back` } : {}),
  };
  return { action, ...(escaped !== undefined ? { escaped } : {}) };
}

export class HumanActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HumanActionError";
  }
}

/**
 * Whether a manual action targets something the artifact marks irreversible.
 *
 * Detected and recorded, deliberately not prevented. A human could hand-type a
 * click on a Post button during a hard-failure intervention; blocking it would
 * be theatre, since they could do the same thing in their own browser, and it
 * is sometimes the correct recovery. Visibility is the right control, and
 * saying so is part of the answer.
 */
export function targetsIrreversibleStep(target: string, artifact?: CapabilityArtifact): boolean {
  if (!artifact || !target) return false;
  const needle = target.toLowerCase();
  return artifact.steps.some((step) => {
    if (!step.irreversible || !("locator" in step)) return false;
    return step.locator.some((c) => {
      const text =
        c.strategy === "role" ? c.name
        : c.strategy === "css" ? c.selector
        : c.strategy === "xpath" ? c.expression
        : "text" in c ? c.text
        : "";
      return Boolean(text) && (needle.includes(text!.toLowerCase()) || text!.toLowerCase().includes(needle));
    });
  });
}

/**
 * The human-readable line that lands in the run log and in `result.json`.
 *
 * A typed value is always masked. The console cannot know a field is sensitive
 * the way `inputParams[].sensitive` does, and a debugger needs to know *which*
 * field received *roughly what shape* of value far more often than they need
 * the string itself — which, on this kind of system, is a member's PII more
 * often than not.
 */
function describeAction(kind: HumanActionKind, target: string, value: string, policy: HumanActionPolicy): string {
  switch (kind) {
    case "click":
      return `click "${target}"`;
    case "navigate":
      return `navigate to "${value}"`;
    case "select":
      // Option values come from a fixed list the page itself offered.
      return `select "${target}" = "${value}"`;
    case "fill": {
      const known = policy.sensitiveValues.some((v) => String(v) === value);
      const shown = known || isProbablyPassword(target) ? "[REDACTED]" : String(redactValue(value, true));
      return `fill "${target}" = ${shown}`;
    }
  }
}

function isProbablyPassword(target: string): boolean {
  return /password|passwd|pwd/i.test(target) || /type=['"]?password/i.test(target);
}

export { CONSOLE_VOCABULARY };
