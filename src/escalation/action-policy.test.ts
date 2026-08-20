import { describe, expect, it } from "vitest";
import type { GuardrailsConfig } from "../guardrails/config.js";
import { checkHumanAction, type HumanActionPolicy } from "./action-policy.js";

/**
 * The two assertions that prove the wrapper is not a way around the
 * guardrails. Before this, POST /action called page.goto directly with no
 * policy check, so a paused run was a route to anywhere an authenticated
 * banking session could reach.
 */
const guardrails: GuardrailsConfig = {
  allowedOrigins: ["https://web-sample.interface-hiring.com"],
  allowedRoutePatterns: ["^/(signon|signoff|menu|members(/.*)?)$"],
  allowedActionTypes: ["navigate", "click", "fill", "select", "check", "waitFor", "extract"],
  irreversibleActionPolicy: "block",
};

const policy: HumanActionPolicy = { guardrails, app: "meridian-core", sensitiveValues: [] };
const at = (url: string) => ({ currentUrl: url });
const ON_MENU = at("https://web-sample.interface-hiring.com/menu");

describe("human action policy", () => {
  it("refuses navigation to /settings", () => {
    // The target's global fault-injection config. guardrails.json deliberately
    // leaves it off the allowlist; the console must not be a way in.
    const d = checkHumanAction({ type: "navigate", value: "/settings" }, ON_MENU, policy);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("route_not_allowed");
  });

  it("refuses navigation off-origin", () => {
    const d = checkHumanAction({ type: "navigate", value: "https://evil.example/" }, ON_MENU, policy);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("origin_not_allowed");
  });

  it("allows navigation within the allowlist", () => {
    expect(checkHumanAction({ type: "navigate", value: "/members/100234" }, ON_MENU, policy).allowed).toBe(true);
  });

  it("refuses a javascript: URL before it is ever parsed as one", () => {
    const d = checkHumanAction({ type: "navigate", value: "javascript:alert(1)" }, ON_MENU, policy);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("unsafe_scheme");
  });

  it("refuses an action kind outside the console's vocabulary", () => {
    // No evaluate, no press, no route. Adding one is a policy change, and it
    // should look like one.
    const d = checkHumanAction({ type: "evaluate", target: "x" }, ON_MENU, policy);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("action_kind_not_allowed");
  });

  it("allows an ordinary click on an allowlisted page", () => {
    expect(checkHumanAction({ type: "click", target: "#continueBtn" }, ON_MENU, policy).allowed).toBe(true);
  });

  it("is read-only when the page itself is already off-allowlist", () => {
    const d = checkHumanAction({ type: "click", target: "#x" }, at("https://evil.example/x"), policy);
    expect(d.allowed).toBe(false);
  });

  it("requires a target for element actions", () => {
    expect(checkHumanAction({ type: "fill", value: "x" }, ON_MENU, policy).allowed).toBe(false);
  });
});
