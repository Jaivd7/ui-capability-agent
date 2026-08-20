import { describe, expect, it } from "vitest";
import { applyTransform } from "./extract.js";

describe("applyTransform", () => {
  it("trims by default", () => {
    expect(applyTransform("  hello  ", undefined)).toBe("hello");
    expect(applyTransform("  hello  ", "trim")).toBe("hello");
  });

  it("parses a currency amount to a number", () => {
    expect(applyTransform("$3,482.10", "currency")).toBe(3482.1);
    expect(applyTransform("$1500.00", "currency")).toBe(1500);
  });

  it("parses a plain number, separators and all", () => {
    expect(applyTransform("15,200.77", "number")).toBe(15200.77);
  });

  // Number("") is 0, not NaN, so the isFinite guard passes and an empty cell
  // extracted as the number 0 while throwing nothing. On a balance-reading
  // capability that is the worst available failure: the caller cannot tell it
  // apart from a genuine zero balance.
  it.each(["", "   ", "$", "--", "\n\t"])(
    "throws rather than returning 0 for %j",
    (raw) => {
      expect(() => applyTransform(raw, "currency")).toThrow(/no numeric content/);
      expect(() => applyTransform(raw, "number")).toThrow(/no numeric content/);
    },
  );

  it("reads accounting notation as negative", () => {
    // "(1,234.56)" is a debit. Stripping punctuation first dropped the
    // parentheses and returned a positive number with no error.
    expect(applyTransform("($1,234.56)", "currency")).toBe(-1234.56);
    expect(applyTransform("(0.99)", "currency")).toBe(-0.99);
  });

  it("still reads an explicit minus sign", () => {
    expect(applyTransform("-$40.00", "currency")).toBe(-40);
  });

  it("throws on text that is not a number", () => {
    expect(() => applyTransform("Savings Balance", "currency")).toThrow(/could not parse/);
  });

  it("normalizes a date to ISO", () => {
    expect(applyTransform("2026-08-20T00:00:00.000Z", "date")).toBe("2026-08-20T00:00:00.000Z");
  });

  it("throws on an unparseable date", () => {
    expect(() => applyTransform("not a date", "date")).toThrow(/could not parse/);
  });
});
