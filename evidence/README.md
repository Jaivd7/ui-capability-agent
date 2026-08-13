# Evidence

Everything here comes from real runs against the live mock app (`mock-app/`) —
nothing is scripted or fabricated. See `/README.md` for the exact commands to
reproduce any of it, and `/REPORT.md` for the design reasoning. Sensitive
values (account balances) are redacted in every persisted file the same way;
see `src/guardrails/redact.ts`.

## `discovery-run/` — the required live LLM-driven run

Two genuine Claude Sonnet 5 discovery sessions, each producing a
`.artifact.json` (the compiled capability, identical to what's now in
`/capabilities/`), a `.jsonl` structured run log (every tool call, locator
reasoning, and observation), and a `.transcript.json` (the full Anthropic
message history, redacted).

- `lookup-member-balance-*` — 4 steps, search → detail → extract.
- `open-sub-account-*` — 7 steps, search → detail → form → confirmation,
  including a native `confirm()` dialog auto-accepted mid-flow. The model
  correctly stopped at the confirmation screen without clicking the
  irreversible "Confirm & Open Account" button — goal-scoping working as
  intended.

## `replay-run/` — deterministic replay, no LLM

One successful replay of each capability. Compare the `.jsonl` log here
against the discovery run's: same step structure, zero model calls, fully
deterministic.

## `replay-error-run/` — the three-tier error taxonomy

- `lookup-member-balance-*` (memberId=99999) — **business outcome**:
  `MEMBER_NOT_FOUND`. A legitimate result, not a crash.
- `open-sub-account-*` (readonly role) — **business outcome**:
  `PERMISSION_DENIED`. A real detector-coverage gap was found and fixed
  while building this — see `LEARNING_NOTES.md`'s Phase 3 entry (not part
  of this submission, but happy to walk through it).
- `lookup-member-balance-broken-demo-*` — **hard failure**, triggered on
  purpose via `lookup-member-balance-broken-demo.artifact-input.json` (a
  copy of the real artifact with one locator deliberately corrupted).
  Includes a failure screenshot and DOM snapshot alongside the structured
  log — the debuggable detail (which step, what was tried, what happened)
  the brief asks for.

## `escalation-run/` — human-in-the-loop handoff, live end to end

`lookup-member-balance-escalation-demo.artifact-input.json` is the real
artifact with one step (the search click) marked `irreversible: true` — the
same lever a human reviewer would use to gate a genuinely consequential
step. Replaying it with `--escalate`:

1. The guardrail blocks the step and pauses automation, capturing a
   screenshot and opening a real HTTP operator console (`.console-snapshot.html`
   is what that console rendered).
2. A `POST /approve` against that live console — the same request a human's
   browser would send — runs the actual step for real, against the *same*
   Playwright session automation was paused on.
3. Automation resumes and completes the remaining steps to success.

The `.result.json`'s `humanIntervention` field records exactly what
happened and when. The other two escalation triggers (a stuck replay
recovered by manual action, and discovery hitting `max_steps`) are covered
by live integration tests in `src/replay/engine.test.ts` rather than a
second static evidence folder — see that file for the same mechanism
exercised two more ways.
