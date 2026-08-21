# Future plans

Work that is scoped but deliberately not built. Each entry says what it is, what
it actually costs, and — where it matters — why the obvious cheap version is the
wrong one to ship.

Written 2026-08-21.

---

## 1. A discovery builder in the dashboard

**The idea.** Someone non-technical wants a new capability. Rather than adding a
preset to `src/discovery/presets-meridian.ts` and redeploying, they fill in a
form in the dashboard, run discovery from it, and get a recorded capability.

**The form is the easy part. The goal is a specification, not a sentence.**

That is the whole scoping insight. Here is what the presets that actually work
look like today:

| preset | goal length | knownOutcomes | verifyParams |
| --- | --- | --- | --- |
| `meridian-find-member-by-name` | 1,766 chars | 6 | yes |
| `meridian-find-member-by-number` | 1,608 | 5 | yes |
| `meridian-read-member-record` | 814 | 5 | yes |
| `meridian-funds-transfer` | 712 | 8 | **no** |
| `meridian-place-account-hold` | 579 | 6 | **no** |
| `meridian-read-share-balance` | 394 | 5 | yes |
| `meridian-update-member-contact` | 369 | 6 | **no** |
| `meridian-open-share` | 502 | 6 | **no** |

The Meridian goals average roughly 750 characters. None of that is padding —
commit `73b76b7` puts it plainly: *"each clause was earned by a failed run."* A
non-technical user types thirty characters.

### Estimate

**Thin version — about 3 hours.** A form (id, name, description, app, goal,
params, role, startRoute), a runner that accepts an ad-hoc preset rather than
only a registry id, a JSON store for user-created presets (they are TypeScript
today, so persistence is genuinely new), and a Run button.

**Safe for a non-technical user — 1.5 to 2 days.** The difference is entirely in
the five problems below.

### What "bad input" actually means here

Ranked by how badly each one bites. Note that only the second is the kind of
thing form validation can even reach.

1. **`knownOutcomes` cannot be hand-authored by a non-technical user.** Five to
   eight detectors per capability, each verified against the live app's exact
   banner text. Without them every business outcome — member not found,
   insufficient funds, permission denied — comes back as a hard failure instead
   of a clean typed answer. Biggest quality drop, and invisible until someone
   exercises an unhappy path.

2. **The goal has to encode recorder mechanics.** Extract a variable-length
   table in *one* step, because per-cell steps record one member's share count
   as the recipe. Write `normalize-space(text())` rather than `contains(., …)`,
   or the scorer will not recognise a row predicate as content-anchored. Assert
   concrete values, because discovery compares them raw and the compiler
   parameterises them afterwards. A form can check "the goal mentions every
   declared param by name" — cheap and worth doing — and it cannot check any of
   the above. A naive goal compiles cleanly and is subtly overfitted.

3. **`verifyParams` is optional, and the four mutating capabilities already skip
   it.** No second argument set means no differential probe, which is the only
   mechanism that catches a recording fitted to its own arguments rather than to
   the application.

4. **`irreversibleStepLabels`.** Nobody unfamiliar with the target knows to name
   "Post Transfer" as the button whose click must be flagged. The model should
   classify it and usually does, but a *missed* flag is an ungated irreversible
   action, which is the wrong direction to fail in.

5. **Every attempt is a real run.** Two to five minutes, real API spend, a real
   browser against a shared live host — and for a mutating capability it
   genuinely moves money, opens an account, or places a hold. A non-technical
   user iterating on goal text does that repeatedly.

### What already exists, and the reframe it suggests

The safety nets for bad discovery output are already built:

- `scoreRecording` grades a recording A–D with findings — chain depth,
  css/xpath reliance, un-templated parameter values, unasserted params.
- `checkCheckpointQuality` rejects weak checkpoints at discovery time.
- The differential probe replays the freshly compiled artifact with a second
  argument set, no model in the loop, on the same live session.

So a bad goal already produces a **visibly graded bad** artifact rather than a
silently bad one. That changes the shape of the feature. It is not "form → run".
It is:

> **draft → run → review the grade and the probe result → publish or discard**

with publishing gated below a grade threshold. That third step is what makes it
safe for a non-technical user, and it is mostly surfacing output that already
exists rather than new logic.

### Recommended shape

Make the goal **guided rather than free text**:

- The earned clauses become toggles — "this reads a variable-length table",
  "this posts an irreversible transaction", "this searches and selects a row" —
  each expanding into the goal language that is known to work.
- `knownOutcomes` picked from a per-app library rather than authored.
- A second argument set required, not optional, so the probe always runs.
- Draft capabilities held separate from published ones, with the grade and the
  probe result shown before anything can be published.

That turns "write a 750-character specification" into answering about six
questions, and it is where most of the 1.5–2 days goes.

### Why not now

It is outside the brief, which asks for capabilities recorded → API → chatbot →
dashboard. The demo path works end to end today, and a day of changes to the
discovery path is the most destabilising thing that could be done to it.

If it comes up before then, the write-up answer is strong on its own: the
grading half is already built, so the remaining work is a guided authoring
surface over machinery that exists. **A free-text goal box that produces
D-graded artifacts would be worse than no builder at all.**

---

## 2. Other open items

Smaller, all previously identified, none blocking.

- **`REPORT.md` understates the system.** §7 still says the operator console is
  *"outside the guardrail layer"* with operator-typed values *"logged
  unredacted"*, and lists bringing it inside those layers as a next step. All
  three are now false — `action-policy.ts` puts every console action through the
  allowlist, and declared sensitive values are redacted. It also still describes
  the console vocabulary as "navigate-by-CSS-selector", which is two redesigns
  out of date. Since `ADAPTATION-REPORT.md` is gitignored, `REPORT.md` is the
  only write-up visible in a public repo, so it reads as the current state
  whether or not it was written as one. Decide between leaving it as a
  historical record of the core, appending a correction section, or editing in
  place.

- **The escalation console's palette has drifted.** `console-view.ts` duplicates
  the theme by value and is still on the pre-restyle cool tones (`--paper:
  #FAFAF9`), so it renders as a cool panel inside a warm page. Its own comment
  asks for it to be kept in step with `views/theme.ts` by hand. Three hex values.

- **No `list` output type.** A name search resolves to a unique match or
  `MULTIPLE_MATCHES`, and a record read returns the whole shares table as one
  string rather than a typed list. Touches schema, extract, engine, compiler and
  the discovery tool schema. Documented as an intentional cut.

- **No `options[]` on `InputParam`.** The invoke form renders free text for
  `reasonCode` and `shareType`, so a typo becomes a mid-flow failure rather than
  a form error. The observation layer already captures select option values, so
  the plumbing exists and is simply not wired to the artifact. Cheapest
  remaining improvement.

- **`meridian-update-member-contact` has no "minimum one field" support, and the
  obvious fix is dangerous.** Steps 5/6/7 fill email/phone/address
  unconditionally and the schema has no branching, so marking the params
  optional would fill omitted fields with `""` and **wipe real member data**
  while reporting success. A correct fix needs a step-level skip flag, an engine
  change, and a re-record. Current workflow is read-then-update.

- **No differential probe on the three mutating capabilities.** Running one would
  mean a second real transfer, an extra share and a second held account on every
  recording, against a shared host. The skip is surfaced as a warning in the
  quality report, so a missing check looks missing rather than passed.

- **`POST /ask` has no rate limit.** Each call is a model call, making it the
  only unbounded-cost endpoint on the console. Low concern for a local dashboard.
