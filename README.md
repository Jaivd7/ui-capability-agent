# ui-capability-agent

A computer-use automation system for banks/credit unions with no APIs: an LLM
drives a real UI once to discover a task ("goal → discovery"), the successful
run is compiled into a typed, versioned, replayable **capability artifact**,
and that artifact then replays deterministically — no LLM in the loop —
handling real runtime errors and pausing for a human when it genuinely can't
proceed on its own.

See `/REPORT.md` for the design write-up (architecture, schema rationale,
determinism/error-handling, multi-tenant story, escalation, safety, cuts).

## What's here

| Path | What it is |
|---|---|
| `mock-app/` | The target: a deliberately legacy-ish "Meridian Core Banking" app (table layout, no test IDs, an iframe, one field with no accessible label at all) — see `REPORT.md` §4 for why this stand-in was chosen |
| `src/artifact/` | The capability schema (zod) — the reusable, versioned contract discovery produces and replay consumes |
| `src/discovery/` | The LLM-driven observe → decide → act loop (Claude Sonnet 5 + Playwright), and the compiler that turns a successful run into an artifact |
| `src/replay/` | The deterministic replay engine — no LLM — with the three-tier result contract (success / business outcome / hard failure) |
| `src/guardrails/` | Allowlist enforcement, irreversible-action gating, redaction |
| `src/escalation/` | The human handoff mechanism: pause, cede control of the *same* live session, resume |
| `src/shared/` | Locator resolution, value extraction, session/login — used identically by discovery and replay |
| `capabilities/` | The two recorded capability artifacts (the reusable output) |
| `evidence/` | Logs and results from real runs — see `evidence/README.md` |
| `config/guardrails.json` | The allowlist / irreversible-action policy (edit this, not code, to change it) |
| `LEARNING_NOTES.md` | Gitignored — my own running design log, not part of this submission |

## Setup

Requires Node 20+.

```sh
npm install
npx playwright install chromium
cp .env.example .env
```

Add your Anthropic API key to `.env` (only needed to run **discovery** —
replay never calls an LLM):

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Demo path — the exact commands

**1. Start the mock app** (leave running in its own terminal):

```sh
npm run mock-app
# Meridian Core Banking listening on http://localhost:4000
```

**2. Run the agent on a goal** (a real, live Claude Sonnet 5 session driving
Playwright against the app above — this is the one step that costs a small
amount of API spend, roughly a few cents):

```sh
npm run discover -- --capability lookup-member-balance
```

This searches for member `1001`, reads their savings balance, and — on
success — writes the compiled artifact to `capabilities/lookup-member-balance.json`
plus a full evidence trail (structured log + redacted transcript) to
`evidence/discovery-run/`. The other available goal:

```sh
npm run discover -- --capability open-sub-account
```

Opens a new sub-account for member `1001` and stops at the confirmation
screen — deliberately never clicking the final irreversible "Confirm & Open
Account" button (goal-scoping, backstopped by the guardrail layer).

**3. Replay the resulting artifact — no LLM involved:**

```sh
npm run replay -- --capability lookup-member-balance --param memberId=1001
```

```sh
npm run replay -- --capability open-sub-account \
  --param memberId=1001 --param accountType="Standard Savings" --param openingDeposit=100
```

Prints a structured result (`success` with typed outputs, a `business_outcome`
like `MEMBER_NOT_FOUND`, or a `hard_failure` with the failing step and
expected/observed detail) and writes the same evidence shape to
`evidence/replay-run/`.

**Trigger the error/exceptional-state paths on purpose:**

```sh
# business outcome: no such member
npm run replay -- --capability lookup-member-balance --param memberId=99999 --evidence-dir replay-error-run

# business outcome: role-gated action, wrong role
npm run replay -- --capability open-sub-account --role readonly \
  --param memberId=1001 --param accountType="Standard Savings" --param openingDeposit=100 --evidence-dir replay-error-run
```

**Escalation / human handoff** — pause on a stuck run and open a real
operator console against the live session:

```sh
npm run replay -- --capability lookup-member-balance --param memberId=1001 --escalate
```

If the run gets stuck, the console URL is printed to the terminal
(`http://localhost:<port>/`) — open it in a browser to see the live
screenshot, the reason automation paused, and take manual action or
resume/abort. See `evidence/escalation-run/` for a full recorded example
(including the exact HTTP calls used to drive it), and `REPORT.md` §5 for
the design.

## Running without live services

Nothing here needs external services beyond the mock app you start yourself
(no cloud dependency, no real bank system). To review the project **without
running anything**, `evidence/` contains full logs/results from real runs
already — see `evidence/README.md` for a guided tour.

## Tests

```sh
npm run typecheck
npm test
```

The replay-engine and guardrail-policy tests are live integration tests —
they spawn the real mock app and drive it with a real headless Playwright
browser (no LLM, so no API cost). Takes about a minute.

## Configuration

- `config/guardrails.json` — allowed origins/routes/action types, and the
  irreversible-action policy. Edit this to change what the agent is
  permitted to do; no code change required.
- `.env` — `ANTHROPIC_API_KEY` (discovery only), `MOCK_APP_PORT`,
  `HEADLESS=false` to watch the browser during discovery/replay.
