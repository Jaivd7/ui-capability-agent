import { describe, expect, it } from "vitest";
import { baseArtifact } from "../artifact/test-fixtures.js";
import { coerceOne, coerceParams, ParamValidationError, validateInvocation } from "./coerce.js";

function artifactWithParams(params: Array<Record<string, unknown>>) {
  const a = baseArtifact();
  a.inputParams = params as typeof a.inputParams;
  return a;
}

describe("coerceOne", () => {
  it("leaves a declared string verbatim, leading zeros and all", () => {
    // The rule this replaced turned memberId=0042 into 42, which was harmless
    // while params only reached `fill` and is not harmless now that they reach
    // locators, URLs and assertions.
    expect(coerceOne("memberId", "0042", "string")).toBe("0042");
  });

  it("parses currency and number, stripping symbols and separators", () => {
    expect(coerceOne("amount", "$1,500.50", "currency")).toBe(1500.5);
    expect(coerceOne("n", "42", "number")).toBe(42);
  });

  it("accepts a real JSON number for a numeric param", () => {
    // A dashboard form sends strings; a programmatic agent sends JSON. One
    // coercion table, so the two cannot diverge.
    expect(coerceOne("amount", 1500.5, "currency")).toBe(1500.5);
  });

  it("throws rather than exiting the process on a bad value", () => {
    // The whole reason this moved out of the CLI: process.exit is fine in a
    // CLI and fatal in a server.
    expect(() => coerceOne("amount", "abc", "currency")).toThrow(ParamValidationError);
  });

  it("rejects an empty numeric value rather than reading it as zero", () => {
    expect(() => coerceOne("amount", "", "currency")).toThrow(ParamValidationError);
  });

  it("understands the boolean spellings a form and an agent each send", () => {
    expect(coerceOne("f", "on", "boolean")).toBe(true);
    expect(coerceOne("f", "false", "boolean")).toBe(false);
    expect(coerceOne("f", true, "boolean")).toBe(true);
    expect(() => coerceOne("f", "perhaps", "boolean")).toThrow(ParamValidationError);
  });
});

describe("coerceParams", () => {
  const artifact = artifactWithParams([
    { name: "memberId", type: "string", required: true, sensitive: false, example: "1001" },
    { name: "amount", type: "currency", required: true, sensitive: false, example: "100" },
  ]);

  it("collects every bad field before throwing, not just the first", () => {
    // A form that reports one broken input at a time is miserable, and an
    // agent gets a better repair signal from the complete list.
    try {
      coerceParams(artifact, { memberId: "1001", amount: "abc" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ParamValidationError);
      expect((err as ParamValidationError).fields.map((f) => f.name)).toEqual(["amount"]);
    }
  });

  it("reports two bad fields together", () => {
    const two = artifactWithParams([
      { name: "a", type: "currency", required: true, sensitive: false },
      { name: "b", type: "number", required: true, sensitive: false },
    ]);
    try {
      coerceParams(two, { a: "x", b: "y" });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as ParamValidationError).fields.map((f) => f.name)).toEqual(["a", "b"]);
    }
  });

  it("warns rather than failing on a param the capability does not declare", () => {
    const { params, warnings } = coerceParams(artifact, { memberId: "1", amount: "5", extra: "x" });
    expect(params.extra).toBe("x");
    expect(warnings).toHaveLength(1);
  });
});

describe("validateInvocation", () => {
  const artifact = artifactWithParams([
    { name: "memberId", type: "string", required: true, sensitive: false },
    { name: "memo", type: "string", required: false, sensitive: false },
  ]);

  it("rejects a missing required param as a field problem", () => {
    try {
      validateInvocation(artifact, {});
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as ParamValidationError).fields).toEqual([
        { name: "memberId", problem: "is required" },
      ]);
    }
  });

  it("treats a blank string as missing", () => {
    // An HTML form submits empty text inputs, so absent and blank have to mean
    // the same thing or every optional-looking field becomes required.
    expect(() => validateInvocation(artifact, { memberId: "  " })).toThrow(ParamValidationError);
  });

  it("accepts a valid invocation and omits nothing", () => {
    const { params } = validateInvocation(artifact, { memberId: "1001" });
    expect(params).toEqual({ memberId: "1001" });
  });
});
