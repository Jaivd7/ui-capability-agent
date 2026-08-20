import { describe, expect, it } from "vitest";
import { baseArtifact } from "../artifact/test-fixtures.js";
import { TemplateError } from "../artifact/template.js";
import { materializeArtifact } from "./materialize.js";

describe("materializeArtifact", () => {
  it("leaves a template-free artifact byte-identical", () => {
    // Every artifact recorded before this change contains no `${}`, so
    // materialization must be a pure deep copy for them — this is what makes
    // introducing the template layer a behaviour-neutral change.
    const artifact = baseArtifact();
    expect(materializeArtifact(artifact, { memberId: "1001" })).toEqual(artifact);
  });

  it("substitutes a checkpoint's expected value", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "urlMatches";
    artifact.checkpoints[0]!.expected = "/members/${memberId}$";
    const out = materializeArtifact(artifact, { memberId: "1002" });
    expect(out.checkpoints[0]!.expected).toBe("/members/1002$");
  });

  it("substitutes a locator's accessible name", () => {
    const artifact = baseArtifact();
    const candidate = artifact.checkpoints[0]!.locator[0]!;
    if (candidate.strategy !== "label") throw new Error("fixture changed");
    candidate.text = "Balance for ${memberId}";
    const out = materializeArtifact(artifact, { memberId: "1002" });
    const resolved = out.checkpoints[0]!.locator[0]!;
    expect(resolved.strategy === "label" && resolved.text).toBe("Balance for 1002");
  });

  it("substitutes a navigate urlTemplate", () => {
    const artifact = baseArtifact();
    artifact.steps[1] = {
      id: "step-nav",
      description: "Go to member",
      type: "navigate",
      urlTemplate: "/members/${memberId}",
      retryable: false,
      irreversible: false,
    };
    const out = materializeArtifact(artifact, { memberId: "1003" });
    const step = out.steps[1]!;
    expect(step.type === "navigate" && step.urlTemplate).toBe("/members/1003");
  });

  it("substitutes step descriptions", () => {
    const artifact = baseArtifact();
    artifact.steps[0]!.description = "Search for member ${memberId}";
    const out = materializeArtifact(artifact, { memberId: "1002" });
    expect(out.steps[0]!.description).toBe("Search for member 1002");
  });

  it("substitutes knownOutcome detector locators", () => {
    // A site that is validated but not materialized would leave a live `${x}`
    // in a detector — a silently-never-matching condition rather than a loud
    // failure. Detectors are on the same walk for exactly that reason.
    const artifact = baseArtifact();
    const candidate = artifact.knownOutcomes[0]!.detect.locator[0]!;
    if (candidate.strategy !== "text") throw new Error("fixture changed");
    candidate.text = "No member found with ID ${memberId}";
    const out = materializeArtifact(artifact, { memberId: "99999" });
    const resolved = out.knownOutcomes[0]!.detect.locator[0]!;
    expect(resolved.strategy === "text" && resolved.text).toBe("No member found with ID 99999");
  });

  it("substitutes iframe frame values", () => {
    const artifact = baseArtifact();
    artifact.steps[2]!.type === "extract";
    const step = artifact.steps[2]!;
    if (step.type !== "extract") throw new Error("fixture changed");
    step.frame = [{ strategy: "name", value: "panel-${memberId}" }];
    const out = materializeArtifact(artifact, { memberId: "1001" });
    const outStep = out.steps[2]!;
    if (outStep.type !== "extract") throw new Error("unexpected");
    expect(outStep.frame[0]).toEqual({ strategy: "name", value: "panel-1001" });
  });

  it("throws before touching the browser when a param has no value", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.description = "State for ${unsupplied}";
    expect(() => materializeArtifact(artifact, {})).toThrow(TemplateError);
  });

  it("names the offending site in the failure", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.description = "State for ${unsupplied}";
    expect(() => materializeArtifact(artifact, {})).toThrow(/checkpoints\[0\]\.description/);
  });

  it("rejects a substitution that makes a urlMatches pattern invalid", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "urlMatches";
    artifact.checkpoints[0]!.expected = "/members/${memberId}$";
    expect(() => materializeArtifact(artifact, { memberId: "100)" })).toThrow(
      /invalid urlMatches pattern/,
    );
  });

  it("accepts the same value via :regexEscape", () => {
    const artifact = baseArtifact();
    artifact.checkpoints[0]!.assertion = "urlMatches";
    artifact.checkpoints[0]!.expected = "/members/${memberId:regexEscape}$";
    const out = materializeArtifact(artifact, { memberId: "100)" });
    expect(out.checkpoints[0]!.expected).toBe("/members/100\\)$");
  });

  it("renders a currency param into a textMatches-free exists locator", () => {
    const artifact = baseArtifact();
    artifact.inputParams.push({
      name: "openingDeposit",
      type: "currency",
      required: true,
      sensitive: false,
    });
    const candidate = artifact.checkpoints[0]!.locator[0]!;
    if (candidate.strategy !== "label") throw new Error("fixture changed");
    candidate.text = "${openingDeposit:currency}";
    const out = materializeArtifact(artifact, { memberId: "1001", openingDeposit: 1500 });
    const resolved = out.checkpoints[0]!.locator[0]!;
    expect(resolved.strategy === "label" && resolved.text).toBe("$1500.00");
  });
});
