import { describe, expect, it } from "vitest";
import { baseArtifact } from "../artifact/test-fixtures.js";
import type { ExtractedRecord } from "./generalize.js";
import { formatScoreReport, scoreRecording, type FindingCode } from "./score-recording.js";

const balance: Record<string, ExtractedRecord> = {
  savingsBalance: { raw: "$3482.10", value: 3482.1, sensitive: true },
};

function codes(artifact: Parameters<typeof scoreRecording>[0], ctx = {}): FindingCode[] {
  return scoreRecording(artifact, ctx).findings.map((f) => f.code);
}

describe("scoreRecording", () => {
  it("flags every single-candidate chain", () => {
    // Both shipped artifacts have a length-1 chain on every step, which means
    // the ordered-fallback machinery the schema is built around has never
    // actually been exercised.
    const artifact = baseArtifact();
    const found = scoreRecording(artifact).findings.filter(
      (f) => f.code === "single_candidate_chain",
    );
    expect(found.length).toBe(scoreRecording(artifact).metrics.chains);
  });

  it("treats a css-only chain as an error and a css-first chain as a warning", () => {
    const artifact = baseArtifact();
    const step = artifact.steps[2]!;
    if (step.type !== "extract") throw new Error("fixture changed");
    step.locator = [
      { strategy: "css", selector: "table tr td:nth-child(2)", reason: "positional fallback only" },
    ];
    const found = codes(artifact);
    expect(found).toContain("brittle_locator_only");
    expect(found).toContain("brittle_locator_root");
  });

  it("does not flag a chain that has an accessibility-tree fallback", () => {
    const artifact = baseArtifact();
    const step = artifact.steps[2]!;
    if (step.type !== "extract") throw new Error("fixture changed");
    step.locator = [
      { strategy: "label", text: "Savings Balance", exact: true, reason: "aria-label on the value cell" },
      { strategy: "css", selector: "table tr td:nth-child(2)", reason: "structural fallback" },
    ];
    const chainFindings = scoreRecording(artifact).findings.filter(
      (f) => f.where === "steps[2].locator" && f.code !== "weak_reason",
    );
    expect(chainFindings).toEqual([]);
  });

  it("flags an extracted value that survived into a checkpoint", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "$3482.10";
    expect(codes(artifact, { extractedValues: balance })).toContain("unbound_data_literal");
  });

  it("never echoes the offending value, because the report is committed", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "$3482.10";
    const score = scoreRecording(artifact, { extractedValues: balance });
    const report = formatScoreReport(score, "lookup-member-balance");
    expect(report).toContain("savingsBalance");
    expect(report).not.toContain("3482");
  });

  it("flags a param value left as a literal instead of a template", () => {
    // Static analysis can see this one: the string is correct for the recorded
    // arguments and wrong for every other invocation.
    const artifact = baseArtifact();
    artifact.steps[0]!.description = "Search for member 1001";
    const found = scoreRecording(artifact).findings.find(
      (f) => f.code === "ungeneralized_param_literal",
    );
    expect(found?.where).toBe("steps[0].description");
    expect(found?.message).toContain("memberId");
  });

  it("does not flag a param value that is already templated", () => {
    const artifact = baseArtifact();
    artifact.steps[0]!.description = "Search for member ${memberId}";
    expect(codes(artifact)).not.toContain("ungeneralized_param_literal");
  });

  it("flags a param the capability advertises but never uses", () => {
    // The schema validates outputs bidirectionally but params only one way, so
    // nothing else catches a capability lying about its call contract.
    const artifact = baseArtifact();
    artifact.inputParams.push({
      name: "branchCode",
      type: "string",
      required: true,
      sensitive: false,
    });
    expect(codes(artifact)).toContain("param_never_referenced");
  });

  it("notes a param that is used but never asserted", () => {
    const artifact = baseArtifact();
    expect(codes(artifact)).toContain("param_unverified");
  });

  it("clears param_unverified once a checkpoint asserts the param", () => {
    const artifact = baseArtifact();
    artifact.checkpoints.push({
      description: "On the right member's page",
      frame: [],
      locator: [{ strategy: "role", role: "heading", name: "Member:", exact: false, reason: "static chrome prefix" }],
      assertion: "urlMatches",
      expected: "/members/${memberId:regexEscape}$",
    });
    expect(codes(artifact)).not.toContain("param_unverified");
  });

  it("counts a param-derived text assertion as structural", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "Member ${memberId}";
    expect(scoreRecording(artifact).metrics.structuralCheckpoints).toBe(1);
  });

  it("does not count a hardcoded text assertion as structural", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "Member: Jane Smith";
    expect(scoreRecording(artifact).metrics.structuralCheckpoints).toBe(0);
    expect(codes(artifact)).toContain("no_structural_checkpoint");
  });

  it("surfaces a failed differential probe as an error", () => {
    const artifact = baseArtifact();
    const score = scoreRecording(artifact, {
      probe: {
        params: { memberId: "1002" },
        result: {
          status: "hard_failure",
          stepId: "(checkpoint)",
          stepDescription: "Member detail page is open",
          reason: "Checkpoint not met",
        },
      },
    });
    const probeFinding = score.findings.find((f) => f.code === "differential_probe_failed");
    expect(probeFinding?.severity).toBe("error");
    expect(probeFinding?.message).toContain("1002");
  });

  it("stays quiet when the probe succeeds", () => {
    const artifact = baseArtifact();
    const score = scoreRecording(artifact, {
      probe: {
        params: { memberId: "1002" },
        result: { status: "success", outputs: {}, checkpointsPassed: [], stepsExecuted: 3 },
      },
    });
    expect(score.findings.map((f) => f.code)).not.toContain("differential_probe_failed");
  });

  it("notices a consequential click that is not gated as irreversible", () => {
    const artifact = baseArtifact();
    artifact.steps[1] = {
      id: "step-confirm",
      description: "Click the confirm button",
      type: "click",
      frame: [],
      locator: [
        { strategy: "role", role: "button", name: "Confirm & Open Account", exact: false, reason: "the commit button" },
      ],
      retryable: false,
      irreversible: false,
    };
    expect(codes(artifact)).toContain("irreversible_unmarked");
  });

  it("grades down as findings accumulate and never below zero", () => {
    const clean = scoreRecording(baseArtifact()).score;
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "$3482.10";
    const dirty = scoreRecording(artifact, { extractedValues: balance }).score;
    expect(dirty).toBeLessThan(clean);
    expect(dirty).toBeGreaterThanOrEqual(0);
  });
});
