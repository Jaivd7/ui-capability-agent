import { describe, expect, it } from "vitest";
import type { GuardrailsConfig } from "../guardrails/config.js";
import { performHumanAction, type HumanActionPolicy } from "./action-policy.js";

/**
 * What the fix is actually for: the message that lands in the run log when an
 * operator types a value into a live form during an escalation.
 *
 * Before, `sensitiveValues` was `[]` at every construction site, so a declared
 * sensitive param fell through to the generic partial mask and a member's
 * e-mail was logged as `a[REDACTED]m`. These assert both sides of the branch.
 */
const guardrails: GuardrailsConfig = {
  allowedOrigins: ["https://web-sample.interface-hiring.com"],
  allowedRoutePatterns: ["^/(signon|signoff|menu|members(/.*)?)$"],
  allowedActionTypes: ["navigate", "click", "fill", "select"],
  irreversibleActionPolicy: "block",
};

/** A locator/page stub: enough for performHumanAction's uniqueness check and fill. */
function pageStub(url: string) {
  const locator = { count: async () => 1, fill: async () => undefined };
  return { url: () => url, locator: () => locator } as never;
}

const AT = "https://web-sample.interface-hiring.com/members/101555";

async function detailOf(policy: HumanActionPolicy, value: string, target = "#email"): Promise<string> {
  const { action } = await performHumanAction(pageStub(AT), { target, value }, "fill", policy);
  return action.detail;
}

describe("logging a value an operator typed", () => {
  it("fully redacts a value the run declared sensitive", async () => {
    const policy: HumanActionPolicy = {
      guardrails,
      app: "meridian-core",
      sensitiveValues: ["alan.turing@example.com"],
    };
    expect(await detailOf(policy, "alan.turing@example.com")).toBe('fill "#email" = [REDACTED]');
  });

  it("still partially masks a value nothing knows about, so the shape survives for debugging", async () => {
    const policy: HumanActionPolicy = { guardrails, app: "meridian-core", sensitiveValues: [] };
    expect(await detailOf(policy, "alan.turing@example.com")).toBe('fill "#email" = a[REDACTED]m');
  });

  it("redacts a password field regardless of what the run declared", async () => {
    const policy: HumanActionPolicy = { guardrails, app: "meridian-core", sensitiveValues: [] };
    expect(await detailOf(policy, "hunter2", "input[name=password]")).toBe(
      'fill "input[name=password]" = [REDACTED]',
    );
  });

  it("matches a sensitive value declared as a number and typed as text", async () => {
    const policy: HumanActionPolicy = { guardrails, app: "meridian-core", sensitiveValues: [1234] };
    expect(await detailOf(policy, "1234", "#pin")).toBe('fill "#pin" = [REDACTED]');
  });
});
