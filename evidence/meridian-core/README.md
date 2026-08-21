# MERIDIAN CORE evidence

Real runs against `web-sample.interface-hiring.com`. Nothing here is scripted
or fabricated. Files are named by *what they demonstrate* rather than by run id,
one clean example per case, curated from ~42 runs.

Each run has a `.jsonl` (the structured log), plus a `.result.json`,
`.transcript.json`, `.artifact.json`, `.quality.json`, `.probe.jsonl`,
`.failure.png` or `.escalation.png` where the run produced one.

## Which directory to read

| Directory | What it is |
|---|---|
| `curated/` | **Start here.** One clean example per case, named by what it demonstrates. This is the guided tour the rest of this file describes. |
| `discovery-run/` | Raw output from discovery runs, named by run id. Includes recordings made from the dashboard's Discovery tab as well as from `npm run discover`. |
| `replay-run/` | Raw output from replay and escalation runs, named by run id. |

`discovery-run/` and `replay-run/` are **uncurated**: they are what the system
actually wrote while the dashboard was being built and demonstrated, kept
because a reviewer asking "is the curated set representative or is it the
highlight reel?" deserves to be able to check. They include failed runs,
repeated attempts at the same thing, and runs deliberately given bad arguments
to exercise a path. Nothing in them is required to follow this README.

## The one to read first

**`escalation-with-refused-operator-actions.*`** — the whole safety story in a
single run:

1. A $150 transfer is invoked. The guardrail refuses to run the irreversible
   post step unattended, because the amount is at or above the approval
   threshold, and the run pauses (`escalation_pending`).
2. The operator tries to navigate the paused session to `/settings` — the
   target's global fault-injection config, deliberately left off the allowlist.
   **Refused**, `route_not_allowed`, and recorded.
3. The operator tries to navigate off-origin. **Refused**,
   `origin_not_allowed`, and recorded.
4. The operator approves. The artifact's *own* recorded step executes — not a
   hand-typed selector.
5. The run completes: `succeeded`, `escalated: true`, confirmation `CN480139`.

The refusals are in the run's own evidence, which is the point: the wrapper did
not become a way around the guardrails, and you can see it didn't.

## Discovery

`discovery-meridian-*.*` — one genuine Claude Sonnet 5 session per capability,
seven in total. The `.transcript.json` is the full message history; the
`.quality.json` is the recording score. Note `.probe.jsonl` on the four
read-only capabilities: the freshly compiled artifact replayed with a
*different* argument set to catch checkpoints fitted to the recording. The three
mutating capabilities have no probe, and their quality report says so — against
a shared, stateful target it would mean a second real transaction on every
recording.

## Replay

`replay-success-*.*` — deterministic replay, no LLM. Compare a `.jsonl` here
against a discovery run's: same step structure, zero `model_decision` events.

## The error taxonomy

| File | Tier |
|---|---|
| `business-outcome-share-on-hold.*` | business — the source share is frozen, so no transfer was posted |
| `business-outcome-insufficient-funds.*` | business — overdraw, caught at the review step before anything irreversible |
| `business-outcome-precondition.*` | business — a teller invoking the supervisor-only hold, refused *before any step ran* |
| `hard-failure-maintenance-interstitial.*` | recoverable, exhausted — detected, retried twice, then surfaced *naming the condition* rather than generically |
| `hard-failure-unrecovered.*` | hard failure with the failing step, expected vs. observed, a screenshot and a DOM snapshot |

`business-outcome-share-on-hold` is worth a look: that detector exists because a
*discovery* run hit it and stopped with an accurate diagnosis, and the
capability set was improved by a failed recording.

## What is not here

Credentials and session cookies appear nowhere — login runs via direct
Playwright calls before the model loop starts, so they never enter the model's
context or an artifact. `grep -c _token` across all seven artifacts returns 0:
a complete review → post flow with no token handling, because a real browser
submits the review screen's own hidden field.
