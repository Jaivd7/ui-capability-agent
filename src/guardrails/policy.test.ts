import { describe, expect, it } from "vitest";
import type { GuardrailsConfig } from "./config.js";
import { evaluateGuardrails } from "./policy.js";

const config: GuardrailsConfig = {
  allowedOrigins: ["http://localhost:4000"],
  allowedRoutePatterns: ["^/(login|members(/.*)?)$"],
  allowedActionTypes: ["navigate", "click", "fill", "extract"],
  irreversibleActionPolicy: "block",
};

describe("evaluateGuardrails", () => {
  it("allows an in-policy action within scope", () => {
    const result = evaluateGuardrails({ type: "click" }, { currentUrl: "http://localhost:4000/members" }, config);
    expect(result.allowed).toBe(true);
  });

  it("blocks an action type not in the allowlist", () => {
    const result = evaluateGuardrails({ type: "select" }, { currentUrl: "http://localhost:4000/members" }, config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/action type/i);
  });

  it("blocks a step marked irreversible under a block policy", () => {
    const result = evaluateGuardrails(
      { type: "click", irreversible: true },
      { currentUrl: "http://localhost:4000/members" },
      config,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/irreversible/i);
  });

  it("blocks when the current page is outside the allowed origin", () => {
    const result = evaluateGuardrails({ type: "click" }, { currentUrl: "http://evil.example.com/members" }, config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/origin/i);
  });

  it("blocks when the current route doesn't match any allowed pattern", () => {
    const result = evaluateGuardrails({ type: "click" }, { currentUrl: "http://localhost:4000/admin" }, config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/route/i);
  });

  it("blocks a navigate step whose target is outside the allowed scope even if the current page is in scope", () => {
    const result = evaluateGuardrails(
      { type: "navigate" },
      { currentUrl: "http://localhost:4000/members", targetUrl: "http://localhost:4000/admin/danger" },
      config,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/route/i);
  });

  it("allows a navigate step whose target is within the allowed scope", () => {
    const result = evaluateGuardrails(
      { type: "navigate" },
      { currentUrl: "http://localhost:4000/login", targetUrl: "http://localhost:4000/members" },
      config,
    );
    expect(result.allowed).toBe(true);
  });

  it("reports the first violation when a step fails multiple checks (action type wins over irreversible)", () => {
    const result = evaluateGuardrails(
      { type: "select", irreversible: true },
      { currentUrl: "http://localhost:4000/members" },
      config,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/action type/i);
  });

  describe("risk-based approval for irreversible steps", () => {
    const withThreshold: GuardrailsConfig = { ...config, irreversibleAmountThreshold: 100 };
    const step = { type: "click", irreversible: true };
    const ctx = (amount?: number) => ({
      currentUrl: "http://localhost:4000/members",
      ...(amount !== undefined ? { amount } : {}),
    });

    it("allows an irreversible step below the threshold", () => {
      expect(evaluateGuardrails(step, ctx(25), withThreshold).allowed).toBe(true);
    });

    it("blocks at the threshold", () => {
      // At, not just above: a threshold of 100 means 100 needs a human.
      expect(evaluateGuardrails(step, ctx(100), withThreshold).allowed).toBe(false);
    });

    it("blocks above the threshold", () => {
      const decision = evaluateGuardrails(step, ctx(5000), withThreshold);
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("irreversible_blocked");
    });

    it("blocks when no amount could be resolved", () => {
      // Fail closed: a capability with no monetary parameter -- Place Account
      // Hold -- always escalates, as a consequence of the rule rather than a
      // special case for it.
      expect(evaluateGuardrails(step, ctx(), withThreshold).allowed).toBe(false);
    });

    it("blocks when no threshold is configured, whatever the amount", () => {
      expect(evaluateGuardrails(step, ctx(1), config).allowed).toBe(false);
    });

    it("blocks a non-finite amount rather than comparing it", () => {
      expect(evaluateGuardrails(step, ctx(Number.NaN), withThreshold).allowed).toBe(false);
    });

    it("leaves a reversible step alone regardless of amount", () => {
      expect(evaluateGuardrails({ type: "click" }, ctx(999999), withThreshold).allowed).toBe(true);
    });
  });
});
