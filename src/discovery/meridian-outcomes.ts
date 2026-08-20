import type { CapabilityArtifact } from "../artifact/schema.js";

type KnownOutcome = CapabilityArtifact["knownOutcomes"][number];

/**
 * MERIDIAN CORE's error taxonomy, authored once and composed into each
 * capability rather than copied into seven presets.
 *
 * Detectors key off *rendered text*, not off the app's `?inject=<kind>`
 * backdoor. The backdoor is how each of these was verified quickly and
 * reliably, and it is a testing convenience that would not exist against real
 * production infrastructure — but nothing here depends on it, which is the
 * property that matters.
 *
 * Composed per capability rather than applied wholesale because detectors are
 * probed after *every* step. Handing a three-step read capability the two
 * transaction-rejection detectors it can never trigger is pure latency.
 */

/**
 * Session timeout. The only injected fault that actually invalidates the
 * session — the other five leave it intact, so this is the only one that needs
 * to re-authenticate.
 *
 * Two candidates because there are two ways to observe it: the branded 440
 * page when it happens mid-request, and a bare redirect to the sign-on form
 * when a later request finds the session already gone. The operator field
 * exists only on that form, which makes it an unambiguous second signal.
 */
const SESSION_EXPIRED: KnownOutcome = {
  id: "session-expired",
  description: "The operator session ended (idle timeout or forced expiry) and the host returned to sign-on.",
  classification: "recoverable",
  detect: {
    frame: [],
    locator: [
      {
        strategy: "text",
        text: "YOUR SESSION HAS TIMED OUT",
        exact: false,
        reason: "Branded 440 session-ended page rendered when the timeout happens on this request.",
      },
      {
        strategy: "css",
        selector: 'input[name="operator"]',
        reason: "The sign-on form's operator field, which exists on no other page — the signal when a later request finds the session already gone.",
      },
    ],
  },
  recovery: { action: "reauth", maxAttempts: 1 },
};

const MAINTENANCE: KnownOutcome = {
  id: "maintenance-interstitial",
  description: "The host is briefly unavailable behind a scheduled-maintenance interstitial.",
  classification: "recoverable",
  detect: {
    frame: [],
    locator: [
      {
        strategy: "text",
        text: "SCHEDULED MAINTENANCE IN PROGRESS",
        exact: false,
        reason: "Exact header text of the 503 maintenance interstitial.",
      },
    ],
  },
  recovery: { action: "dismissAndRetry", maxAttempts: 2 },
};

/**
 * Application error. Modelled as transient because the app presents it that way
 * ("Please contact the Help Desk if the problem persists"), so it is worth a
 * backed-off retry before giving up — and if the retries exhaust, the existing
 * hard-failure path already offers escalation with no new mechanism.
 *
 * The detector matches the prose, not the `ERR-XXXXXXXX` reference, which is
 * random per occurrence.
 */
const SERVER_ERROR: KnownOutcome = {
  id: "server-error",
  description: "The host returned an unexpected application error.",
  classification: "recoverable",
  detect: {
    frame: [],
    locator: [
      {
        strategy: "text",
        text: "unexpected error occurred while processing your request",
        exact: false,
        reason: "Stable prose of the 500 error page; the ERR-xxxxxxxx reference beside it is random per occurrence.",
      },
    ],
  },
  recovery: { action: "reloadAndRetry", maxAttempts: 2 },
};

/**
 * Not found has two distinct shapes on this app: navigating straight to a
 * missing record gives a 404 page, while a *search* that matches nothing
 * returns 200 with an inline notice. Same outcome to a caller, two candidates
 * in one chain — which is the locator chain being used as an OR across
 * detection signals rather than as a fallback.
 */
const MEMBER_NOT_FOUND: KnownOutcome = {
  id: "member-not-found",
  description: "No member record matches the supplied identifier.",
  classification: "business",
  detect: {
    frame: [],
    locator: [
      {
        strategy: "text",
        text: "RECORD NOT FOUND",
        exact: false,
        reason: "Header of the 404 page returned when a member record is addressed directly.",
      },
      {
        strategy: "text",
        text: "No member records matched your search.",
        exact: false,
        reason: "Inline notice on the 200 search-results page when nothing matched.",
      },
    ],
  },
  outcome: { code: "MEMBER_NOT_FOUND", message: "No member record matches the supplied identifier." },
};

/**
 * The obvious detector string here — "SUPERVISOR OVERRIDE REQUIRED" — is a
 * trap. The Place Hold form renders it as a *static warning* for a teller on a
 * perfectly healthy page, so a detector keyed on it fires before anything has
 * gone wrong. The sentence below appears only on the actual 403.
 */
const PERMISSION_DENIED: KnownOutcome = {
  id: "permission-denied",
  description: "The signed-on operator's role does not permit this function.",
  classification: "business",
  detect: {
    frame: [],
    locator: [
      {
        strategy: "text",
        text: "is not authorized to perform this function",
        exact: false,
        reason:
          'Body text of the 403 page. Deliberately not "SUPERVISOR OVERRIDE REQUIRED", which also appears as a static warning on the healthy Place Hold form.',
      },
    ],
  },
  outcome: {
    code: "PERMISSION_DENIED",
    message: "The signed-on operator is not authorized to perform this function; a supervisor must complete it.",
  },
};

/**
 * Declared *before* the generic rejection below, because business outcomes
 * short-circuit on first match and the specific case would otherwise be
 * swallowed by the general one.
 */
const INSUFFICIENT_FUNDS: KnownOutcome = {
  id: "insufficient-funds",
  description: "The source share does not have the available balance for this transfer.",
  classification: "business",
  detect: {
    frame: [],
    locator: [
      {
        strategy: "text",
        text: "Insufficient available balance in the source share.",
        exact: false,
        reason: "Exact validation message listed by the transfer form when the amount exceeds the source balance.",
      },
    ],
  },
  outcome: {
    code: "INSUFFICIENT_FUNDS",
    message: "The source share does not have sufficient available balance; no transfer was posted.",
  },
};

/**
 * A hold on the source share blocks a debit.
 *
 * Found by a discovery run rather than by reading the brief: member 100234's
 * S0001 is the share the seed data ships already on HOLD, and transferring
 * from it fails with this message. It is caught by the generic rejection
 * below, but a caller can act on "this share is frozen" in a way they cannot
 * act on "rejected", so it earns its own code.
 */
const SHARE_ON_HOLD: KnownOutcome = {
  id: "share-on-hold",
  description: "The source share carries a hold and cannot be debited.",
  classification: "business",
  detect: {
    frame: [],
    locator: [
      {
        strategy: "text",
        text: "cannot be debited",
        exact: false,
        reason: "Validation message listed by the transfer form when the source share is on hold.",
      },
    ],
  },
  outcome: {
    code: "SHARE_ON_HOLD",
    message: "The source share carries a hold and cannot be debited; no transfer was posted.",
  },
};

/**
 * The generic field/transaction rejection. Note this is *also* what a stale
 * per-transaction token produces — the two render identical markup, so they are
 * genuinely indistinguishable from the page. That is a second reason not to
 * hand-manage the token: a browser submits the form's own hidden field, so the
 * failure mode simply cannot arise.
 */
const VALIDATION_REJECTED: KnownOutcome = {
  id: "validation-rejected",
  description: "The host rejected the submitted field values.",
  classification: "business",
  detect: {
    frame: [],
    locator: [
      {
        strategy: "text",
        text: "TRANSACTION REJECTED",
        exact: false,
        reason: "Header of the 400 rejection page.",
      },
      {
        strategy: "text",
        text: "could not be validated",
        exact: false,
        reason: "Lead-in to the inline field-error list a form redisplays on invalid input.",
      },
      {
        strategy: "text",
        text: "Please correct the following:",
        exact: false,
        reason: "Lead-in used specifically by the member-information form's validation errors.",
      },
    ],
  },
  outcome: {
    code: "VALIDATION_REJECTED",
    message: "The host rejected the submitted values; nothing was committed.",
  },
};

/**
 * A last-name search matching more than one member.
 *
 * Detected structurally — a second "Select" link in the results table — because
 * the capability's contract returns one member and cannot express a result set
 * (`ParamTypeSchema` has no list type). Surfacing that as a named business
 * outcome is more honest than silently taking the first row, which is exactly
 * the ambiguity `requireUnique` was added to eliminate.
 */
const MULTIPLE_MATCHES: KnownOutcome = {
  id: "multiple-matches",
  description: "The search matched more than one member, so no single record could be selected.",
  classification: "business",
  detect: {
    frame: [],
    locator: [
      {
        strategy: "css",
        selector: ':nth-match(a:text-is("Select"), 2)',
        reason: "A second Select link in the results table means the search was not unique.",
      },
    ],
  },
  outcome: {
    code: "MULTIPLE_MATCHES",
    message: "More than one member matched; narrow the search or use the member number.",
  },
};

export interface OutcomeOptions {
  /** Capability searches by name and can therefore match several members. */
  search?: boolean;
  /** Capability submits a transaction that the host can reject or refuse for funds. */
  transactional?: boolean;
  /** Capability moves money out of a share. */
  funds?: boolean;
}

export function meridianOutcomes(opts: OutcomeOptions = {}): KnownOutcome[] {
  const outcomes: KnownOutcome[] = [SESSION_EXPIRED, MAINTENANCE, SERVER_ERROR, MEMBER_NOT_FOUND, PERMISSION_DENIED];
  if (opts.search) outcomes.push(MULTIPLE_MATCHES);
  // Order matters: the specific funds case must precede the generic rejection,
  // or the first match wins and reports the wrong code.
  if (opts.funds) outcomes.push(INSUFFICIENT_FUNDS, SHARE_ON_HOLD);
  if (opts.transactional) outcomes.push(VALIDATION_REJECTED);
  return outcomes;
}
