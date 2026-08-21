import { describe, expect, it } from "vitest";
import type { CheckpointCondition } from "../artifact/schema.js";
import { checkCheckpointQuality, violationMessage } from "./checkpoint-quality.js";
import type { ExtractedRecord } from "./generalize.js";
import type { DiscoveryParam } from "./loop.js";

const savingsBalance: Record<string, ExtractedRecord> = {
  savingsBalance: { raw: "$3482.10", value: 3482.1, sensitive: true },
};

const params: DiscoveryParam[] = [
  { name: "memberId", type: "string", exampleValue: "1001", sensitive: false },
  { name: "openingDeposit", type: "currency", exampleValue: "100", sensitive: false },
];

function checkpoint(over: Partial<CheckpointCondition> = {}): CheckpointCondition {
  return {
    description: "Savings balance is shown",
    frame: [],
    locator: [{ strategy: "label", text: "Savings Balance", exact: true, reason: "aria-label on the value cell" }],
    assertion: "exists",
    ...over,
  };
}

describe("checkCheckpointQuality", () => {
  it("rejects the exact checkpoint that shipped in the recorded artifact", () => {
    const cp = checkpoint({ assertion: "textContains", expected: "$3482.10" });
    const violations = checkCheckpointQuality([cp], { extractedValues: savingsBalance, params });
    expect(violations).toEqual([
      { kind: "extracted_value", index: 0, field: "expected", outputName: "savingsBalance" },
    ]);
  });

  it("catches the transformed form as well as the raw form", () => {
    const cp = checkpoint({ assertion: "textContains", expected: "3482.1" });
    expect(checkCheckpointQuality([cp], { extractedValues: savingsBalance, params })).toHaveLength(1);
  });

  it("catches an extracted value hidden in a locator", () => {
    const cp = checkpoint({
      locator: [{ strategy: "text", text: "$3482.10", exact: false, reason: "the balance cell" }],
    });
    const violations = checkCheckpointQuality([cp], { extractedValues: savingsBalance, params });
    expect(violations[0]).toMatchObject({ kind: "extracted_value", field: "locator[0].text" });
  });

  it("catches an extracted value in the description", () => {
    const cp = checkpoint({ description: "Balance reads $3482.10" });
    const violations = checkCheckpointQuality([cp], { extractedValues: savingsBalance, params });
    expect(violations[0]).toMatchObject({ kind: "extracted_value", field: "description" });
  });

  it("rejects a hardcoded amount even when nothing was extracted", () => {
    const cp = checkpoint({ assertion: "textContains", expected: "$4,200.00" });
    const violations = checkCheckpointQuality([cp], { extractedValues: {}, params });
    expect(violations[0]).toMatchObject({ kind: "currency_literal", literal: "$4,200.00" });
  });

  it("allows an amount that is one of the caller's own parameters", () => {
    // openingDeposit's example is "100", which the page renders as "$100.00".
    // That comes from the request, not the page, and the compiler turns it
    // into a template.
    const cp = checkpoint({ assertion: "textContains", expected: "$100.00" });
    expect(checkCheckpointQuality([cp], { extractedValues: {}, params })).toEqual([]);
  });

  it("allows a structural checkpoint", () => {
    const cp = checkpoint({ assertion: "textMatches", expected: "^\\$[0-9,]+\\.[0-9]{2}$" });
    expect(checkCheckpointQuality([cp], { extractedValues: savingsBalance, params })).toEqual([]);
  });

  it("allows a urlMatches checkpoint built from a param", () => {
    const cp = checkpoint({
      description: "On member 1001's detail page",
      assertion: "urlMatches",
      expected: "/members/1001$",
    });
    expect(checkCheckpointQuality([cp], { extractedValues: savingsBalance, params })).toEqual([]);
  });

  it("reports at most one violation per checkpoint, so the model gets one clear fix each", () => {
    const cp = checkpoint({ description: "Balance $3482.10", assertion: "textContains", expected: "$3482.10" });
    expect(checkCheckpointQuality([cp], { extractedValues: savingsBalance, params })).toHaveLength(1);
  });
});

describe("violationMessage", () => {
  const cp = checkpoint({ assertion: "textContains", expected: "$3482.10" });
  const violations = checkCheckpointQuality([cp], { extractedValues: savingsBalance, params });
  const message = violationMessage(violations, [cp]);

  it("names the output rather than echoing the value", () => {
    // This string lands in the transcript and the run log before the
    // redaction pass would see it, so it has to be safe on its own.
    expect(message).toContain("savingsBalance");
    expect(message).not.toContain("3482");
  });

  it("prescribes the structural alternatives", () => {
    expect(message).toContain("textMatches");
    expect(message).toContain("exists");
  });

  it("tells the model the input parameters are still fair game", () => {
    expect(message).toMatch(/input parameters are fine/i);
  });
  it("allows a checkpoint asserting a value that is both an input param and an output", () => {
    // A member lookup that returns the member number it was given reads its
    // own input back off the page, so the value is in extractedValues. It is
    // still caller-supplied, and the capability has to be able to assert it —
    // otherwise "did I land on the right member?" is unassertable, which is
    // the whole point of the lookup. The compiler templatizes the literal.
    const violations = checkCheckpointQuality(
      [
        checkpoint({
          description: "Member No. cell holds the member searched for",
          assertion: "textEquals",
          expected: "100234",
        }),
      ],
      {
        params: [
          { name: "memberId", type: "string", exampleValue: "100234", sensitive: false },
        ],
        extractedValues: {
          memberId: { value: "100234", raw: "100234", sensitive: false },
        },
      },
    );

    expect(violations).toEqual([]);
  });

  it("still rejects a value that was read off the page and is not a param", () => {
    const violations = checkCheckpointQuality(
      [
        checkpoint({
          description: "Name cell",
          assertion: "textEquals",
          expected: "Hopper, Grace",
        }),
      ],
      {
        params: [
          { name: "memberId", type: "string", exampleValue: "100234", sensitive: false },
        ],
        extractedValues: {
          memberName: { value: "Hopper, Grace", raw: "Hopper, Grace", sensitive: true },
        },
      },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "extracted_value", outputName: "memberName" });
  });

  it("allows a value that is a declared param even when the run also extracted it", () => {
    // A capability that takes a member number *and* reads it back is the case
    // that made this necessary: the prompt requires a checkpoint asserting an
    // input param, and this rule forbade asserting the one value available, so
    // no legal checkpoint existed. The caller supplies the value, and the
    // generalizer templates it, so the artifact is parameterised either way.
    const violations = checkCheckpointQuality(
      [checkpoint({ assertion: "textContains", expected: "100234" })],
      {
        extractedValues: { memberId: { value: "100234", raw: "100234", sensitive: false } },
        params: [
          { name: "memberId", type: "string", exampleValue: "100234", sensitive: false },
        ],
      },
    );

    expect(violations).toEqual([]);
  });

  it("still rejects an extracted value that no param accounts for", () => {
    const violations = checkCheckpointQuality(
      [checkpoint({ assertion: "textContains", expected: "Hopper, Grace" })],
      {
        extractedValues: { memberName: { value: "Hopper, Grace", raw: "Hopper, Grace", sensitive: false } },
        params: [
          { name: "memberId", type: "string", exampleValue: "100234", sensitive: false },
        ],
      },
    );

    expect(violations.map((v) => v.kind)).toEqual(["extracted_value"]);
  });
});
