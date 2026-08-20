import { describe, expect, it } from "vitest";
import { parseArtifact } from "./index.js";
import { computeContentHash } from "./hash.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import { baseArtifact } from "./test-fixtures.js";

describe("CapabilityArtifactSchema", () => {
  it("accepts a well-formed artifact", () => {
    const artifact = baseArtifact();
    artifact.contentHash = computeContentHash(artifact);
    const result = parseArtifact(artifact);
    expect(result.success).toBe(true);
  });

  it("rejects duplicate step ids", () => {
    const artifact = baseArtifact();
    artifact.steps[1]!.id = "step-1";
    const result = parseArtifact(artifact);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes("duplicate step id"))).toBe(true);
    }
  });

  it("rejects a value referencing an unknown param", () => {
    const artifact = baseArtifact();
    const fillStep = artifact.steps[0]!;
    if (fillStep.type === "fill") {
      fillStep.value = { kind: "param", param: "nonexistentParam" };
    }
    const result = parseArtifact(artifact);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes("unknown param"))).toBe(true);
    }
  });

  it("rejects an extract step producing an undeclared output", () => {
    const artifact = baseArtifact();
    const extractStep = artifact.steps[2]!;
    if (extractStep.type === "extract") {
      extractStep.outputName = "somethingElse";
    }
    const result = parseArtifact(artifact);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes("undeclared output"))).toBe(true);
    }
  });

  it("rejects a declared output that's never produced", () => {
    const artifact = baseArtifact();
    artifact.outputs.push({ name: "unproduced", type: "string", sensitive: false });
    const result = parseArtifact(artifact);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes("never produced"))).toBe(true);
    }
  });

  it("rejects a knownOutcome referencing an unknown step", () => {
    const artifact = baseArtifact();
    artifact.knownOutcomes[0]!.checkAfterStepId = "step-99";
    const result = parseArtifact(artifact);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes("unknown step"))).toBe(true);
    }
  });

  it("rejects a checkpoint assertion missing its required 'expected' field", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textEquals";
    const result = parseArtifact(artifact);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes('requires "expected"'))).toBe(true);
    }
  });

  it("computeContentHash is stable across field reordering and independent of instance-specific fields", () => {
    const a = baseArtifact();
    const b = { ...baseArtifact(), id: "different-id", name: "Different name", version: 2 };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it("computeContentHash ignores a locator's reason", () => {
    // `reason` is prose for a human reviewer. A re-recording that words it
    // differently is a byte-identical automaton, and reporting that as drift
    // is the fastest way to teach people to ignore the drift signal.
    const a = baseArtifact();
    const b = baseArtifact();
    const step = b.steps[0]!;
    if (step.type === "navigate") throw new Error("fixture changed");
    step.locator[0]!.reason = "a completely different explanation of the same locator";
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it("computeContentHash ignores descriptions", () => {
    const a = baseArtifact();
    const b = baseArtifact();
    b.steps[0]!.description = "Reworded step description";
    b.checkpoints[0]!.description = "Reworded checkpoint description";
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it("computeContentHash changes when requiredRole changes", () => {
    // Previously invisible: preconditions were excluded entirely, so a
    // security-relevant edit produced an identical fingerprint.
    const a = baseArtifact();
    const b = baseArtifact();
    b.preconditions = { ...b.preconditions, requiredRole: "admin" };
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it("computeContentHash changes when startRoute changes", () => {
    const a = baseArtifact();
    const b = baseArtifact();
    b.preconditions = { ...b.preconditions, startRoute: "/somewhere-else" };
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it("computeContentHash still tracks a business outcome's caller-facing message", () => {
    // `message` is contract, not commentary — unlike `description`.
    const a = baseArtifact();
    const b = baseArtifact();
    const outcome = b.knownOutcomes[0]!;
    if (outcome.classification !== "business") throw new Error("fixture changed");
    outcome.outcome.message = "A different message the caller would see";
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it("computeContentHash changes when a step's locator changes", () => {
    const a = baseArtifact();
    const b = baseArtifact();
    const bStep = b.steps[0]!;
    if (bStep.type === "fill") {
      bStep.locator[0] = { strategy: "css", selector: "#memberId", reason: "changed for test" };
    }
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
});

describe("template site validation", () => {
  function expectRejected(artifact: ReturnType<typeof baseArtifact>, needle: string) {
    const result = parseArtifact(artifact);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes(needle))).toBe(true);
    }
  }

  it("accepts the current schema version", () => {
    const artifact = baseArtifact();
    artifact.schemaVersion = CURRENT_SCHEMA_VERSION;
    expect(parseArtifact(artifact).success).toBe(true);
  });

  it("still accepts 1.0.0 artifacts", () => {
    const artifact = baseArtifact();
    artifact.schemaVersion = "1.0.0";
    expect(parseArtifact(artifact).success).toBe(true);
  });

  it("rejects a checkpoint expected referencing an unknown param", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textContains";
    artifact.checkpoints[0]!.expected = "Member ${nope}";
    expectRejected(artifact, 'references unknown param "nope"');
  });

  it("rejects a locator string referencing an unknown param", () => {
    const artifact = baseArtifact();
    const candidate = artifact.checkpoints[0]!.locator[0]!;
    if (candidate.strategy !== "label") throw new Error("fixture changed");
    candidate.text = "Balance for ${nope}";
    expectRejected(artifact, "checkpoints[0].locator[0].text");
  });

  it("rejects an unknown template format", () => {
    const artifact = baseArtifact();
    artifact.steps[0]!.description = "Search for ${memberId:bogus}";
    expectRejected(artifact, 'unknown template format "bogus"');
  });

  it("rejects a sensitive param used at a locator site", () => {
    // A sensitive value in a locator surfaces in LocatorResolutionError's
    // message, and from there in the run log and the failure evidence.
    const artifact = baseArtifact();
    artifact.inputParams[0]!.sensitive = true;
    const candidate = artifact.checkpoints[0]!.locator[0]!;
    if (candidate.strategy !== "label") throw new Error("fixture changed");
    candidate.text = "Balance for ${memberId}";
    expectRejected(artifact, "sensitive param");
  });

  it("still allows a sensitive param as a fill value", () => {
    const artifact = baseArtifact();
    artifact.inputParams[0]!.sensitive = true;
    expect(parseArtifact(artifact).success).toBe(true);
  });

  it("rejects an optional param at a template site", () => {
    // Materialization throws on a missing value, so an optional param in a
    // template means a well-formed call could still fail mid-flow.
    const artifact = baseArtifact();
    artifact.inputParams[0]!.required = false;
    artifact.steps[0]!.description = "Search for ${memberId}";
    expectRejected(artifact, "optional param");
  });

  it("requires expected on a textMatches checkpoint", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textMatches";
    expectRejected(artifact, 'requires "expected"');
  });

  it("accepts a well-formed textMatches checkpoint", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "textMatches";
    artifact.checkpoints[0]!.expected = "^\\$[0-9,]+\\.[0-9]{2}$";
    expect(parseArtifact(artifact).success).toBe(true);
  });
});
