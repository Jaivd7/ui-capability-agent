# REPORT

## 1. Architecture

A single Node/TypeScript process, synchronous, no queues or services — the brief explicitly rewards this simplicity for a one-tenant demo, and nothing here needs more. Two independent execution paths share common infrastructure rather than duplicating it:

- **Discovery** (`src/discovery/`) — Claude Sonnet 5, called directly via the Anthropic SDK (no agent framework), drives Playwright through an observe → decide → act loop. The tool schemas the model calls are shaped identically to the artifact's own `Step`/`LocatorCandidate` types, so a successful tool call compiles into a recorded step with no separate transcript-parsing pass.
- **Replay** (`src/replay/`) — a deterministic executor with no LLM anywhere in the path (verified structurally: the Anthropic SDK is imported only under `src/discovery/`).

Both drive the target through `src/shared/` — locator resolution, assertion, value extraction, dialog handling, login — the *same* code whether a locator was just proposed live by the model or is being replayed from a saved artifact. This is the structural guarantee behind "what worked during discovery still works during replay," not a hope.

The target is a local mock app, "Meridian Core Banking" (`mock-app/`, Express, server-rendered): table-based layout, no test IDs, one field with no accessible label at all, and an account-detail panel rendered in an iframe. Chosen over a public site specifically to control the "no clean DOM" legacy characteristics the brief describes, without ToS or rate-limit risk.

Guardrails and escalation are cross-cutting concerns, injected into both engines via extension points (`GuardrailHook`, `EscalationHandler`) rather than duplicated in each — one policy, one mechanism, reachable from either path.

## 2. Artifact schema

This got the most deliberate design time, before any loop was written (see `docs/artifact-schema.md` for the full field-by-field rationale). The load-bearing choices:

- **`schemaVersion` (format), `version` (this capability's revision), and `contentHash` (a drift-detection fingerprint) are three separate fields**, not one — conflating them makes migration and multi-tenant drift detection ambiguous.
- **Every locator is an ordered fallback chain, never a single selector**, with a mandatory `reason` string per candidate. Ranked role/label/text/placeholder (accessibility-tree-based, survives markup rewrites, and the one strategy that generalizes to desktop) → `testId` (best when present, rare in legacy apps) → `css`/`xpath` (brittle last resort). This is the direct, structural answer to "no clean DOM."
- **`steps` is a 7-kind discriminated union** (`navigate/click/fill/select/check/waitFor/extract`); `irreversible` and `retryable` are per-*step* flags, not per-artifact, since a capability can be reversible right up until one specific action.
- **`outputs[]` is a pure call contract** (name/type/sensitivity); the actual extraction logic lives on `extract` steps, with zod cross-checks enforcing the two can't drift apart.
- **`knownOutcomes` is the error-taxonomy seam**: business-outcome detectors are capability-specific; recoverable-outcome *detectors* are capability-specific but their *actions* are app-generic, implemented once per `target.app`.

Cross-field invariants (unique step IDs, param/output references resolving, checkpoint-assertion completeness) are enforced via zod `superRefine`, so a malformed artifact is rejected at validation time, not discovered mid-replay.

## 3. Determinism & error handling

Determinism comes from sharing `src/shared/assert.ts` and `src/shared/locator.ts` between discovery and replay — not from replay being "simpler." The replay result contract is a TypeScript discriminated union with exactly three caller-visible states — `success | business_outcome | hard_failure` — so a caller's switch can't silently miss a case. **"Recoverable" is deliberately not a fourth state**: a recoverable `knownOutcome` either resolves silently (replay just continues) or exhausts its declared `maxAttempts` and becomes a hard failure naming which condition couldn't be recovered from.

Recovery actions have a `scope`: `reauth` invalidates all prior page state (a fresh login lands on a blank page), so it restarts the *entire* recorded flow; `dismissAndRetry`/`reloadAndRetry` only retry the current step. Native browser dialogs (`window.confirm`) are handled generically at the page/session level, not via `knownOutcomes` — a dialog is an out-of-band event that blocks the page entirely, categorically different from DOM state a locator can detect.

Checkpoints are verified with the same assertion logic as every step; a declared output that never got produced is itself a hard failure (a defensive check against an engine bug, not something that should happen given schema validation). One real detector-coverage gap was found by testing, not designed in: a readonly session's permission denial manifests two different UI signals in the mock app, and the hand-authored detector only covered one — surfaced correctly as a hard failure (the safe default for an unrecognized state) rather than a misclassification, then fixed by adding the second signal as a fallback candidate in the same detector's locator chain.

On UI drift specifically (the brief's secondary concern, since this environment assumes stable UIs): the locator fallback chain *is* the drift-tolerance mechanism, and `contentHash` is the detection signal — comparing it against a fresh recording tells you whether an artifact's assumptions still hold, without attempting any auto-healing.

## 4. Heterogeneity & multi-tenant

**Surface abstraction**: `src/shared/locator.ts` is the seam between "how we perceive/act on a surface" and "the recorded flow." Everything above it — the artifact schema, the replay engine's step loop — is surface-agnostic; only this one module would need a new implementation to target a different surface class. This is exactly why role/label locators were chosen as the *primary* strategy over CSS: role+name concepts map directly onto desktop accessibility APIs (Windows UI Automation, macOS Accessibility), so a desktop-targeting replay engine would reuse the artifact schema and step-loop control flow unchanged, swapping only this module. Legacy web with framesets is already handled for real, not just in principle — the schema's frame-aware `FrameLocator[]` path is exercised by the mock app's own iframe.

**Multi-tenant reuse**: `target.app` (vendor/product identity) is kept separate from `target.baseUrl` (tenant-specific) precisely so an artifact recorded once could, in principle, replay against any tenant's instance of the same underlying product by substituting `baseUrl` alone. `contentHash` — deliberately excluding `baseUrl`/`tenant`/`id`/`version`, including steps/checkpoints/outcomes/`target.app` — is the drift-detection signal: hash a fresh recording against a second tenant's instance and compare. A match means the artifact should still apply; a mismatch means per-tenant customization exists somewhere in the flow. `target.tenant` (`null` in this project) is the seam for a tenant-specific override record layered on a base artifact — not built, since the brief explicitly doesn't reward built-out multi-tenant infrastructure, but the schema doesn't paint itself into a corner on it.

## 5. Escalation & handoff

The mechanism is real, not simulated: an Express server started *inside the same Node process* as the automation, every handler closing over the identical Playwright `page` reference. "Same live session, not a fresh one" is structurally true — there is only ever one browser context for the whole run — not merely asserted.

All three trigger points the brief names route through this one mechanism (`src/escalation/`): a guardrail-blocked irreversible step (approve/reject), an otherwise-terminal replay hard failure (manual action, then resume/abort), and discovery hitting `max_steps`/`timeout`/`dead_end`. The console itself is deliberately bare — a screenshot plus a fixed vocabulary of click/fill/select/navigate-by-CSS-selector commands, or approve/reject for a pending irreversible step — not pixel-level co-browsing, which the brief explicitly excludes. Every human action is timestamped, recorded, and attached to the final result (`humanIntervention`); control transfer is implicit in whether the run's promise is still awaiting the escalation handler.

Two deliberate scope cuts, both documented rather than silently avoided: replay's "resume" re-verifies the artifact's final checkpoint(s) from wherever the human leaves the page, rather than resuming mid-sequence execution of remaining recorded steps — a human recovering a stuck run has to complete everything remaining themselves. Discovery's "resume" ends the run as `escalated_completed` without attempting to synthesize a new capability from the human's manual actions — a materially different, harder feature.

Allowlist violations (domain/route/action-type) never get an escalation offer — only `irreversible_blocked` does. Letting a human "approve past" an allowlist violation through the console would reopen the exact hole the allowlist exists to close; only the reversible/irreversible classification has a legitimate human-confirmation path.

## 6. Safety

Three allowlist dimensions — origins, route patterns, action types — live in `config/guardrails.json`, a runtime-loaded, zod-validated JSON file, not a compile-time constant: genuinely operator-editable without a code change. One `evaluateGuardrails` function is called identically by discovery (before a proposed action executes) and replay (before a recorded step executes), so the two paths can't drift apart on policy.

Irreversible actions are gated per-*step*, blocked by default, with the one legitimate override being explicit human confirmation via escalation — never silent, never automatic. Redaction is applied at every layer data could reach disk: live JSONL run logs (scrubbed per-event against a growing list of sensitive values, not just once at the end — a model's own narration can echo an already-extracted value back in prose at any later point), the full discovery transcript, and persisted replay results (the in-memory result returned to a real caller keeps actual values, since a caller needs them; the copy written as evidence is redacted the same way everything else is). Credentials never enter the LLM's context or a recorded artifact at all — login happens via direct Playwright calls before the discovery loop starts, not as a model-driven or recorded step.

Limits: redaction targets known-sensitive *declared* values by exact match plus a general currency-pattern regex, not general PII/NER — a member's name in free text would not be caught. This is a real gap, not one I'm papering over.

## 7. Cuts

- **No multi-tenant plumbing** — the schema seam (§4) exists, no per-tenant config store or override resolution was built.
- **No desktop automation** — the shared locator-resolution module is the seam; needs an OS-accessibility-API implementation swapped in.
- **No CDP-based direct session takeover** — the in-process HTTP relay console instead, verified end-to-end. CDP takeover (a human's own browser connecting to the live tab via remote debugging) is the more production-realistic next step; not built because I can't interactively verify it in this environment, and an unverified escalation path isn't one I'd want to ship as primary.
- **No step-level resume after a human fixes a stuck replay** — checkpoints are re-verified, remaining steps are not re-executed.
- **No "extract" action in the operator console** — a human can't populate a declared output during manual recovery, so a capability with outputs can't be fully human-recovered before its extract step runs.
- **Discovery doesn't synthesize a capability from a human's manual completion** during escalation.
- **Redaction is narrow**, not general PII/NER (§6).
- **Agent-facing capability catalog** (stretch goal) — not built, though `inputParams`/`outputs` are already shaped to make a typed tool-calling wrapper over `capabilities/*.json` + `runReplay` a thin addition later.

With more time, in this order: CDP-based operator takeover, step-level replay resume, and a second real tenant variant of the mock app to actually exercise `contentHash`-based drift detection rather than only designing for it.
