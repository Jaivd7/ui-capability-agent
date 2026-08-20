# Capability artifact schema

Source of truth: `src/artifact/schema.ts` (zod — both the runtime validator
and, via `z.infer`, the compile-time TS type). This doc explains *why* each
field exists and the alternatives that were rejected. Read alongside
REPORT.md §2 for the higher-level rationale.

## What the artifact is for

Four different readers need to trust the same object:

1. **A human reviewer** — can this be approved to run unattended?
2. **The discovery loop** — what does a successful run get compiled into?
3. **The replay engine** — what does it execute, with no LLM involved?
4. **A calling AI agent** — what does it invoke, with what args, getting what back?

The schema is shaped around that last one in particular: an artifact is a
**capability contract**, not a transcript. Anything that's an implementation
detail of *how discovery happened* (the model's chain of thought, intermediate
failed attempts, raw screenshots) is deliberately excluded — that's evidence,
and belongs in `/evidence/`, not in the reusable artifact.

## Top-level fields

| Field | Why it exists |
|---|---|
| `schemaVersion` | Version of the **format itself**, independent of the capability's own revision. Deliberately a separate field from `version` — conflating "the artifact schema changed" with "this capability was re-recorded" is a common mistake and makes migration ambiguous. Currently `z.enum(["1.0.0", "1.1.0"])`, with `CURRENT_SCHEMA_VERSION` as what a fresh compile stamps. **1.1.0** added the `textMatches` assertion and generalized `${param}` templates beyond `navigate.urlTemplate`. The bump is not cosmetic: a 1.0.0 engine handed a `textMatches` checkpoint falls through an unhandled `switch` in `assertCondition` and the assertion silently *passes*, which is exactly the failure a version discriminator exists to prevent. |
| `id`, `name`, `description` | Human- and agent-facing identity. `description` is what a calling agent's tool-catalog entry would show (see the "agent-facing capability interface" stretch goal — this field is what makes that trivial to add later). |
| `version` | This **capability's** revision number, incremented each time discovery re-records it (e.g. after the underlying app's UI changes enough to need a fresh recording). Independent of `schemaVersion`. |
| `contentHash` | sha256 fingerprint of the semantically meaningful content — steps, checkpoints, known outcomes, call contract, preconditions, and target app identity (see `hash.ts`). Deliberately excludes `id`/`name`/`version`/`createdAt`/`baseUrl`/`tenant` so that two tenants running the *same underlying app* can be compared directly: matching hash means "this artifact should still apply," diverging hash is the drift signal described in REPORT.md §4. Computed by a pure function at save time and **re-verified when replay loads the artifact** — a mismatch is refused unless `--allow-hash-mismatch` is passed, which is what turns this from a decorative field into an integrity guarantee. Two things it deliberately gets right: `preconditions` is **included**, because `startRoute` decides where the flow begins and `requiredRole` is the difference between a capability a readonly session can run and one it can't; every `reason` and `description` is **excluded**, because those are review prose, and reporting a reworded comment as drift is the fastest way to teach a reviewer to ignore the signal. `outcome.message` stays in — that one is caller-facing contract, not commentary. |
| `createdAt` | Provenance timestamp. |
| `discovery` | `{ model, discoveredAt, sourceSessionId? }` — records which model produced this recording. Mostly a trust/audit signal for the human reviewer; also the seam for a future "confidence & approval" gate (stretch goal) keyed on discovery provenance. |
| `target` | See below. |
| `preconditions` | See below. |
| `inputParams` | Typed call signature — the args a caller supplies per invocation. |
| `outputs` | Typed return shape — what a caller gets back. |
| `steps` | The ordered, executable flow. |
| `checkpoints` | The final success condition(s) — see "Checkpoints" below. |
| `knownOutcomes` | The error-taxonomy seam — see "Error taxonomy" below. |

### `target`

```ts
{ app: string; baseUrl: string; entryRoute: string; tenant: string | null }
```

`app` (a vendor/product identifier like `"legacy-core-banking"`) is kept
**separate from `baseUrl`** on purpose: `app` is the multi-tenant reuse key —
two tenants running the same vendor product share `app` but have different
`baseUrl`s. `tenant` is `null` in this project (no multi-tenancy is actually
implemented — see REPORT.md §4 for why that's a documented design, not a
built system), but its presence in the schema now means a tenant-specialized
artifact has somewhere to live later without a schema migration.

### `preconditions`

```ts
{ authRequired: boolean; startRoute?: string; requiredRole?: string }
```

`requiredRole` exists because "permission denied" is one of the runtime error
states the brief explicitly calls out (§3.3). Declaring the required role on
the artifact lets the replay engine (or the guardrail layer) fail fast with a
clear message instead of discovering the denial mid-flow.

## Locators: the robustness strategy

```ts
LocatorCandidate =
  | { strategy: "role"; role; name?; exact; reason }
  | { strategy: "label"; text; exact; reason }
  | { strategy: "text"; text; exact; reason }
  | { strategy: "placeholder"; text; reason }
  | { strategy: "testId"; testId; reason }
  | { strategy: "css"; selector; reason }
  | { strategy: "xpath"; expression; reason }

LocatorChain = LocatorCandidate[]  // ordered, try [0] first, fall through
```

**Every locator is a chain, never a single selector.** This is the direct
answer to the brief's "no clean DOM" requirement: a legacy app has no test
IDs and no stable CSS, but it still has an accessibility tree (role + name),
because that's what makes it usable with a screen reader — and that tree
survives markup rewrites that would break a CSS selector. So the chain is
ordered from most-robust to least:

1. `role` (+ accessible name) — keys off the a11y tree, most stable, and the
   one strategy that also generalizes toward desktop automation later
   (accessibility APIs exist on native desktop apps too — see REPORT.md §4).
2. `label` / `text` / `placeholder` — still a11y-tree-adjacent, good for
   inputs/content without a clean role mapping.
3. `testId` — best case when available, but legacy enterprise apps
   essentially never have it (per the brief's own glossary), so it's ranked
   below role/label rather than first, unlike a "modern app" default would do.
4. `css` / `xpath` — last-resort fallback rungs, kept only because *some*
   element genuinely has no accessible identity (e.g. a decorative legacy
   table cell used as a button). Brittle, and marked as such.

**Every candidate carries a mandatory `reason: string`.** This is what makes
the artifact *reviewable* rather than just executable — a human reading the
artifact can see why a given locator was trusted, not just what it is. It's
also what a future confidence-scoring pass (stretch goal) would key off:
an artifact whose chain bottoms out in `css`/`xpath` for a step is a weaker
recording than one that resolved via `role` everywhere.

**Locators are frame-aware.** Every targetable step and checkpoint carries a
`frame: FrameLocator[]` path (empty = top-level page). This exists because
the mock target app deliberately embeds a panel in an `<iframe>` — one of the
concretely hostile-surface features chosen to exercise this — and because
frames/framesets are called out explicitly in the brief as a legacy-surface
reality. Modeling frame traversal as an explicit, typed path (rather than,
say, baking a CSS frame-selector into the locator string) keeps "how do I
reach the right document" and "how do I find the element in it" as two
separable concerns.

## Parameterization and templates

A capability is only genuinely parameterized if its *verification* is
parameterized too. An early version of this schema generalized only what a
step **typed** — `fill`/`select` values and `navigate.urlTemplate` — and left
checkpoints and locator strings exactly as recorded. The result was an
artifact that walked every step correctly for a different member and then
failed its own checkpoint, because that checkpoint asserted the recorded
member's name. Parameterized in its steps, hardcoded in its proof.

So there are **two** generalization mechanisms, split along a real seam:

- **`ValueRef`** for what a step *types*. The value is the entire field, so
  exact equality against the recorded example is the right rule.
- **`${param}` templates** for everything a step or checkpoint *matches on* —
  locator strings, assertion `expected`, `urlTemplate`, `description`, and
  `knownOutcomes[].detect` locators. Here the parameter is usually embedded in
  surrounding text, and may appear in a different surface form than it was
  typed in (`100` typed into a field, `$100.00` rendered on a confirmation
  screen).

### Grammar

```
PLACEHOLDER := "${" IDENT ( ":" FORMAT )? "}"
FORMAT      := raw | currency | number | regexEscape        (default: raw)
ESCAPE      := "${{"  ->  a literal "${"
```

The rule is **parses as a placeholder ⇒ must resolve; doesn't parse ⇒
literal**. `${foo}` naming an undeclared param throws; `${1}`, `${ x}` and a
bare `$` are left alone, so a pathological CSS selector can't crash a run.
Substituted output is never re-scanned, which is both an injection guard on
caller-supplied arguments and the reason a value containing `${y}` stays
inert.

The escape is `${{` rather than the more obvious `$${` because the latter is
ambiguous in exactly the case that matters: a regex assertion ending in a
literal `\$` immediately followed by a placeholder produces `$${`, which a
scanner cannot distinguish from an escaped `${`. `{` can never start an
identifier, so `${{` has only one reading.

### Formats are chosen by observation, not by declared type

The compiler emits `${openingDeposit:currency}` only because
`formatParam("100", "currency")` equals `"$100.00"` — *the literal the model
actually saw on the page*. It never consults `inputParams[].type`. This is
what keeps the formatter set safely extensible: an app that renders
`$1,500.00` would get a `currencyGrouped` formatter added, and the compiler
would select it automatically with no other change.

Relatedly, `currency` deliberately does **not** group thousands, because the
target app renders `$${n.toFixed(2)}`. A locale-aware formatter would produce
a checkpoint that passes for `100` and silently fails for `1500`.

### Where substitution happens

`src/shared/locator.ts` and `src/shared/assert.ts` stay params-free. They are
shared *verbatim* by discovery and replay, and that sharing is the structural
guarantee behind "the locator that worked during discovery is the locator
replay uses." The invariant that makes this work:

> During discovery, templates do not exist. The model authors concrete
> literals; the compiler introduces `${}` only after the run.

So shared code never sees a template. `materializeArtifact` resolves the whole
artifact once at the top of `runReplay`, before the browser is touched, which
also means an unresolved placeholder aborts before step 1 rather than
half-way through a flow that may already have mutated state.

Two things a template may never reference, both enforced in `superRefine`: an
**optional** param (materialization throws on a missing value, so a
well-formed call could otherwise fail mid-flow) and a **sensitive** param (a
sensitive value in a locator ends up in `LocatorResolutionError`'s message,
and from there in the run log and the failure evidence — a secret is never a
search key). Sensitive params remain legal as `fill`/`select` values, which is
the only place one belongs.

## Steps

A discriminated union on `type`: `navigate | click | fill | select | check |
waitFor | extract`. Kept intentionally small — no separate "assertCheckpoint"
step type, because a mid-flow assertion is just a `waitFor` with a locator
and an assertion; the top-level `checkpoints` field is reserved purely for
the capability's *final* success condition, so there's exactly one place a
reviewer looks to answer "how do we know this worked."

Two fields on every step are worth calling out:

- **`retryable: boolean`** — if a step's wait times out, the replay engine
  may retry it a bounded number of times before declaring a hard failure.
  This is the step-local answer to *plain transient slowness* — not a named
  condition, just "try again." It's deliberately distinct from...
- **`irreversible: boolean`** — marks a step as a high-consequence action
  (state mutation that isn't trivially undoable — e.g. the final "Submit" on
  the sub-account form). This is what the Phase 4 guardrail layer gates on:
  blocked or requires explicit confirmation, never silently executed
  unattended. It's per-*step*, not per-*artifact*, because a single
  capability (open a sub-account, reach confirmation) is reversible right up
  until one specific step — gating the whole capability would block useful,
  safe work (getting to the confirmation screen) over one risky step at the
  end.

`navigate` steps use a `urlTemplate` string (e.g. `/members/${memberId}`)
with `${name}` placeholders resolved from `inputParams`, rather than reusing
the `ValueRef` union used elsewhere — navigation targets are almost always a
literal-plus-param mix, and a template string reads far more naturally than
composing that from a `{kind: "literal"} | {kind: "param"}` value.

`extract` steps carry a `read: { from, attributeName?, transform? }` spec and
an `outputName` that must match one entry in the top-level `outputs` array.
**Extraction logic lives on the step, not on the output declaration.** An
earlier draft put the locator directly on `outputs[]`; that was rejected
because it conflates two different concerns — `outputs` is the *contract*
(name, type, sensitivity — what a caller can expect back) while the step
sequence is *how and when* that value is actually read, which may need to
happen mid-flow (e.g. reading an intermediate confirmation number before a
final navigation), not necessarily at the very end. The schema's
`superRefine` cross-checks enforce the two stay in sync: every declared
output must be produced by exactly one `extract` step, and every `extract`
step's `outputName` must reference a declared output.

## Checkpoints

```ts
{ description; frame; locator; assertion; expected?; attributeName? }[]
```

An array (not a single condition) so a capability can require more than one
thing to hold simultaneously (e.g. "confirmation banner is visible" *and*
"URL matches `/confirmation`"). `assertion` is one of `exists | notExists |
textEquals | textContains | textMatches | urlMatches | attributeEquals`; a
`superRefine` enforces that `expected` is set for the five assertions that
need it and `attributeName` is set for `attributeEquals` — a checkpoint that's
structurally valid but semantically incomplete (e.g. `textEquals` with no
`expected` value) is rejected at artifact-validation time, not discovered
as a confusing runtime bug during replay.

### Structure, not data

This is the load-bearing rule for checkpoints, and the one the first version
of this system got wrong. **A checkpoint is not a snapshot of the run that
produced it.** It is stored and re-run later, unchanged, against different
members, amounts and dates. So a checkpoint must assert the *shape* of the
state it expects, never the data it happened to observe.

Concretely, for a member-lookup capability:

| Instead of | Assert |
|---|---|
| `heading name="Member: Jane Smith"` exists | `urlMatches /members/${memberId:regexEscape}` **and** `heading name="Member:"` `textContains "Member:"` |
| balance cell `textContains "$3482.10"` | balance cell `textMatches "^\$[0-9,]+\.[0-9]{2}$"` |
| `text "Standard Savings"` exists | `text "${accountType}"` exists |

Three separate things make this hold, because no single one is sufficient:

1. **The locator counts, not just `expected`.** A checkpoint has to *find* its
   element before it can assert anything, so a locator naming this run's data
   fails for every other input even when the assertion itself is generic. This
   is the most common way to get it half-right.
2. **`textMatches` exists for exactly this.** "The balance cell holds a dollar
   amount" is a real, useful assertion; without a regex assertion it was only
   fakeable as `textContains "$"`.
3. **A value that IS an input parameter should be asserted exactly.** A
   confirmation screen echoing back the account type and deposit you requested
   is the strongest available evidence the flow did what was asked, so those
   get `textContains "${accountType}"` rather than a shape regex — which would
   pass even if the app recorded the wrong amount. Shape regexes are for values
   read off the page that the caller could not know in advance.

This is enforced in three places, deliberately layered: a **finish-time gate**
rejects the model's checkpoints if they contain an extracted value or a
hardcoded amount (`src/discovery/checkpoint-quality.ts`); the **compiler
refuses to write** an artifact containing page data at all
(`assertNoLeakedPageData`); and a **differential probe** replays the fresh
artifact with a different argument set, which is the only mechanism that
catches data the compiler cannot recognise as data — a member's *name* is
neither a parameter nor an extracted output, so from a single recording it is
indistinguishable from static page chrome.

That last point is worth stating plainly, because it bounds what static
analysis can do here: **of the three kinds of literal a recording can contain
— param-derived, page-data-known, page-data-unknowable — only the first two
are decidable.** The third needs an oracle, and a five-second no-LLM replay
with different arguments is a cheap one.

## Error taxonomy: `knownOutcomes`

This is the schema's direct answer to the brief's three-way split (§3.3):
expected business outcome / recoverable condition / hard failure.

```ts
KnownOutcome =
  | { classification: "business"; checkAfterStepId?; detect; outcome: { code, message } }
  | { classification: "recoverable"; checkAfterStepId?; detect; recovery: { action, maxAttempts } }
```

`checkAfterStepId` is optional: omitted means "check after every step," which is
the common case — a condition like session expiry can plausibly surface after
any step, so tying its detector to one specific step id would be both
artificial and fragile (that id isn't even known until after a discovery run
produces the concrete step sequence). Set it only when a detector should be
checked at one specific, known point in the flow, to narrow where it's
checked and reduce the chance of an unrelated match elsewhere.

Two more deliberate design choices here:

1. **Business outcomes live on the artifact; generic recoverable actions live
   in the replay engine's app-level config.** A *business* outcome (e.g.
   "member not found") is capability-specific — it was discovered during
   *this* recording, has a code/message shape specific to *this* flow, and
   makes no sense to share across capabilities. A *recoverable* condition's
   **detector** (where in this flow to look for a session-timeout banner) is
   still capability-specific, but the **action** it invokes (re-authenticate)
   is generic to the whole app and shouldn't be re-implemented per artifact.
   So the schema stores the detector + a named action (`reauth |
   dismissAndRetry | reloadAndRetry`) on the artifact, and the replay engine
   (`src/replay/app-config.ts`) owns the one implementation of each named
   action per `target.app`. This is the split that keeps the third-tier
   "hard failure" case honest too: if a detected state doesn't match *any*
   declared `knownOutcome`, it's unrecognized by definition, which is exactly
   what should surface as a hard failure with debuggable detail (which step,
   expected vs. observed) rather than being silently swallowed.

2. **What isn't a `knownOutcome`.** Anything not named here is a hard
   failure by construction, not by a fallback branch someone has to remember
   to write — the absence of a matching detector *is* the hard-failure path.

## What's deliberately *not* in the schema

- **No allowlist/domain policy on the artifact.** Guardrails (Phase 4) are a
  cross-cutting runtime policy (which domains/routes/action-types are
  permitted at all), evaluated *before* an artifact is even allowed to run,
  not a property of one capability. Putting it on the artifact would let a
  malicious or buggy artifact declare its own exemption.
- **No derived "risk summary" field** (e.g. a precomputed list of irreversible
  step IDs). That's fully derivable from `steps` by a pure function, and
  storing it redundantly risks it going stale relative to the steps it's
  summarizing. Computed on demand instead (guardrail layer, Phase 4).
- **No raw model transcript / chain-of-thought.** That's `/evidence/`, not
  the artifact — the artifact is what survives *after* discovery, decoupled
  from how discovery got there, per the brief's own framing (§2.3).
