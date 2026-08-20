import { describe, expect, it } from "vitest";
import { redactFields, redactTranscriptText, redactValue, REDACTED } from "./redact.js";

describe("redactValue", () => {
  it("passes non-sensitive values through untouched", () => {
    expect(redactValue("1001", false)).toBe("1001");
    expect(redactValue(3482.1, false)).toBe(3482.1);
  });

  it("keeps first and last character of a longer string", () => {
    expect(redactValue("$3482.10", true)).toBe(`$${REDACTED}0`);
  });

  it("masks a short string entirely, since first+last would be all of it", () => {
    expect(redactValue("ab", true)).toBe(REDACTED);
    expect(redactValue("a", true)).toBe(REDACTED);
  });

  it("masks numbers entirely — there is no safe shape to keep", () => {
    expect(redactValue(3482.1, true)).toBe(REDACTED);
  });
});

describe("redactFields", () => {
  it("masks only the named keys", () => {
    expect(redactFields({ memberId: "1001", ssn: "123456789" }, new Set(["ssn"]))).toEqual({
      memberId: "1001",
      ssn: `1${REDACTED}9`,
    });
  });
});

describe("redactTranscriptText", () => {
  it("removes every occurrence of a known sensitive value", () => {
    const text = 'read 3482.1 then narrated "the balance was 3482.1"';
    expect(redactTranscriptText(text, [3482.1])).not.toContain("3482.1");
  });

  it("catches a currency amount that was never declared as an output", () => {
    // The blanket pattern is what actually kept the transcript clean; it is a
    // backstop for values the declared-output list never knew about.
    expect(redactTranscriptText("balance is $3,482.10 today", [])).not.toContain("3,482.10");
    expect(redactTranscriptText("balance is $3482.10 today", [])).not.toContain("3482.10");
  });

  it("does not touch text with nothing sensitive in it", () => {
    const text = "Searched for member 1001 and opened their record.";
    expect(redactTranscriptText(text, [])).toBe(text);
  });

  it("is a no-op on an empty sensitive-value list except for the currency pattern", () => {
    expect(redactTranscriptText("member 1001", [])).toBe("member 1001");
  });
});
