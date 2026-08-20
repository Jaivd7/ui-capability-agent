# Evidence

Everything here comes from real runs against the live mock app (`mock-app/`) —
nothing is scripted or fabricated. See `/README.md` for the exact commands to
reproduce any of it, and `/REPORT.md` for the design reasoning. Sensitive
values (account balances) are redacted in every persisted file the same way;
see `src/guardrails/redact.ts`. No value read off a page appears in any
committed artifact at all — that is a property of the compiler now, not of
redaction.

## `discovery-run/` — the required live LLM-driven run

Two genuine Claude Sonnet 5 discovery sessions, each producing:

| File | What it is |
|---|---|
| `.artifact.json` | the compiled capability, identical to what's in `/capabilities/` |
| `.jsonl` | structured run log — every tool call, locator reasoning, observation |
| `.transcript.json` | the full Anthropic message history, redacted |
| `.probe.jsonl` | the differential probe: this artifact replayed with *different* arguments, no LLM |
| `.quality.json` | the recording-quality report (findings never echo the offending value) |

- `lookup-member-balance-*` — 4 steps, search → detail → extract. Graded
  **B (87/100)**, probe green against member 1002.
- `open-sub-account-*` — 7 steps, search → detail → form → confirmation,
  including a native `confirm()` dialog auto-accepted mid-flow. The model
  correctly stopped at the confirmation screen without clicking the
  irreversible "Confirm & Open Account" button — goal-scoping working as
  intended. Graded **B (80/100)**, probe green against a different member,
  account type *and* deposit.

## `discovery-rejected-run/` — two runs the system refused to ship

The more interesting half of the discovery evidence: recordings that looked
successful and were caught anyway.

- `lookup-member-balance-1787246622604` — the model located the balance cell
  as `role=cell, name="Savings Balance"`. The mock app renders
  `<td>Savings Balance</td><td aria-label="Savings Balance">$3482.10</td>`, so
  that matched **both** cells and the run extracted the *label text* as a
  member's balance. The run "succeeded"; the compiler refused to write the
  artifact. There is no `.artifact.json` here because none was produced. This
  is why locator resolution is now strict for actions and extractions.
- `lookup-member-balance-1787246804295` — a clean run whose **differential
  probe failed**. The model wrote a structurally correct assertion
  (`textContains "Member:"`) on a locator that still named the recorded
  member (`role=heading, name="Member: Alicia Gomez"`), so it resolved nothing
  for member 1002. No static rule can catch this — the member's name is
  neither an input parameter nor an extracted output — which is precisely what
  the probe exists for. `.quality.json` shows it as the single error.

## `replay-run/` — deterministic replay, no LLM

Four successful replays. Compare any `.jsonl` here against a discovery run's:
same step structure, zero model calls, fully deterministic.

- Each capability with the arguments it was recorded against.
- Each capability with arguments it was **never** recorded against
  (`memberId=1002`; `{1003, "Holiday Club", 1500}`). These are the runs that
  demonstrate a capability is genuinely reusable rather than a replay of one
  session — and the ones that fail outright without the parameterization work.

## `replay-error-run/` — the three-tier error taxonomy

- `lookup-member-balance-*` (memberId=99999) — **business outcome**:
  `MEMBER_NOT_FOUND`. A legitimate result, not a crash.
- `open-sub-account-*` (readonly role) — **business outcome**:
  `PERMISSION_DENIED`, raised from `preconditions.requiredRole` *before any
  step runs* rather than discovered mid-flow. The mid-flow detector remains as
  the backstop for a role the caller misreports, and is exercised in
  `src/replay/engine.test.ts`.
- `lookup-member-balance-broken-demo-*` — **hard failure**, triggered on
  purpose via `lookup-member-balance-broken-demo.artifact-input.json` (a copy
  of the real artifact with one locator deliberately corrupted). Includes a
  failure screenshot and DOM snapshot alongside the structured log — the
  debuggable detail (which step, what was tried, what happened) the brief asks
  for. Note the `contentHash` warning at the top of the run: a hand-edited
  artifact is refused by default, and this one is only runnable because
  `--allow-hash-mismatch` was passed deliberately.

## `escalation-run/` — human-in-the-loop handoff, live end to end

`lookup-member-balance-escalation-demo.artifact-input.json` is the real
artifact with one step (the search click) marked `irreversible: true` — the
same lever a human reviewer would use to gate a genuinely consequential step.
Replaying it with `--escalate`:

1. The guardrail blocks the step and pauses automation, capturing a screenshot
   and opening a real HTTP operator console (`.console-snapshot.html` is what
   that console rendered).
2. A `POST /approve` against that live console — the same request a human's
   browser would send — runs the actual step for real, against the *same*
   Playwright session automation was paused on.
3. Automation resumes and completes the remaining steps to success.

The `.jsonl` carries the whole timeline in order: `escalation_raised` →
`escalation_console_started` → `human_action` → `escalation_resolved` →
`step_result` with `humanApproved: true` → the remaining steps →
`checkpoint_passed` for each checkpoint that actually verified. The
`.result.json`'s `humanIntervention` field records what happened and when.

The other two escalation triggers (a stuck replay recovered by manual action,
and discovery hitting `max_steps`) are covered by live integration tests in
`src/replay/engine.test.ts` rather than a second static evidence folder — see
that file for the same mechanism exercised two more ways. The recoverable tier
(session expiry → re-authenticate → restart the flow) is covered there too,
including a test that the recovered session keeps the role it started with.
