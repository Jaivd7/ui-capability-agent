import { describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../artifact/schema.js";
import { targetsIrreversibleStep } from "./action-policy.js";

/**
 * The flag is a visibility aid, not a gate — an irreversible target is recorded
 * and deliberately not prevented. That is exactly why precision matters: a flag
 * that fires on unrelated fields trains the reader to ignore the one that
 * counts.
 */
const artifact = {
  steps: [
    {
      id: "step-5",
      type: "click",
      irreversible: true,
      locator: [{ strategy: "role", role: "button", name: "Post Transfer" }],
    },
    {
      id: "step-2",
      type: "click",
      irreversible: false,
      locator: [{ strategy: "css", selector: "#continueBtn" }],
    },
  ],
} as unknown as CapabilityArtifact;

describe("targetsIrreversibleStep", () => {
  it("flags a selector naming the irreversible control", () => {
    expect(targetsIrreversibleStep('button[aria-label="Post Transfer"]', artifact)).toBe(true);
  });

  it("does not flag an unrelated field that merely shares letters", () => {
    // The old bidirectional substring match on short recorded text meant a
    // recorded "Post" flagged every one of these.
    for (const target of ["#postcode", "[name=postalCode]", ".compose-post", "#post"]) {
      expect(targetsIrreversibleStep(target, artifact)).toBe(false);
    }
  });

  it("ignores steps that are not marked irreversible", () => {
    expect(targetsIrreversibleStep("#continueBtn", artifact)).toBe(false);
  });

  it("is false with no artifact, no target, or a too-short target", () => {
    expect(targetsIrreversibleStep("#x", artifact)).toBe(false);
    expect(targetsIrreversibleStep("", artifact)).toBe(false);
    expect(targetsIrreversibleStep("anything")).toBe(false);
  });
});
