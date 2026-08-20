import type { CapabilityArtifact } from "./schema.js";

/**
 * A well-formed artifact used as the starting point for schema, template and
 * materialization tests. Shared rather than copied so a schema change breaks
 * one fixture instead of drifting silently across several.
 */
export function baseArtifact(): CapabilityArtifact {
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
