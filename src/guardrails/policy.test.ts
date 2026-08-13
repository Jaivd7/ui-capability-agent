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
});
