import { describe, expect, it } from "vitest";
import type { GuardrailsConfig } from "../guardrails/config.js";
import { performExtract, performHumanAction, type HumanActionPolicy } from "./action-policy.js";

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

/**
 * A rescued output must be the same type as one the engine extracted.
 *
 * No artifact in this catalog sets a transform on any extract step, yet four
 * outputs declare `currency` or `number` -- the engine defaults the transform
 * from the declared type, and the console has to do the same or a caller gets a
 * string from a rescued run and a number from a normal one.
 */
describe("a rescued output is coerced like a recorded one", () => {
  const artifact = {
    steps: [{ id: "step-3", type: "extract", outputName: "balance", read: { from: "innerText" } }],
    outputs: [{ name: "balance", type: "currency", sensitive: true }],
  } as unknown as import("../artifact/schema.js").CapabilityArtifact;

  const cell = (text: string) =>
    ({
      url: () => AT,
      locator: () => ({ count: async () => 1, innerText: async () => text }),
    }) as never;

  it("applies the declared currency transform when the recorded step set none", async () => {
    const policy: HumanActionPolicy = { guardrails, app: "meridian-core", artifact, sensitiveValues: [] };
    const { value } = await performExtract(
      cell("$17,925.98"),
      { target: "#bal", outputName: "balance" },
      policy,
      { type: "currency", sensitive: true },
    );
    expect(value).toBe(17925.98);
  });

  it("does the same when no artifact is available at all", async () => {
    const policy: HumanActionPolicy = { guardrails, app: "meridian-core", sensitiveValues: [] };
    const { value } = await performExtract(
      cell("$26.00"),
      { target: "#bal", outputName: "balance" },
      policy,
      { type: "currency", sensitive: false },
    );
    expect(value).toBe(26);
  });

  it("leaves a string output as text", async () => {
    const policy: HumanActionPolicy = { guardrails, app: "meridian-core", sensitiveValues: [] };
    const { value } = await performExtract(
      cell("HOLD [HOLD]"),
      { target: "#st", outputName: "status" },
      policy,
      { type: "string", sensitive: false },
    );
    expect(value).toBe("HOLD [HOLD]");
  });
});
