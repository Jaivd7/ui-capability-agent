import type { CapabilityPreset } from "./capability-presets.js";
import { meridianOutcomes } from "./meridian-outcomes.js";

/**
 * The seven capabilities covering MERIDIAN CORE's function surface.
 *
 * Sign-on is listed as an eighth function in the brief and is deliberately
 * *not* a recorded capability: it is the app adapter (src/apps/meridian-core.ts).
 * Recording it would put credentials into the model's context and into a
 * committed artifact, which is the one thing the login design exists to prevent
 * by construction rather than by redaction.
 *
 * Goals name *parameters* rather than concrete values wherever possible. The
 * param block in the system prompt supplies the value to type; naming it in the
 * goal as well invites the model to treat one member's data as intrinsic to the
 * capability, which is how the original recordings ended up asserting a
 * specific member's name in a checkpoint.
 */

const MEMBER = "100234";
/**
 * A member with two large, OPEN shares, used wherever a capability needs to
 * move money. The obvious default (100234) is the one the seed data ships with
 * a hold on its Regular Shares, so a transfer *from* it is refused by the host
 * — which a discovery run duly discovered by being refused. The app is shared
 * and other people's runs accumulate holds and new shares in it, so a
 * capability that mutates state should not assume a pristine member.
 */
const TRANSFER_MEMBER = "103001";

/**
 * `verifyParams` drives the differential probe: the freshly compiled artifact
 * is replayed with a *different* argument set to catch checkpoints fitted to
 * the recording. It is omitted on the three mutating capabilities, because the
 * probe would run a second real transaction against a shared, stateful app on
 * every recording — a second transfer, an extra share, a second held account.
 * The skip is recorded in the quality report so a missing verification is
 * visible rather than silently absent. That costs us the strongest over-fit
 * check on exactly the capabilities that matter most, which is the price of the
 * target being live and shared.
 */
export const MERIDIAN_PRESETS: Record<string, CapabilityPreset> = {
  "meridian-find-member-by-number": {
    id: "meridian-find-member-by-number",
    app: "meridian-core",
    name: "Find member by member number",
    description:
      "Looks up a member by their member number in MERIDIAN CORE, returning the member number, name and share count shown on the inquiry results row.",
    goal:
      "From the main menu, go to Member Inquiry. Make sure the search mode is Member Number, search for the member identified by the memberId parameter, and stay on the search results page. The results table has the columns Member No., Name and Shares. From the row for that member, extract the Member No. cell as memberId (a string), the Name cell as memberName (a string), and the Shares cell as shareCount (a number). Anchor the row on the memberId parameter — the Member No. cell holds exactly that value — rather than on its position in the table. Include a checkpoint asserting that the results row's Member No. cell holds the member number you searched for. Assert the concrete value, exactly as you would any other assertion — do not write a ${...} placeholder yourself; recorded literals are parameterised afterwards by the compiler. Note the distinction that makes this safe: the member number is a caller-supplied parameter, not something discovered on the page, so the rule against asserting values you read off the page does not apply to it. This capability's whole job is finding the right member, so landing on the wrong one must fail rather than pass. Do not click Select: everything this capability returns is on the results page, and opening the record would add steps that can fail for no benefit. Mark memberName sensitive because it is personal data, and mark memberId and shareCount not sensitive — the member number is this system's lookup key and is already declared a non-sensitive input everywhere else, so redacting it as an output would be inconsistent with the contract it is read from.",
    params: [
      {
        name: "memberId",
        type: "string",
        exampleValue: MEMBER,
        sensitive: false,
        description: "Member number to search for.",
      },
    ],
    preconditions: { authRequired: true, startRoute: "/menu" },
    verifyParams: { memberId: "101555" },
    knownOutcomes: meridianOutcomes(),
  },

  "meridian-find-member-by-name": {
    id: "meridian-find-member-by-name",
    app: "meridian-core",
    name: "Find member by last name",
    description:
      "Looks up a member by last name in MERIDIAN CORE, returning the member number, name and share count shown on the inquiry results row. Reports MULTIPLE_MATCHES if the search is not unique.",
    goal:
      "From the main menu, go to Member Inquiry. Change the search mode to Last Name, search for the value given by the lastName parameter, and stay on the search results page. The results table has the columns Member No., Name and Shares. From the matching row, extract the Member No. cell as memberId (a string), the Name cell as memberName (a string), and the Shares cell as shareCount (a number). Anchor the row on the *text* of its Name cell, which is rendered \"Surname, Forename\" and so begins with the lastName parameter: write the predicate with normalize-space(text()), for example //tr[td[starts-with(normalize-space(text()), \"${lastName},\")]]/td[N]. Do not identify the row with an indexed predicate such as td[2] or count(td)=4, and do not use contains(., ...) — a row found by position rather than by content is recorded as brittle and fails the recording score. Include a checkpoint asserting that the Name cell contains the lastName that was searched for: this capability's whole job is finding the right member, so landing on the wrong one must fail rather than pass. Do not click Select: everything this capability returns is on the results page. Mark memberName sensitive because it is personal data, and mark memberId and shareCount not sensitive — the member number is this system's lookup key and is already declared a non-sensitive input everywhere else, so redacting it as an output would be inconsistent with the contract it is read from. Note that every extract you perform is recorded as a step even if you immediately redo it — there is no undo — so a locator naming the member number you just read off the page fails the compile for the whole recording, however quickly you correct it afterwards. Anchor on the lastName parameter the first time.",
    params: [
      {
        name: "lastName",
        type: "string",
        exampleValue: "Lovelace",
        sensitive: false,
        description: "Member surname, or part of it, to search for.",
      },
    ],
    preconditions: { authRequired: true, startRoute: "/menu" },
    verifyParams: { lastName: "Hopper" },
    knownOutcomes: meridianOutcomes({ search: true }),
  },

  "meridian-read-member-record": {
    id: "meridian-read-member-record",
    app: "meridian-core",
    name: "Read member record",
    description:
      "Reads a member's name and contact details, plus every share they hold (id, type, balance and status) as a single table. Pairs with the update-contact capability, which needs those current values.",
    goal:
      "Navigate directly to the member record page for the member identified by the memberId parameter (the URL is /members/ followed by that member number). Extract the member's full name as memberName, their e-mail address as email, their phone number as phone, and their mailing address as address. Then extract the whole SHARES / BALANCES table as a single string output named shares, marked sensitive because it contains balances: read the text of the table element itself in ONE extract step, not cell by cell, because the number of shares differs from member to member and per-cell steps would record one member's share count as the recipe. Anchor that table on its own \"Share ID\" column heading; the page nests tables inside a layout table, so check the locator matches the shares table alone and not an ancestor.",
    params: [
      { name: "memberId", type: "string", exampleValue: MEMBER, sensitive: false, description: "Member number." },
    ],
    preconditions: { authRequired: true, startRoute: "/menu" },
    verifyParams: { memberId: "101555" },
    knownOutcomes: meridianOutcomes(),
  },

  /**
   * Split out from the record read rather than folded into it.
   *
   * The two were one capability with a required `shareCode`, on the grounds
   * that §2.1 lists "Member record / balance" as a single function. That was
   * fitting the contract to my own constraint (no list output type, so only
   * one share can be read) instead of to the caller: someone who wants a
   * member's e-mail should not have to name a share, and — worse — should not
   * have to already know a *valid* one, since a wrong suffix makes the run
   * hard-fail on a locator that finds nothing. Two capabilities, each asking
   * only for what it needs.
   */
  "meridian-read-share-balance": {
    id: "meridian-read-share-balance",
    app: "meridian-core",
    name: "Read a share's balance and status",
    description:
      "Reads the balance and status of one of a member's shares, identified by its share-code suffix (S0001, S0070, MMKT, CERT, or a numbered variant such as MMKT-4).",
    goal:
      "Navigate directly to the member record page for the member identified by the memberId parameter (the URL is /members/ followed by that member number). In the SHARES / BALANCES table, find the row whose Share ID is the member number followed by a hyphen and the shareCode parameter, and extract that row's Balance as balance and its Status as status. Also extract the Share ID itself as shareId.",
    params: [
      { name: "memberId", type: "string", exampleValue: MEMBER, sensitive: false, description: "Member number." },
      {
        name: "shareCode",
        type: "string",
        exampleValue: "S0070",
        sensitive: false,
        description: "Share suffix identifying which share to read, e.g. S0001, S0070, MMKT, CERT, MMKT-4.",
      },
    ],
    preconditions: { authRequired: true, startRoute: "/menu" },
    verifyParams: { memberId: "101555", shareCode: "S0001" },
    knownOutcomes: meridianOutcomes(),
  },

  "meridian-funds-transfer": {
    id: "meridian-funds-transfer",
    app: "meridian-core",
    name: "Transfer funds between shares",
    description:
      "Transfers an amount between two of a member's shares in MERIDIAN CORE, through the review screen and posting the transaction. Returns the confirmation number and both resulting balances.",
    goal:
      "From the main menu, go to Funds Transfer, search by Member Number for the member identified by the memberId parameter, and Select their row. On the transfer form, choose the source share whose value is the member number followed by a hyphen and the fromShareCode parameter, choose the destination share the same way using toShareCode, enter the amount parameter as the amount, enter the memo parameter as the memo, and Continue to the review screen. Verify the review screen shows the amount you entered, then post the transfer. On the posted screen, extract the confirmation number as confirmationNumber, the source share's new balance as fromNewBalance, and the destination share's new balance as toNewBalance.",
    params: [
      { name: "memberId", type: "string", exampleValue: TRANSFER_MEMBER, sensitive: false, description: "Member number." },
      {
        name: "fromShareCode",
        type: "string",
        exampleValue: "S0070-7",
        sensitive: false,
        description: "Share suffix to transfer from, e.g. S0001 or S0070-7.",
      },
      {
        name: "toShareCode",
        type: "string",
        exampleValue: "MMKT-2",
        sensitive: false,
        description: "Share suffix to transfer to, e.g. MMKT-2.",
      },
      {
        name: "amount",
        type: "currency",
        exampleValue: "12.34",
        sensitive: false,
        description: "Amount to transfer, in dollars.",
      },
      {
        name: "memo",
        type: "string",
        exampleValue: "Routine share transfer",
        sensitive: false,
        description: "Memo recorded against the transfer.",
      },
    ],
    preconditions: { authRequired: true, startRoute: "/menu" },
    // Mutating: no differential probe. See the note at the top of this file.
    irreversibleStepLabels: ["Post Transfer"],
    knownOutcomes: meridianOutcomes({ transactional: true, funds: true }),
  },

  "meridian-open-share": {
    id: "meridian-open-share",
    app: "meridian-core",
    name: "Open a new share",
    description:
      "Opens a new share of a given type for a member with an initial deposit, through the review screen and posting it. Returns the confirmation number and the new share id.",
    goal:
      "From the main menu, go to Open New Share, search by Member Number for the member identified by the memberId parameter, and Select their row. On the form, choose the account type whose value is the shareType parameter, enter the deposit parameter as the initial deposit, and Continue to the review screen. Verify the review screen shows the deposit you entered, then open the share. On the success screen, extract the confirmation number as confirmationNumber and the new share identifier as newShareId.",
    params: [
      { name: "memberId", type: "string", exampleValue: TRANSFER_MEMBER, sensitive: false, description: "Member number." },
      {
        name: "shareType",
        type: "string",
        exampleValue: "MMKT",
        sensitive: false,
        description: "Share type code: S0001 (Regular), S0070 (Share Draft), MMKT (Money Market), CERT (Certificate).",
      },
      {
        name: "deposit",
        type: "currency",
        exampleValue: "25.00",
        sensitive: false,
        description: "Opening deposit in dollars.",
      },
    ],
    preconditions: { authRequired: true, startRoute: "/menu" },
    irreversibleStepLabels: ["Open Share"],
    knownOutcomes: meridianOutcomes({ transactional: true }),
  },

  "meridian-update-member-contact": {
    id: "meridian-update-member-contact",
    app: "meridian-core",
    name: "Update member contact information",
    description:
      "Updates a member's e-mail, phone and mailing address. All three are required: the form saves every field it holds, so a value left out would be blanked. Read the current values first with the read-member-record capability.",
    goal:
      "From the main menu, go to Update Member Information, search by Member Number for the member identified by the memberId parameter, and Select their row. On the form, replace the e-mail with the email parameter, the phone with the phone parameter, and the mailing address with the address parameter, then save the changes. Verify the page confirms the changes were saved.",
    params: [
      { name: "memberId", type: "string", exampleValue: TRANSFER_MEMBER, sensitive: false, description: "Member number." },
      {
        name: "email",
        type: "string",
        exampleValue: "good@example.com",
        sensitive: true,
        description: "New e-mail address. Required: the form saves all three fields together.",
      },
      {
        name: "phone",
        type: "string",
        exampleValue: "555-0199",
        sensitive: true,
        description: "New phone number. Required: the form saves all three fields together.",
      },
      {
        name: "address",
        type: "string",
        exampleValue: "1 Main St",
        sensitive: true,
        description: "New mailing address. Required: the form saves all three fields together.",
      },
    ],
    preconditions: { authRequired: true, startRoute: "/menu" },
    knownOutcomes: meridianOutcomes({ transactional: true }),
  },

  "meridian-place-account-hold": {
    id: "meridian-place-account-hold",
    app: "meridian-core",
    name: "Place a hold on a share",
    description:
      "Places a restrictive hold on one of a member's shares. Requires a supervisor session; a teller invocation is refused before the run touches the host.",
    goal:
      "From the main menu, go to Place Account Hold, search by Member Number for the member identified by the memberId parameter, and Select their row. On the hold form, choose the share whose value is the member number followed by a hyphen and the shareCode parameter, choose the reason code given by the reasonCode parameter, enter the notes parameter as the notes, and Continue to the review screen. Verify the review screen, then apply the hold. On the success screen, extract the confirmation number as confirmationNumber and the identifier of the share now on hold as heldShareId.",
    params: [
      { name: "memberId", type: "string", exampleValue: TRANSFER_MEMBER, sensitive: false, description: "Member number." },
      {
        name: "shareCode",
        type: "string",
        // A share that is currently OPEN. A hold is permanent for the life of
        // the deployment, so re-recording this capability needs a fresh one.
        exampleValue: "MMKT-4",
        sensitive: false,
        description: "Share suffix to place the hold on.",
      },
      {
        name: "reasonCode",
        type: "string",
        exampleValue: "LEGAL",
        sensitive: false,
        description: "Reason code: FRAUD, LEGAL or DECEASED.",
      },
      {
        name: "notes",
        type: "string",
        exampleValue: "Hold placed per compliance request",
        sensitive: false,
        description: "Free-text note recorded against the hold.",
      },
    ],
    // Enforced at POST by the host, and now also failed fast by the replay
    // engine before it touches the app — a teller invocation returns
    // PERMISSION_DENIED with zero steps executed.
    preconditions: { authRequired: true, startRoute: "/menu", requiredRole: "supervisor" },
    irreversibleStepLabels: ["Apply Hold"],
    knownOutcomes: meridianOutcomes({ transactional: true }),
  },
};
