import { describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../artifact/schema.js";
import { sensitiveParamValues } from "./index.js";

/**
 * `meridian-update-member-contact` is the real motivation: e-mail, phone and
 * address are all declared sensitive, and it is exactly the capability where an
 * operator recovering a failed run would retype one into the live form.
 */
const artifact = {
  inputParams: [
    { name: "memberId", type: "string", required: true, sensitive: false },
    { name: "email", type: "string", required: true, sensitive: true },
    { name: "phone", type: "string", required: true, sensitive: true },
    { name: "pin", type: "number", required: false, sensitive: true },
  ],
} as unknown as CapabilityArtifact;

describe("sensitiveParamValues", () => {
  it("collects the values of params the artifact marks sensitive", () => {
    expect(
      sensitiveParamValues(artifact, {
        memberId: "101555",
        email: "alan.turing@example.com",
        phone: "555-0102",
      }),
    ).toEqual(["alan.turing@example.com", "555-0102"]);
  });

  it("leaves non-sensitive params out, so a member id stays readable in the log", () => {
    expect(sensitiveParamValues(artifact, { memberId: "101555" })).toEqual([]);
  });

  it("keeps finite numbers and skips blanks, absent values and non-finite ones", () => {
    expect(sensitiveParamValues(artifact, { email: "", phone: undefined, pin: 1234 })).toEqual([1234]);
    expect(sensitiveParamValues(artifact, { pin: Number.NaN })).toEqual([]);
  });

  it("returns empty for discovery, which has no artifact yet", () => {
    expect(sensitiveParamValues(undefined, { email: "x@y.z" })).toEqual([]);
    expect(sensitiveParamValues(artifact, undefined)).toEqual([]);
  });
});
