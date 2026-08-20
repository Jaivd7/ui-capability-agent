import type { CapabilityArtifact, Target } from "../artifact/schema.js";
import type { DiscoveryParam } from "./loop.js";
import type { ParamValue } from "../artifact/template.js";

export interface CapabilityPreset {
  id: string;
  name: string;
  description: string;
  goal: string;
  params: DiscoveryParam[];
  preconditions: CapabilityArtifact["preconditions"];
  knownOutcomes: CapabilityArtifact["knownOutcomes"];
  /**
   * A *different* valid argument set, used for the differential probe: the
   * freshly compiled artifact is replayed with these, with no LLM, on the same
   * live session. Anything that fails is fitted to the recording rather than
   * to the app, since the identical flow passed live seconds earlier.
   *
   * This is the only mechanism that catches a checkpoint asserting page data
   * the compiler cannot recognise as such — a member's *name* is neither a
   * parameter nor an extracted value, so from one recording it is
   * indistinguishable from static page chrome. Deliberately picked to differ
   * in every dimension the capability accepts.
   */
  verifyParams: Record<string, ParamValue>;
}

function target(): Target {
  const port = process.env.MOCK_APP_PORT ?? "4000";
  return {
    app: "legacy-core-banking",
    baseUrl: process.env.MOCK_APP_BASE_URL ?? `http://localhost:${port}`,
    entryRoute: "/members",
    tenant: null,
  };
}

export function resolveTarget(): Target {
  return target();
}

/**
 * knownOutcomes are hand-authored against the mock app's exact, verified
 * banner text/markup (see LEARNING_NOTES.md's Phase 2 entry for why this
 * was chosen over a second LLM-driven exploration episode per error state:
 * these are simple, deterministic "does this literal banner exist"
 * detectors, not something that benefits from LLM judgment, and I can and
 * did verify each one directly against the live app before trusting it).
 */
export const CAPABILITY_PRESETS: Record<string, CapabilityPreset> = {
  "lookup-member-balance": {
    id: "lookup-member-balance",
    name: "Look up member and read savings balance",
    description:
      "Searches for a member by ID in Meridian Core Banking and extracts their current savings balance.",
    // Phrased in terms of the parameter rather than the value. The system
    // prompt supplies "1001" as the value to type; naming it here as well
    // invites the model to treat this member — and their name and balance —
    // as intrinsic to the capability rather than as this run's argument.
    goal: "Search for the member identified by the memberId parameter, open their record, and read their current savings balance from the Account Details panel.",
    params: [
      {
        name: "memberId",
        type: "string",
        exampleValue: "1001",
        sensitive: false,
        description: "Member/account holder ID to search for.",
      },
    ],
    preconditions: { authRequired: true, startRoute: "/members" },
    // A different member, with a different name and a different balance —
    // which is what makes a checkpoint asserting either of those fail.
    verifyParams: { memberId: "1002" },
    knownOutcomes: [
      {
        id: "member-not-found",
        description: "Search returns no matching member record.",
        classification: "business",
        detect: {
          frame: [],
          locator: [
            {
              strategy: "text",
              text: "No member found with that ID.",
              exact: false,
              reason: "Exact banner text rendered by the search results page when no member matches.",
            },
          ],
        },
        outcome: { code: "MEMBER_NOT_FOUND", message: "No member found with the given ID." },
      },
      {
        id: "session-expired",
        description: "The session expired mid-flow and the app redirected to the login page.",
        classification: "recoverable",
        detect: {
          frame: [],
          locator: [
            {
              strategy: "text",
              text: "Your session has expired. Please log in again.",
              exact: false,
              reason: "Exact banner text rendered on the login page after a forced/natural session expiry.",
            },
          ],
        },
        recovery: { action: "reauth", maxAttempts: 1 },
      },
    ],
  },
  "open-sub-account": {
    id: "open-sub-account",
    name: "Open new sub-account and reach confirmation",
    description:
      "Searches for a member, opens a new sub-account of the given type and opening deposit, and stops at the confirmation screen without submitting.",
    goal:
      'Search for the member identified by the memberId parameter, open their record, then open a new sub-account for them using the accountType and openingDeposit parameters, and reach the confirmation screen. Do not click "Confirm & Open Account" — stop once the confirmation screen showing "Review Sub-Account Details" is visible.',
    params: [
      {
        name: "memberId",
        type: "string",
        exampleValue: "1001",
        sensitive: false,
        description: "Member/account holder ID to open a sub-account for.",
      },
      {
        name: "accountType",
        type: "string",
        exampleValue: "Standard Savings",
        sensitive: false,
        description: "Sub-account type: Youth Savings, Holiday Club, or Standard Savings.",
      },
      {
        name: "openingDeposit",
        type: "currency",
        exampleValue: "100",
        sensitive: false,
        description: "Opening deposit amount in dollars (minimum $25.00).",
      },
    ],
    preconditions: { authRequired: true, startRoute: "/members", requiredRole: "teller" },
    // 1500 rather than a round 250 on purpose: the app renders
    // `$${n.toFixed(2)}` with no thousands separator, so this is also the
    // probe that would catch a currency formatter that groups.
    verifyParams: { memberId: "1003", accountType: "Holiday Club", openingDeposit: 1500 },
    knownOutcomes: [
      {
        id: "member-not-found",
        description: "Search returns no matching member record.",
        classification: "business",
        detect: {
          frame: [],
          locator: [
            {
              strategy: "text",
              text: "No member found with that ID.",
              exact: false,
              reason: "Exact banner text rendered by the search results page when no member matches.",
            },
          ],
        },
        outcome: { code: "MEMBER_NOT_FOUND", message: "No member found with the given ID." },
      },
      {
        id: "insufficient-deposit",
        description: "The requested opening deposit is below the $25.00 minimum.",
        classification: "business",
        detect: {
          frame: [],
          locator: [
            {
              strategy: "text",
              text: "Opening deposit must be at least $25.00.",
              exact: false,
              reason: "Exact validation banner text rendered by the sub-account form on invalid deposit amount.",
            },
          ],
        },
        outcome: {
          code: "INSUFFICIENT_DEPOSIT",
          message: "Opening deposit is below the $25.00 minimum; no sub-account form was advanced.",
        },
      },
      {
        // Two locator candidates, not one: the mock app gates this two
        // ways. The member-detail page never renders the "Open Sub-Account"
        // link for a non-teller session (so a replaying flow hits this
        // first, at the step that would click that link), and the
        // /sub-account/new route itself also denies non-teller sessions
        // directly. Found by testing a readonly-role replay and watching it
        // hard-fail at the link-click step instead of reaching the route-
        // level text — see LEARNING_NOTES.md's Phase 3 entry. Both
        // candidates are checked in order; either is conclusive evidence of
        // the same underlying condition, so this reuses the locator chain's
        // ordinary fallback mechanism as an OR across detection signals.
        id: "permission-denied",
        description: "The authenticated session does not have the teller role required to open a sub-account.",
        classification: "business",
        detect: {
          frame: [],
          locator: [
            {
              strategy: "text",
              text: "Sub-account actions require teller role.",
              exact: false,
              reason: "UI-level signal: replaces the Open Sub-Account link on the member detail page for non-teller sessions.",
            },
            {
              strategy: "text",
              text: "Permission denied: your role does not permit this action.",
              exact: false,
              reason: "Route-level signal: exact banner text rendered by the role-gated sub-account route for a session that reached it directly.",
            },
          ],
        },
        outcome: {
          code: "PERMISSION_DENIED",
          message: "The current session's role does not permit opening a sub-account.",
        },
      },
    ],
  },
};
