import { describe, expect, it } from "vitest";
import type { GuardrailsConfig } from "../guardrails/config.js";
import { performHumanAction, type HumanActionPolicy } from "./action-policy.js";

/**
 * The post-action check exists because a click can *cause* navigation, so an
 * allowlist enforced only on explicit navigates is one link away from being
 * decorative. It asks one question — is the page still somewhere we may be —
 * and it must not also re-ask whether the action type is permitted.
 */
const ORIGIN = "https://web-sample.interface-hiring.com";

/** Note: no "navigate" in allowedActionTypes. That is the whole point. */
const clickOnlyApp: GuardrailsConfig = {
  allowedOrigins: [ORIGIN],
  allowedRoutePatterns: ["^/(menu|members(/.*)?)$"],
  allowedActionTypes: ["click", "fill", "select"],
  irreversibleActionPolicy: "block",
};

function pageStub(urls: string[]) {
  let i = 0;
  return {
    url: () => urls[Math.min(i, urls.length - 1)]!,
    locator: () => ({ count: async () => 1, click: async () => { i = 1; } }),
    goBack: async () => { i = 0; return null; },
  } as never;
}

const policy = (guardrails: GuardrailsConfig): HumanActionPolicy => ({
  guardrails,
  app: "meridian-core",
  sensitiveValues: [],
});

describe("post-action allowlist check", () => {
  it("does not report a click as an escape just because the app forbids navigate", async () => {
    const page = pageStub([`${ORIGIN}/menu`, `${ORIGIN}/members/101555`]);
    const { action, escaped } = await performHumanAction(page, { target: "#link" }, "click", policy(clickOnlyApp));
    expect(escaped).toBeUndefined();
    expect(action.blocked).toBeUndefined();
  });

  it("still catches a click that navigates off the allowlist, and walks it back", async () => {
    const page = pageStub([`${ORIGIN}/menu`, `${ORIGIN}/settings`]);
    const { action, escaped } = await performHumanAction(page, { target: "#link" }, "click", policy(clickOnlyApp));
    expect(escaped).toBe(`${ORIGIN}/settings`);
    expect(action.blocked).toBe(true);
    expect(action.blockReason).toContain("left the allowlist");
  });

  it("catches a click that leaves the origin entirely", async () => {
    const page = pageStub([`${ORIGIN}/menu`, "https://evil.example/menu"]);
    const { escaped } = await performHumanAction(page, { target: "#link" }, "click", policy(clickOnlyApp));
    expect(escaped).toBe("https://evil.example/menu");
  });
});
