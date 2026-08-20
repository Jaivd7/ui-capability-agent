import { describe, expect, it } from "vitest";
import type { CheckpointCondition, Step, Target } from "../artifact/schema.js";
import { buildArtifact } from "./build-artifact.js";
import type { DiscoveryParam, DiscoveryResult } from "./loop.js";

const target: Target = {
  app: "legacy-core-banking",
  baseUrl: "http://localhost:4000",
  entryRoute: "/members",
  tenant: null,
};

const params: DiscoveryParam[] = [
  { name: "memberId", type: "string", exampleValue: "1001", sensitive: false },
];

function clickStep(id: string, description: string, name: string, irreversible = false): Step {
  return {
    id,
    description,
    type: "click",
    frame: [],
    locator: [{ strategy: "role", role: "button", name, exact: false, reason: "the button's accessible name" }],
    retryable: false,
    irreversible,
  };
}

const checkpoint: CheckpointCondition = {
  description: "Reached the confirmation screen",
  frame: [],
  locator: [{ strategy: "role", role: "heading", name: "Review", exact: false, reason: "static heading" }],
  assertion: "exists",
};

function discoveryResult(steps: Step[]): DiscoveryResult {
  return {
    outcome: "success",
    reason: "done",
    steps,
    checkpoints: [checkpoint],
    outputs: [],
    transcript: [],
    model: "claude-sonnet-5",
    extractedValues: {},
  };
}

function build(steps: Step[], irreversibleStepLabels?: string[]) {
  return buildArtifact({
    id: "test-capability",
    name: "Test",
    description: "Test capability",
    version: 1,
    target,
    preconditions: { authRequired: true },
    params,
    discoveryResult: discoveryResult(steps),
    ...(irreversibleStepLabels ? { irreversibleStepLabels } : {}),
  }).artifact;
}

describe("irreversible marking", () => {
  it("keeps what the model said", () => {
    // The model is the one looking at the button, so its judgement is the
    // primary signal — this used to be hardcoded false on every step, which
    // made the guardrail unreachable for any machine-produced artifact.
    const artifact = build([clickStep("step-1", "Post the transfer", "Post Transfer", true)]);
    expect(artifact.steps[0]!.irreversible).toBe(true);
  });

  it("forces the flag on a preset-named button the model left unmarked", () => {
    const artifact = build([clickStep("step-1", "Post the transfer", "Post Transfer")], ["Post Transfer"]);
    expect(artifact.steps[0]!.irreversible).toBe(true);
  });

  it("matches the label case-insensitively and against the description too", () => {
    const artifact = build([clickStep("step-1", "Apply the hold", "Continue")], ["apply the hold"]);
    expect(artifact.steps[0]!.irreversible).toBe(true);
  });

  it("leaves unrelated clicks alone", () => {
    const artifact = build(
      [clickStep("step-1", "Open the member record", "Select"), clickStep("step-2", "Post", "Post Transfer")],
      ["Post Transfer"],
    );
    expect(artifact.steps.map((s) => s.irreversible)).toEqual([false, true]);
  });

  it("never marks a non-click step", () => {
    const fill: Step = {
      id: "step-1",
      description: "Type the amount to post",
      type: "fill",
      frame: [],
      locator: [{ strategy: "css", selector: '[name="amount"]', reason: "form field name" }],
      value: { kind: "literal", value: "100" },
      retryable: false,
      irreversible: false,
    };
    const artifact = build([fill, clickStep("step-2", "Post", "Post Transfer")], ["post"]);
    expect(artifact.steps[0]!.irreversible).toBe(false);
  });
});
