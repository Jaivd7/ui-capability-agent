import { describe, expect, it } from "vitest";
import { parseArtifact } from "./index.js";
import { computeContentHash } from "./hash.js";
import type { CapabilityArtifact } from "./schema.js";

function baseArtifact(): CapabilityArtifact {
  return {
    schemaVersion: "1.0.0",
    id: "lookup-member-balance",
    name: "Look up member and read savings balance",
    description:
      "Searches for a member by ID and extracts their current savings balance.",
    version: 1,
    contentHash: "placeholder",
    createdAt: "2026-08-13T00:00:00.000Z",
    discovery: { model: "claude-sonnet-5", discoveredAt: "2026-08-13T00:00:00.000Z" },
    target: {
      app: "legacy-core-banking",
      baseUrl: "http://localhost:4000",
      entryRoute: "/members",
      tenant: null,
    },
    preconditions: { authRequired: true, startRoute: "/members" },
    inputParams: [
      { name: "memberId", type: "string", required: true, sensitive: false },
    ],
    outputs: [
      { name: "savingsBalance", type: "currency", sensitive: true },
    ],
    steps: [
      {
        id: "step-1",
        description: "Fill member ID search box",
        type: "fill",
        frame: [],
        locator: [
          {
            strategy: "role",
            role: "textbox",
            name: "Member ID",
            exact: false,
            reason: "stable accessible name, survives markup rewrites",
          },
        ],
        value: { kind: "param", param: "memberId" },
        retryable: false,
        irreversible: false,
      },
      {
        id: "step-2",
        description: "Click search",
        type: "click",
        frame: [],
        locator: [
          { strategy: "role", role: "button", name: "Search", exact: true, reason: "unambiguous accessible name" },
        ],
        retryable: false,
        irreversible: false,
      },
      {
        id: "step-3",
        description: "Extract savings balance from detail panel iframe",
        type: "extract",
        frame: [{ strategy: "name", value: "account-detail" }],
        locator: [
          { strategy: "label", text: "Savings Balance", exact: false, reason: "legacy table has no test id, label text is stable" },
        ],
        outputName: "savingsBalance",
        read: { from: "innerText", transform: "currency" },
        retryable: false,
        irreversible: false,
      },
    ],
    checkpoints: [
      {
        description: "Savings balance panel is visible",
        frame: [{ strategy: "name", value: "account-detail" }],
        locator: [
          { strategy: "label", text: "Savings Balance", exact: false, reason: "confirms detail panel actually loaded" },
        ],
        assertion: "exists",
      },
    ],
    knownOutcomes: [
      {
        id: "member-not-found",
        description: "Search returns no matching member",
        checkAfterStepId: "step-2",
        classification: "business",
        detect: {
          frame: [],
          locator: [{ strategy: "text", text: "No member found", exact: false, reason: "app's literal not-found banner text" }],
        },
        outcome: { code: "MEMBER_NOT_FOUND", message: "No member found with the given ID." },
      },
      {
        id: "session-expired",
        description: "Session timed out mid-flow",
        checkAfterStepId: "step-2",
        classification: "recoverable",
        detect: {
          frame: [],
          locator: [{ strategy: "text", text: "Session expired", exact: false, reason: "app's literal session-timeout banner text" }],
        },
        recovery: { action: "reauth", maxAttempts: 1 },
      },
    ],
  };
}

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
