# Adaptation write-up

Pointing the take-home's discover → record → deterministically replay core at
MERIDIAN CORE, covering its function surface, and wrapping it in an API and a
dashboard.

`REPORT.md` covers the original core. This covers what adapting to a second,
hosted, deliberately hostile target actually took.

---

## 1. What adapting took

**The engine did not change.** `runReplay`'s step loop, the artifact schema, the
three-way result contract, the locator/assertion stack and the
`EscalationHandler` seam are all untouched by the target swap. The coupling was
concentrated in five places, and only one of them needed code rather than
configuration.

Everything per-app now lives in `src/apps/` behind an `AppAdapter`: the target,
the role vocabulary, the login flow, the recovery-action implementations, and
the locator guidance given to the discovery model. Guardrail policy deliberately
stayed in `config/guardrails.json`, keyed by app, because "operator-editable
without a code change" is a property the original design argued for and a second
target is not a reason to give it up.

**The one thing that needed real code was login.** `performLogin` hardcoded five
facts — route, two label strings, a button name, a success URL. MERIDIAN's
sign-on takes operator, password *and branch*, the third being a `<select>`. You
cannot express that by parameterizing `getByLabel("Username")` without inventing
a small DSL to say what a four-line function already says. So `login` is a
function on the adapter. That is the honest answer to the brief's question, and
about forty lines for both apps.

The structural guarantee survived unchanged and is worth restating: login runs
via direct Playwright calls before the discovery loop starts, so credentials
never enter the model's context or a recorded artifact — for either app, by
construction rather than by redaction. That is also why **sign-on is not one of
the seven recorded capabilities** even though §2.1 lists it as a function.
Recording it would put credentials in exactly the two places this design keeps
them out of.

Two smaller shapes were wrong rather than merely unset. `SessionRole` was a
closed `"teller" | "readonly"` union load-bearing in five files; role
vocabularies are a property of the target, so it became a per-app record.
`capabilities/` and `evidence/` were flat, so two apps would have collided on a
same-named capability and the re-record version counter would have incremented
across them.

**Both original mock-app capabilities still replay green**, which is the
evidence for the claim that this was configuration rather than a rewrite — the
same engine, two targets, one registry, runnable side by side.

### Three things the second target proved were wrong

This is the part I would most want to be asked about, because the same mistake
appears three times at three different layers.

The core was built around one target that had an accessibility tree. MERIDIAN
CORE has **no accessibility affordances at all** — not one `<label>`, `for=`,
`aria-*`, `role=` or `id` on any page. And in each of three layers, I had
encoded a property of the *first* target as a property of legacy apps in
general:

| Layer | What I'd assumed | What's actually true |
|---|---|---|
| **Locators** | role/label first, css as a brittle last resort | `[name="amount"]` is part of the form's *submission contract* — more stable than an accessible name, which is presentational text someone can reword |
| **Recording scorer** | "css means brittle" | the property that matters is *content-anchoring*. `//td[text()='E-mail:']/following-sibling::td[1]` survives row insertion; `tr:nth-child(2) td` doesn't. Both are non-role selectors |
| **Perception** | an aria snapshot shows the model the page | on a page with no labels, every input is an anonymous textbox. The model could not *see* that the search field was `name="by"`, so it guessed, and then used the `extract` tool as a debugging probe — polluting the capability's public contract with scratch outputs |

The perception fix was the interesting one: `observe()` now also carries a
digest of the form controls present — name, type, and for a `<select>` its
option *values*. App-agnostic, and it incidentally fixed a second bug, because
the model could then see that a share option's value is `101555-S0001` while its
*label* embeds a balance that changes every time money moves.

The scorer correction happened twice (css → positional → content-anchored)
before landing on the right predicate. Worth being explicit that it took two
targets to see the syntactic rule was a proxy at all.

---

## 2. The capability API

Seven capabilities cover §2.1's surface. All are invoked by name with typed
arguments and return structured results; none require the caller to know
anything about the UI.

```
GET  /api/capabilities                    catalog
GET  /api/capabilities/:id                full detail, including the recipe
POST /api/capabilities/:id/invoke         202 + runId
GET  /api/runs/:runId/status              always 200
GET  /api/runs/:runId                     full record + evidence links
GET  /api/runs/:runId/events?since=       timeline deltas
GET  /api/runs/:runId/evidence/:file      fixed filename set
```

**The catalog withholds the recipe on purpose.** `steps`, `checkpoints` and
locator chains are absent from `GET /api/capabilities` — they *are* UI
knowledge, and shipping them in a catalog whose premise is "invoke by name
without knowing the UI" would quietly contradict it. `inputParams`, `outputs`,
`knownOutcomes`, `requiredRole` and an `irreversible` flag are all present,
because a caller genuinely needs to branch on `MEMBER_NOT_FOUND` and to know
that a call may block on a human.

**HTTP status describes the API interaction, never the automation outcome.** A
poll is always 200 and the three-way `ReplayResult` union survives verbatim into
the body, so a caller switches exactly as a programmatic caller of `runReplay`
does. A `business_outcome` is not a 4xx because it isn't an error — but the more
interesting half is that a `hard_failure` isn't a 5xx either. A 5xx would claim
*the API broke*, which is false: the automation ran as designed and reported
honestly. Only a bug in this layer is a 500.

**Kickoff-and-poll, because a run can pause indefinitely.** `POST` returns 202
with a run id immediately. One rule makes the poll contract total: *the runId is
allocated before session bootstrap, login or materialization*, so a target
that's down, a failed login or an unresolved `${param}` becomes a
`hard_failure` run with real evidence on disk rather than a bare 500 with
nothing.

**Single-flight, with an honest 409.** One browser context and one authenticated
session at a time is a real constraint, so a second invocation is refused — and
the 409 body carries the blocking run, because an escalation-paused run holds
the lock for as long as the operator takes, and a caller told "no" should be
able to go and see why.

---

## 3. Driving this UI reliably, and its runtime states

Locators are attribute-first (`[name=…]`), with buttons and links still reached
by accessible name and table values by content-anchored xpath. Two safeguards
carried over from the previous phase did most of the work here:

- **Ambiguity is refused, not resolved.** A locator matching more than one
  element fails for actions and extractions rather than silently taking the
  first. This fired for real: a run located a balance cell as
  `role=cell name="Savings Balance"`, which on this markup matches both the
  label cell and the value cell, and extracted the *label text* as a member's
  balance.
- **Page data cannot reach an artifact.** Two recordings were refused mid-build
  — one for selecting a share by a label containing a balance, one for locating
  a cell by the confirmation number it was about to read. Neither is a "leak" in
  the PII sense; both are the same underlying defect, a run-specific value
  frozen into a reusable recipe.

**The per-transaction token is a non-problem for a browser.** The brief calls it
out as load-bearing. It is per-*session* on this app, not per-transaction, and
it is only validated at `/…/post` — but more to the point, the review screen
re-emits it as a hidden field and the browser submits it natively on click.
`grep -c _token` across all seven artifacts returns **0**, including a complete
review → post transfer. That observation replaced five planned schema changes
(an extracted-value `ValueRef`, an `internal` output flag, positional ordering
validation, a compiler change, and the staleness hazard they'd have introduced).
The one place in this project that *does* handle the token by hand is the fault
panel — because there we really are an HTTP client rather than a browser.

### Error taxonomy

Detectors are authored once in `src/discovery/meridian-outcomes.ts` and composed
per capability, since they are probed after every step and a read capability
should not pay for transaction-rejection detectors it cannot trigger.

| Condition | Tier | Code |
|---|---|---|
| Session timeout (440, and a bare redirect to sign-on) | recoverable → `reauth` | — |
| Maintenance interstitial (503) | recoverable → dismiss and retry | — |
| Application error (500) | recoverable → backed-off reload | — |
| Record not found (404, and a 200 empty search) | business | `MEMBER_NOT_FOUND` |
| Not authorized (403) | business | `PERMISSION_DENIED` |
| Field/transaction rejection (400) | business | `VALIDATION_REJECTED` |
| Overdraw | business | `INSUFFICIENT_FUNDS` |
| Source share frozen | business | `SHARE_ON_HOLD` |
| Ambiguous name search | business | `MULTIPLE_MATCHES` |

Three details that were easy to get wrong:

- **`SUPERVISOR OVERRIDE REQUIRED` is unusable as a detector string.** The Place
  Hold form renders it as a static warning for a teller on a perfectly healthy
  page. The 403's body sentence — "is not authorized to perform this function" —
  appears only on the actual failure.
- **`insufficient-funds` must precede the generic rejection**, because business
  outcomes short-circuit on first match.
- **A stale token and an injected validation fault render identical markup**, so
  they are genuinely indistinguishable from the page. A second reason not to
  hand-manage the token.

`SHARE_ON_HOLD` was discovered by a failed recording rather than by reading the
brief, and `MULTIPLE_MATCHES` exists because `ParamTypeSchema` has no list type,
so a name search resolves to a unique member or says why it can't.

---

## 4. Safety, evidence and escalation through the new surface

**The escalation console used to bypass every guardrail.** `POST /action` called
`page.goto`, `page.click`, `page.fill` and `page.selectOption` directly, with no
policy check anywhere — so a paused run was a way to drive an authenticated
banking session anywhere, including to `/settings`, which
`config/guardrails.json` explicitly refuses to allowlist *and says so in a
comment*. That is precisely what §3.5 warns about, so it is fixed rather than
documented.

Neither obvious answer works. Applying the identical policy makes the console
useless — it could only re-run recorded steps, and the reason a run paused is
that those didn't work. Trusting the human changes nothing. The line drawn:

> **Origin and route are properties of the session, not of who is driving it.**
> The context holds a real authenticated operator session against a real
> financial system. A human clicking buttons does not change what that session
> *is*.
>
> **Action type and irreversibility are properties of unattendedness** — and
> attendance is exactly what an escalation restores.

So origin and route are enforced identically with no override; the action
vocabulary is narrowed *below* the allowlist ceiling to
`click|fill|select|navigate`; selector ambiguity is rejected the same way a
recorded step's is; the post-action URL is re-checked because a click can
navigate; and an irreversible target is **recorded rather than prevented**,
because blocking it would be theatre — the operator could do the same in their
own browser, and it is sometimes the correct recovery.

Operator-typed values stopped landing in cleartext: `HumanAction` is structured
rather than a pre-formatted string, and `fill` values are always masked.

**Risk-based approval.** An irreversible step below a configured amount runs
unattended; at or above it, it escalates. The amount is derived from the
capability's own `type: "currency"` params rather than from a new artifact field
— an artifact naming which of its params is "the risky one" would be an artifact
influencing the policy applied to it. **Fail closed**: no threshold, no
resolvable amount, or a non-finite one all block, so a capability with no
monetary parameter (Place Account Hold) always escalates *as a consequence of
the rule rather than as a special case*.

This does contradict `REPORT.md` §6's "never silent, never automatic", and that
sentence changes with the behaviour. The argument for the trade: a rule that
gates a $5 transfer and a $50,000 transfer identically trains an operator to
click Approve without reading.

**The escalation relocation touched neither engine.** The console moved from a
per-run Express server on an ephemeral port to routes on the dashboard, keyed by
run id. The coupling to break was never the parked promise — it was that the
route table and the run state shared a lexical scope. Because
`EscalationHandler` is a bare function type, `runReplay` and `runDiscovery`
needed zero edits. The CLIs' `--escalate` mounts *the same router*, so the
policy cannot be enforced in one path and skipped in the other.

**Verified end to end, in one run** (`evidence/meridian-core/`):

```
$150 transfer  → guardrail blocks step-10 "Post Transfer button"
               → run pauses, status escalation_pending
operator tries /settings          → refused, route_not_allowed, recorded
operator tries https://evil...    → refused, origin_not_allowed, recorded
operator approves                 → the artifact's own recorded step executes
               → succeeded, escalated: true, confirmation CN480139
```

---

## 5. What I left out, and what I'd do next

- **No chatbot.** The only LLM call in the system is discovery-time, and I
  wanted to keep it that way. The dashboard generates its invoke form from
  `inputParams` with the declared type shown next to each field, which makes the
  typed contract *visible* rather than hidden behind prose — arguably a better
  demonstration of a capability catalog than chat. A thin one is a small
  addition on top of the existing API.
- **No list output type**, so a name search resolves to a unique match or
  `MULTIPLE_MATCHES`, and a record read returns one share rather than all of
  them. Both are honest typed contracts; a `list` type is the fix.
- **No `options[]` on `InputParam`**, so the invoke form renders free text for
  `reasonCode` and `shareType` and a typo becomes a mid-flow failure rather than
  a form error. The observation layer already captures select option values, so
  the plumbing exists — it just isn't wired to the artifact. Cheapest remaining
  improvement.
- **No differential probe on the three mutating capabilities.** The probe
  re-runs a freshly recorded capability with different arguments to catch
  over-fitting; against a shared, stateful target that would mean a second real
  transfer, an extra share and a second held account on every recording. The
  skip is surfaced as a warning in the quality report, so a missing check looks
  missing rather than passed. It costs the strongest over-fit check on exactly
  the capabilities that matter most.
- **No dashboard authentication**, and the live-screenshot endpoint renders
  whatever the authenticated session currently shows to anyone who can reach the
  port. Fine for a local demo; named rather than left implied.
- **Concurrency is single-flight.** An escalation-paused run blocks invocations
  for as long as the operator takes. A bounded queue with a `queued` status is
  about twenty lines and is what I'd add first if this were multi-user.

**A note on the shared target.** It is stateful and other people are using it.
Over the course of this work `101555-S0001` went from OPEN with $17,963 to HOLD,
shares accumulated on several members, and one recording died because someone
had armed a global maintenance fault. Two consequences worth stating: a
capability's *recorded* example arguments are not guaranteed to still work an
hour later, and the demo script should be smoke-tested immediately before
demoing rather than trusted from the artifact.
