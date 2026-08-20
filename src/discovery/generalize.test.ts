import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArtifact } from "../artifact/index.js";
import { renderTemplate, type ParamValue } from "../artifact/template.js";
import { forEachTemplateSite } from "../artifact/template-sites.js";
import { baseArtifact } from "../artifact/test-fixtures.js";
import {
  assertNoLeakedPageData,
  generalizeArtifact,
  paramSurfaces,
  templatize,
  type ExtractedRecord,
} from "./generalize.js";
import type { DiscoveryParam } from "./loop.js";

const memberId: DiscoveryParam = {
  name: "memberId",
  type: "string",
  exampleValue: "1001",
  sensitive: false,
};
const openingDeposit: DiscoveryParam = {
  name: "openingDeposit",
  type: "currency",
  exampleValue: "100",
  sensitive: false,
};
const accountType: DiscoveryParam = {
  name: "accountType",
  type: "string",
  exampleValue: "Standard Savings",
  sensitive: false,
};

function apply(literal: string, params: DiscoveryParam[], regex = false): string {
  return templatize(literal, paramSurfaces(params, regex));
}

describe("templatize", () => {
  it("replaces a param value embedded in a URL", () => {
    expect(apply("/members/1001", [memberId])).toBe("/members/${memberId}");
  });

  // The bug this pass exists to kill: with memberId="1001" and
  // openingDeposit="100", the old includes()-based pass produced
  // "/members/${openingDeposit}1" whenever openingDeposit iterated first.
  // Longest-match makes the result independent of declaration order.
  it.each([
    ["memberId first", [memberId, openingDeposit]],
    ["openingDeposit first", [openingDeposit, memberId]],
  ])("is independent of param declaration order (%s)", (_label, params) => {
    expect(apply("/members/1001", params)).toBe("/members/${memberId}");
  });

  it("recognises a currency param in the surface form the page rendered", () => {
    expect(apply("$100.00", [openingDeposit])).toBe("${openingDeposit:currency}");
  });

  it("still recognises the raw form of the same param", () => {
    expect(apply("deposit=100", [openingDeposit])).toBe("deposit=${openingDeposit}");
  });

  it("does not split a longer number (digit boundary)", () => {
    expect(apply("/members/10015", [memberId])).toBe("/members/10015");
    expect(apply("/members/91001", [memberId])).toBe("/members/91001");
  });

  it("replaces a multi-word text param mid-sentence", () => {
    expect(apply("Account type Standard Savings selected", [accountType])).toBe(
      "Account type ${accountType} selected",
    );
  });

  it("never re-scans its own output", () => {
    // A param whose value appears inside a placeholder we just emitted must
    // not be matched again — this is the cascading-replacement bug.
    const member: DiscoveryParam = { ...memberId, name: "memberId" };
    const trap: DiscoveryParam = {
      name: "prefix",
      type: "string",
      exampleValue: "member",
      sensitive: false,
    };
    expect(apply("/members/1001", [member, trap])).not.toContain("${${");
  });

  it("escapes a literal ${ so it survives rendering", () => {
    const out = apply("td:has-text('${raw}')", [memberId]);
    expect(renderTemplate(out, { memberId: "1001" }, "t")).toBe("td:has-text('${raw}')");
  });

  it("never templatizes a sensitive param", () => {
    // A sensitive value in a locator ends up in LocatorResolutionError's
    // message, and from there in the run log and the failure evidence.
    const secret: DiscoveryParam = {
      name: "ssn",
      type: "string",
      exampleValue: "123456789",
      sensitive: true,
    };
    expect(apply("row for 123456789", [secret])).toBe("row for 123456789");
  });

  it("skips a surface too short to be safe", () => {
    const tiny: DiscoveryParam = { name: "n", type: "string", exampleValue: "1", sensitive: false };
    expect(apply("table tr:nth-child(1) td:nth-child(2)", [tiny])).toBe(
      "table tr:nth-child(1) td:nth-child(2)",
    );
  });

  it("offers only the escaped raw form in a regex context", () => {
    expect(apply("^/members/1001$", [memberId, openingDeposit], true)).toBe(
      "^/members/${memberId:regexEscape}$",
    );
  });

  it("does not inject a currency surface into a regex pattern", () => {
    // "$100.00" is three regex metacharacters and there is no escaped-currency
    // formatter, so that surface must never reach a pattern. The *raw* surface
    // may — "100" appears literally inside ^\$100\.00$ and templating it
    // there is what makes the checkpoint parameterized rather than hardcoded.
    const out = apply("^\\$100\\.00$", [openingDeposit], true);
    expect(out).toBe("^\\$${openingDeposit:regexEscape}\\.00$");
    expect(out).not.toContain(":currency");
    expect(renderTemplate(out, { openingDeposit: "100" }, "t")).toBe("^\\$100\\.00$");
    // and it genuinely generalizes, which the recorded literal did not
    expect(renderTemplate(out, { openingDeposit: "1500" }, "t")).toBe("^\\$1500\\.00$");
  });
});

describe("paramSurfaces", () => {
  it("sorts longest first so the greedy match is deterministic", () => {
    const surfaces = paramSurfaces([openingDeposit, memberId]);
    const lengths = surfaces.map((s) => s.text.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it("drops formats a param has no meaningful rendering for", () => {
    // "Standard Savings" is not a currency, so no currency surface is offered.
    expect(paramSurfaces([accountType]).every((s) => s.format !== "currency")).toBe(true);
  });
});

describe("generalizeArtifact", () => {
  it("templatizes a checkpoint that asserts a param value", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "Member 1001";
    const { artifact: out } = generalizeArtifact(artifact, [memberId]);
    expect(out.checkpoints[0]!.expected).toBe("Member ${memberId}");
  });

  it("templatizes a locator string, which the old compiler never touched", () => {
    const artifact = baseArtifact();
    const candidate = artifact.checkpoints[0]!.locator[0]!;
    if (candidate.strategy !== "label") throw new Error("fixture changed");
    candidate.text = "Balance for 1001";
    const { artifact: out } = generalizeArtifact(artifact, [memberId]);
    const resolved = out.checkpoints[0]!.locator[0]!;
    expect(resolved.strategy === "label" && resolved.text).toBe("Balance for ${memberId}");
  });

  it("produces an artifact whose every string round-trips to what was recorded", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "Member 1001";
    artifact.steps[0]!.description = "Search for member 1001";
    const before: string[] = [];
    forEachTemplateSite(artifact, (v) => before.push(v));

    const { artifact: out, findings } = generalizeArtifact(artifact, [memberId]);
    const after: string[] = [];
    forEachTemplateSite(out, (v, site) => after.push(renderTemplate(v, { memberId: "1001" }, site.path)));

    expect(after).toEqual(before);
    expect(findings).toEqual([]);
  });

  it("leaves the artifact schema-valid", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "Member 1001";
    const { artifact: out } = generalizeArtifact(artifact, [memberId]);
    expect(parseArtifact(out).success).toBe(true);
  });
});

describe("assertNoLeakedPageData", () => {
  const balance: Record<string, ExtractedRecord> = {
    savingsBalance: { raw: "$3482.10", value: 3482.1, sensitive: true },
  };

  it("refuses the exact leak that shipped in the recorded artifact", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "$3482.10";
    expect(() => assertNoLeakedPageData(artifact, balance)).toThrow(/savingsBalance/);
  });

  it("catches the raw form even though the transformed value differs", () => {
    // String(3482.1) is "3482.1" — not a substring of "$3482.10". Matching on
    // the post-transform value alone would miss the thing that actually leaked.
    expect(String(balance.savingsBalance!.value)).not.toContain("3482.10");
    const artifact = baseArtifact();
    artifact.steps[0]!.description = "Read $3482.10 from the panel";
    expect(() => assertNoLeakedPageData(artifact, balance)).toThrow();
  });

  it("names the output, never the value", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "$3482.10";
    try {
      assertNoLeakedPageData(artifact, balance);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("3482.10");
    }
  });

  it("refuses a hardcoded currency amount even with no extract steps", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "$100.00";
    expect(() => assertNoLeakedPageData(artifact, {})).toThrow(/hardcoded currency amount/);
  });

  it("allows a currency amount in a hand-authored knownOutcome detector", () => {
    // "Opening deposit must be at least $25.00." is the app's own validation
    // copy, written by hand and verified against the live app — not page data
    // read during this recording.
    const artifact = baseArtifact();
    artifact.knownOutcomes[0]!.detect.locator[0] = {
      strategy: "text",
      text: "Opening deposit must be at least $25.00.",
      exact: false,
      reason: "the app's literal validation banner",
    };
    expect(() => assertNoLeakedPageData(artifact, {})).not.toThrow();
  });

  it("passes a clean artifact", () => {
    expect(assertNoLeakedPageData(baseArtifact(), balance)).toEqual([]);
  });
});

describe("the committed capability artifacts", () => {
  const ids = ["lookup-member-balance", "open-sub-account"];

  it.each(ids)("%s: every templated string round-trips to its recorded example", (id) => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "capabilities", `${id}.json`), "utf-8"),
    );
    const parsed = parseArtifact(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const examples: Record<string, ParamValue> = Object.fromEntries(
      parsed.artifact.inputParams.flatMap((p) =>
        p.example === undefined ? [] : [[p.name, p.example]],
      ),
    );
    // Rendering with the recorded example values must never throw: that is the
    // guarantee that a template only ever names a param the artifact declares.
    expect(() =>
      forEachTemplateSite(parsed.artifact, (v, site) => renderTemplate(v, examples, site.path)),
    ).not.toThrow();
  });
});
