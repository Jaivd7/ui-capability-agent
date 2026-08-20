import { describe, expect, it } from "vitest";
import {
  escapeLiteral,
  formatParam,
  hasTemplate,
  parseTemplate,
  renderTemplate,
  TemplateError,
} from "./template.js";

const W = "test-site";

describe("renderTemplate", () => {
  it("substitutes a bare placeholder", () => {
    expect(renderTemplate("/members/${memberId}", { memberId: "1001" }, W)).toBe("/members/1001");
  });

  it("substitutes several placeholders in one string", () => {
    expect(
      renderTemplate("${a} and ${b}", { a: "x", b: "y" }, W),
    ).toBe("x and y");
  });

  it("throws on a placeholder with no supplied value", () => {
    expect(() => renderTemplate("/members/${memberId}", {}, W)).toThrow(TemplateError);
    expect(() => renderTemplate("/members/${memberId}", {}, W)).toThrow(/memberId/);
  });

  it("names the site in the error, so a failure is diagnosable", () => {
    expect(() => renderTemplate("${x}", {}, "checkpoints[1].locator[0].name")).toThrow(
      /checkpoints\[1\]\.locator\[0\]\.name/,
    );
  });

  it("throws on an unknown format", () => {
    expect(() => renderTemplate("${x:bogus}", { x: "1" }, W)).toThrow(/unknown format "bogus"/);
  });

  it("throws when a param renders to an empty string", () => {
    // An empty locator/assertion string matches nothing or everything rather
    // than failing, so it has to be caught where the cause is still obvious.
    expect(() => renderTemplate("${x}", { x: "" }, W)).toThrow(/rendered empty/);
  });

  // Property 3: parses as a placeholder => must resolve; doesn't parse => literal.
  it.each([
    ["${1}", "${1}"],
    ["${ x}", "${ x}"],
    ["#{x}", "#{x}"],
    ["a $ b", "a $ b"],
    ["${x", "${x"],
    ["td:nth-child(2)", "td:nth-child(2)"],
  ])("leaves non-placeholder text verbatim: %s", (input, expected) => {
    expect(renderTemplate(input, {}, W)).toBe(expected);
  });

  it("treats ${{ as an escaped literal ${", () => {
    expect(renderTemplate("${{memberId}", { memberId: "1001" }, W)).toBe("${memberId}");
  });

  it("still substitutes a placeholder that directly follows a literal $", () => {
    // The reason the escape is `${{` and not `$${`: a regex assertion ending
    // in a literal `\$` followed by a placeholder would otherwise read as an
    // escape and silently stop substituting.
    expect(renderTemplate("^\\$${amount}\\.00$", { amount: "100" }, W)).toBe("^\\$100\\.00$");
  });

  it("never re-scans substituted output", () => {
    // A caller-supplied value that looks like a placeholder must stay inert —
    // this is the injection guard, and the fix for the old cascading-replace bug.
    expect(renderTemplate("${a}", { a: "${b}" }, W)).toBe("${b}");
  });
});

describe("escapeLiteral", () => {
  it.each(["plain", "${x}", "$${x}", "${{x}", "a ${x} b ${y}", "$", "${", "^\\$100\\.00$"])(
    "round-trips %s through renderTemplate",
    (literal) => {
      expect(renderTemplate(escapeLiteral(literal), {}, W)).toBe(literal);
    },
  );
});

describe("formatParam", () => {
  it("raw stringifies without interpretation", () => {
    expect(formatParam("0042", "raw")).toBe("0042");
    expect(formatParam(100, "raw")).toBe("100");
    expect(formatParam(true, "raw")).toBe("true");
  });

  it("currency renders the app's toFixed(2) form", () => {
    expect(formatParam("100", "currency")).toBe("$100.00");
    expect(formatParam(100, "currency")).toBe("$100.00");
  });

  it("currency does NOT group thousands", () => {
    // mock-app/views.ts renders `$${n.toFixed(2)}`, so 1500 appears as
    // "$1500.00". An Intl currency formatter would emit "$1,500.00" and give
    // us a checkpoint that passes for 100 and fails for 1500.
    expect(formatParam(1500, "currency")).toBe("$1500.00");
    expect(formatParam("15200.77", "currency")).toBe("$15200.77");
  });

  it("accepts both the string and number forms of the same param", () => {
    // replay/cli.ts coerces per declared type; tests pass string literals.
    expect(formatParam("100", "currency")).toBe(formatParam(100, "currency"));
  });

  it("number normalizes separators and symbols", () => {
    expect(formatParam("$1,500.50", "number")).toBe("1500.5");
    expect(formatParam(100, "number")).toBe("100");
  });

  it("throws rather than emitting NaN for a non-numeric value", () => {
    expect(() => formatParam("Standard Savings", "currency")).toThrow(TemplateError);
    expect(() => formatParam("", "number")).toThrow(TemplateError);
  });

  it("regexEscape neutralizes regex metacharacters", () => {
    expect(formatParam("a.b*c", "regexEscape")).toBe("a\\.b\\*c");
    expect(formatParam("1001", "regexEscape")).toBe("1001");
  });
});

describe("parseTemplate", () => {
  it("reports refs with their resolved format", () => {
    const { refs } = parseTemplate("/members/${memberId}/x/${amount:currency}");
    expect(refs).toEqual([
      { param: "memberId", format: "raw", source: "${memberId}" },
      { param: "amount", format: "currency", source: "${amount:currency}" },
    ]);
  });

  it("collects unknown formats without throwing", () => {
    const { refs, unknownFormats } = parseTemplate("${a:bogus} ${b}");
    expect(unknownFormats).toEqual(["bogus"]);
    expect(refs.map((r) => r.param)).toEqual(["b"]);
  });

  it("ignores the escape sequence", () => {
    expect(parseTemplate("${{notAParam}").refs).toEqual([]);
  });
});

describe("hasTemplate", () => {
  it("is not confused by repeated calls (no lastIndex leak)", () => {
    expect(hasTemplate("${x}")).toBe(true);
    expect(hasTemplate("${x}")).toBe(true);
    expect(hasTemplate("plain")).toBe(false);
    expect(hasTemplate("plain")).toBe(false);
  });
});
