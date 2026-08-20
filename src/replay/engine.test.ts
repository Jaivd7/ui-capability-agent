import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArtifact, type CapabilityArtifact } from "../artifact/index.js";
import { credentialsForRole, readonlyCredentials, type SessionRole } from "../shared/credentials.js";
import { startAuthenticatedSession, type BrowserSession } from "../shared/session.js";
import { createRunLogger, type LogEvent, type RunLogger } from "../logging/logger.js";
import { setGuardrailsConfigForTest, type GuardrailsConfig } from "../guardrails/config.js";
import { evaluateGuardrails } from "../guardrails/policy.js";
import { createEscalationHandler } from "../escalation/operator-server.js";
import { runReplay } from "./engine.js";

/**
 * Integration tests, not unit tests: they boot the real mock app as a
 * subprocess and drive it with a real (headless) Playwright browser, the
 * same way the CLI does. Deliberately not mocking Playwright or the app —
 * the whole point of the replay engine is "does it actually work against a
 * live surface," and a mocked-out version of that proves nothing about the
 * thing that matters. Runs on a dedicated port so this can run alongside a
 * manually-started dev instance without colliding.
 */

const TEST_PORT = 4099;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;

function loadArtifact(id: string): CapabilityArtifact {
  const raw = JSON.parse(readFileSync(new URL(`../../capabilities/${id}.json`, import.meta.url), "utf-8"));
  raw.target = { ...raw.target, baseUrl: BASE_URL };
  const result = parseArtifact(raw);
  if (!result.success) throw new Error(result.errors.join("\n"));
  return result.artifact;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE_URL}/login`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("mock app did not become ready in time");
}

beforeAll(async () => {
  serverProcess = spawn("npx", ["tsx", "mock-app/server.ts"], {
    env: { ...process.env, MOCK_APP_PORT: String(TEST_PORT) },
    stdio: "ignore",
  });
  await waitForServer();
}, 30_000);

afterAll(() => {
  serverProcess.kill();
});

function capturingLogger(runId: string, sink: LogEvent[]): RunLogger {
  const base = createRunLogger(runId, "/tmp/replay-engine-test");
  return {
    filePath: base.filePath,
    log: (event) => {
      sink.push(event);
      base.log(event);
    },
  };
}

async function withSession(
  fn: (session: BrowserSession) => Promise<void>,
  role: SessionRole = "teller",
): Promise<void> {
  process.env.HEADLESS = "true";
  const session = await startAuthenticatedSession(BASE_URL, credentialsForRole(role));
  try {
    await fn(session);
  } finally {
    await session.close();
  }
}

/**
 * The mock app's dev lever: makes the *next* request take the identical
 * getSession-returns-null path a natural timeout would.
 */
async function expireSession(session: BrowserSession): Promise<void> {
  await session.page.goto(`${BASE_URL}/dev/expire-session`, { waitUntil: "load" });
}

describe("replay engine (live, against the mock app)", () => {
  it(
    "success: replays lookup-member-balance and extracts the balance as a number",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const logger = createRunLogger("test-success", "/tmp/replay-engine-test");
        const result = await runReplay({
          runId: `test-run-1`,
          artifact,
          params: { memberId: "1001" },
          page: session.page,
          logger,
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          expect(typeof result.outputs.savingsBalance).toBe("number");
          expect(result.outputs.savingsBalance).toBeCloseTo(3482.1);
        }
      });
    },
    20_000,
  );

  // The regression this whole parameterization pass exists for. Before it,
  // these two walked every step correctly against a real member and then
  // hard-failed on a checkpoint asserting the *recorded* member's name — the
  // capability was parameterized in its steps and hardcoded in its proof.
  it.each([
    ["1002", 128.0],
    ["1003", 15200.77],
  ])(
    "success: replays lookup-member-balance for a member it was not recorded against (%s)",
    async (memberId, expected) => {
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const logger = createRunLogger(`test-param-${memberId}`, "/tmp/replay-engine-test");
        const result = await runReplay({
          runId: `test-run-param-${memberId}`,
          artifact,
          params: { memberId },
          page: session.page,
          logger,
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          expect(result.outputs.savingsBalance).toBeCloseTo(expected);
        }
      });
    },
    20_000,
  );

  it(
    "success: replays open-sub-account with arguments it was not recorded against",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("open-sub-account");
        const logger = createRunLogger("test-param-sub", "/tmp/replay-engine-test");
        const result = await runReplay({
          runId: "test-run-param-sub",
          artifact,
          params: {
            memberId: "1003",
            accountType: "Holiday Club",
            // 1500 rather than a round number on purpose: the app renders
            // `$${n.toFixed(2)}` with no separator, so a currency formatter
            // that grouped thousands would pass for 100 and fail here.
            openingDeposit: 1500,
          },
          page: session.page,
          logger,
        });
        expect(result.status).toBe("success");
      });
    },
    30_000,
  );

  // The recoverable tier of the taxonomy, which had no coverage at all despite
  // the mock app shipping /dev/expire-session specifically to enable it.
  it(
    "recoverable: a session that expires mid-flow is re-authenticated and the flow restarts to success",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const events: LogEvent[] = [];
        const logger = capturingLogger("test-reauth", events);
        await expireSession(session);

        const result = await runReplay({
          runId: "test-run-reauth",
          artifact,
          params: { memberId: "1001" },
          page: session.page,
          logger,
          sessionRole: "teller",
        });

        expect(result.status).toBe("success");
        expect(events.some((e) => e.type === "known_outcome" && e.outcomeId === "session-expired")).toBe(true);
        expect(events.some((e) => e.type === "flow_restart")).toBe(true);
      });
    },
    40_000,
  );

  it(
    "recoverable: re-authentication restores the run's own role, it does not escalate to teller",
    async () => {
      // reauth used to log back in with tellerCredentials() unconditionally, so
      // a readonly run that hit a timeout came back with more privilege than it
      // started with -- and then sailed past the permission denial it should
      // have reported.
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const logger = createRunLogger("test-reauth-role", "/tmp/replay-engine-test");
        await expireSession(session);

        const result = await runReplay({
          runId: "test-run-reauth-role",
          artifact,
          params: { memberId: "1001" },
          page: session.page,
          logger,
          sessionRole: "readonly",
        });
        expect(result.status).toBe("success");

        // The session that recovered must still be readonly: the member page
        // shows the role-gated notice instead of the Open Sub-Account link.
        await session.page.goto(`${BASE_URL}/members/1001`, { waitUntil: "load" });
        await expect(
          session.page.getByText("Sub-account actions require teller role.").isVisible(),
        ).resolves.toBe(true);
      }, "readonly");
    },
    40_000,
  );

  it(
    "recoverable: a retry_step recovery re-executes the step, and exhausting it names the condition",
    async () => {
      // dismissAndRetry / reloadAndRetry declare scope "retry_step", which the
      // engine mapped to plain continuation -- so they ran their recovery and
      // then skipped the very step that needed retrying. With the scope
      // honoured, a detector that keeps matching burns its maxAttempts and
      // becomes a hard failure that names it, rather than quietly proceeding.
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const withStickyCondition: CapabilityArtifact = {
          ...artifact,
          knownOutcomes: [
            ...artifact.knownOutcomes,
            {
              id: "sticky-interstitial",
              description: "A condition that a reload never clears.",
              checkAfterStepId: artifact.steps[0]!.id,
              classification: "recoverable",
              detect: {
                frame: [],
                locator: [
                  {
                    strategy: "text",
                    text: "MERIDIAN CORE BANKING",
                    exact: false,
                    reason: "always-present banner, so the condition never resolves",
                  },
                ],
              },
              recovery: { action: "reloadAndRetry", maxAttempts: 1 },
            },
          ],
        };
        const events: LogEvent[] = [];
        const logger = capturingLogger("test-retry-step", events);

        const result = await runReplay({
          runId: "test-run-retry-step",
          artifact: withStickyCondition,
          params: { memberId: "1001" },
          page: session.page,
          logger,
          sessionRole: "teller",
        });

        expect(result.status).toBe("hard_failure");
        if (result.status === "hard_failure") {
          expect(result.reason).toContain("sticky-interstitial");
        }
        // The step really was re-executed, rather than the loop moving on.
        expect(events.filter((e) => e.type === "step_retry")).toHaveLength(1);
      });
    },
    40_000,
  );

  it(
    "precondition: a session without the required role fails fast, before touching the app",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("open-sub-account");
        const events: LogEvent[] = [];
        const logger = capturingLogger("test-required-role", events);

        const result = await runReplay({
          runId: "test-run-required-role",
          artifact,
          params: { memberId: "1001", accountType: "Standard Savings", openingDeposit: 100 },
          page: session.page,
          logger,
          sessionRole: "readonly",
        });

        expect(result.status).toBe("business_outcome");
        if (result.status === "business_outcome") {
          expect(result.code).toBe("PERMISSION_DENIED");
        }
        // Fast means fast: no step ran at all.
        expect(events.filter((e) => e.type === "step_result")).toHaveLength(0);
      }, "readonly");
    },
    30_000,
  );

  it(
    "business outcome: an unknown member ID reports MEMBER_NOT_FOUND, not a crash",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const logger = createRunLogger("test-business", "/tmp/replay-engine-test");
        const result = await runReplay({
          runId: `test-run-2`,
          artifact,
          params: { memberId: "99999999" },
          page: session.page,
          logger,
        });
        expect(result.status).toBe("business_outcome");
        if (result.status === "business_outcome") {
          expect(result.code).toBe("MEMBER_NOT_FOUND");
        }
      });
    },
    20_000,
  );

  it(
    "hard failure: a locator that can never resolve reports which step and what was tried",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const broken: CapabilityArtifact = {
          ...artifact,
          steps: artifact.steps.map((s) =>
            s.type === "click"
              ? {
                  ...s,
                  locator: [
                    {
                      strategy: "role",
                      role: "button",
                      name: "ThisButtonDoesNotExist",
                      exact: true,
                      reason: "deliberately broken for this test",
                    },
                  ],
                }
              : s,
          ),
        };
        const logger = createRunLogger("test-hard-failure", "/tmp/replay-engine-test");
        const result = await runReplay({
          runId: `test-run-4`,
          artifact: broken,
          params: { memberId: "1001" },
          page: session.page,
          logger,
        });
        expect(result.status).toBe("hard_failure");
        if (result.status === "hard_failure") {
          expect(result.stepId).toBe("step-2");
          expect(result.observed).toContain("ThisButtonDoesNotExist");
        }
      });
    },
    20_000,
  );

  it(
    "permission denied: a readonly session gets a clean business outcome, not a hard failure",
    async () => {
      process.env.HEADLESS = "true";
      const session = await startAuthenticatedSession(BASE_URL, readonlyCredentials());
      try {
        const artifact = loadArtifact("open-sub-account");
        const logger = createRunLogger("test-permission-denied", "/tmp/replay-engine-test");
        const result = await runReplay({
          runId: `test-run-3`,
          artifact,
          params: { memberId: "1001", accountType: "Standard Savings", openingDeposit: "100" },
          page: session.page,
          logger,
        });
        expect(result.status).toBe("business_outcome");
        if (result.status === "business_outcome") {
          expect(result.code).toBe("PERMISSION_DENIED");
        }
      } finally {
        await session.close();
      }
    },
    20_000,
  );

  it(
    "guardrail: a step marked irreversible is blocked before it ever executes, not attempted",
    async () => {
      // Neither real capability actually contains an irreversible step —
      // goal-scoping during discovery kept the model from ever proposing
      // the sub-account flow's final "Confirm & Open Account" click, so
      // that guardrail path has never fired for real. This test proves the
      // *mechanism* independently: flip one step's irreversible flag by
      // hand (standing in for what a human reviewer marking a step
      // dangerous would do) and confirm replay refuses to run it.
      const testGuardrailsConfig: GuardrailsConfig = {
        allowedOrigins: [BASE_URL],
        allowedRoutePatterns: ["^/(login|logout|members(/.*)?|dev/expire-session)$"],
        allowedActionTypes: ["navigate", "click", "fill", "select", "check", "waitFor", "extract"],
        irreversibleActionPolicy: "block",
      };
      setGuardrailsConfigForTest(testGuardrailsConfig);

      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const dangerousStepId = artifact.steps[1]!.id; // the "Search" click
        const artifactWithIrreversibleStep: CapabilityArtifact = {
          ...artifact,
          steps: artifact.steps.map((s) => (s.id === dangerousStepId ? { ...s, irreversible: true } : s)),
        };
        const logger = createRunLogger("test-guardrail-irreversible", "/tmp/replay-engine-test");
        const result = await runReplay({
          runId: `test-run-5`,
          artifact: artifactWithIrreversibleStep,
          params: { memberId: "1001" },
          page: session.page,
          logger,
          guardrail: (step, ctx) => evaluateGuardrails(step, ctx, testGuardrailsConfig),
        });
        expect(result.status).toBe("hard_failure");
        if (result.status === "hard_failure") {
          expect(result.stepId).toBe(dangerousStepId);
          expect(result.reason).toMatch(/blocked by guardrail/i);
          expect(result.reason).toMatch(/irreversible/i);
        }
      });
    },
    20_000,
  );

  /**
   * Intercepts the `escalation_console_started` log event to learn the
   * operator console's URL the moment it comes up, without runReplay ever
   * returning it directly — matching how a real deployment would only
   * surface the URL through logs/notifications, not a return value, since
   * runReplay's promise doesn't resolve until *after* escalation ends.
   */
  function loggerCapturingConsoleUrl(runId: string): { logger: RunLogger; consoleUrl: Promise<string> } {
    const base = createRunLogger(runId, "/tmp/replay-engine-test");
    let resolveUrl!: (url: string) => void;
    const consoleUrl = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const logger: RunLogger = {
      filePath: base.filePath,
      log: (event: LogEvent) => {
        base.log(event);
        if (event.type === "escalation_console_started") resolveUrl(event.consoleUrl as string);
      },
    };
    return { logger, consoleUrl };
  }

  it(
    "escalation: a human approves the irreversible step through the real operator console, and the run completes",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const dangerousStepId = artifact.steps[1]!.id; // the "Search" click
        const artifactWithIrreversibleStep: CapabilityArtifact = {
          ...artifact,
          steps: artifact.steps.map((s) => (s.id === dangerousStepId ? { ...s, irreversible: true } : s)),
        };
        const testGuardrailsConfig: GuardrailsConfig = {
          allowedOrigins: [BASE_URL],
          allowedRoutePatterns: ["^/(login|logout|members(/.*)?|dev/expire-session)$"],
          allowedActionTypes: ["navigate", "click", "fill", "select", "check", "waitFor", "extract"],
          irreversibleActionPolicy: "block",
        };
        setGuardrailsConfigForTest(testGuardrailsConfig);

        const { logger, consoleUrl } = loggerCapturingConsoleUrl("test-escalation-approve");
        const resultPromise = runReplay({
          runId: "test-escalation-approve",
          artifact: artifactWithIrreversibleStep,
          params: { memberId: "1001" },
          page: session.page,
          logger,
          guardrail: (step, ctx) => evaluateGuardrails(step, ctx, testGuardrailsConfig),
          escalate: createEscalationHandler(session.page, logger, "/tmp/replay-engine-test"),
        });

        // Act as the human operator would: load the console, then approve —
        // real HTTP calls against the real server the automation opened,
        // driving the *same* live page the automation was paused on.
        const url = await consoleUrl;
        const consoleHtml = await (await fetch(url)).text();
        expect(consoleHtml).toContain("Approve");
        expect(consoleHtml).toContain(dangerousStepId);

        const approveRes = await fetch(new URL("/approve", url), { method: "POST" });
        expect(approveRes.ok).toBe(true);

        const result = await resultPromise;
        expect(result.status).toBe("success");
        if (result.status === "success") {
          expect(result.humanIntervention?.decision).toBe("resumed");
          expect(result.humanIntervention?.actions.some((a) => a.type === "approve_step")).toBe(true);
        }
      });
    },
    20_000,
  );

  it(
    "escalation: a human rejects the irreversible step, and the run ends as a hard failure with the rejection recorded",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const dangerousStepId = artifact.steps[1]!.id;
        const artifactWithIrreversibleStep: CapabilityArtifact = {
          ...artifact,
          steps: artifact.steps.map((s) => (s.id === dangerousStepId ? { ...s, irreversible: true } : s)),
        };
        const testGuardrailsConfig: GuardrailsConfig = {
          allowedOrigins: [BASE_URL],
          allowedRoutePatterns: ["^/(login|logout|members(/.*)?|dev/expire-session)$"],
          allowedActionTypes: ["navigate", "click", "fill", "select", "check", "waitFor", "extract"],
          irreversibleActionPolicy: "block",
        };
        setGuardrailsConfigForTest(testGuardrailsConfig);

        const { logger, consoleUrl } = loggerCapturingConsoleUrl("test-escalation-reject");
        const resultPromise = runReplay({
          runId: "test-escalation-reject",
          artifact: artifactWithIrreversibleStep,
          params: { memberId: "1001" },
          page: session.page,
          logger,
          guardrail: (step, ctx) => evaluateGuardrails(step, ctx, testGuardrailsConfig),
          escalate: createEscalationHandler(session.page, logger, "/tmp/replay-engine-test"),
        });

        const url = await consoleUrl;
        const rejectRes = await fetch(new URL("/reject", url), { method: "POST" });
        expect(rejectRes.ok).toBe(true);

        const result = await resultPromise;
        expect(result.status).toBe("hard_failure");
        if (result.status === "hard_failure") {
          expect(result.reason).toMatch(/rejected by operator/i);
          expect(result.humanIntervention?.decision).toBe("aborted");
          expect(result.humanIntervention?.actions.some((a) => a.type === "reject")).toBe(true);
        }
      });
    },
    20_000,
  );

  it(
    "escalation: a stuck replay (unrecognized hard failure) is recovered by a human's manual action, then resumes to success",
    async () => {
      // Different trigger from the irreversible-confirmation tests above:
      // this is the "replay hits a condition it can't recover from" case
      // (brief §3.6), not a guardrail block. Breaks the sub-account flow's
      // final "Continue" click so automation hard-fails one step short of
      // the checkpoint, then has the "operator" perform that one click
      // manually through the console's generic action form (not the
      // approve/reject confirmation UI) and signal resume.
      await withSession(async (session) => {
        const artifact = loadArtifact("open-sub-account");
        const continueStepId = artifact.steps[artifact.steps.length - 1]!.id;
        const brokenArtifact: CapabilityArtifact = {
          ...artifact,
          steps: artifact.steps.map((s) =>
            s.id === continueStepId && s.type === "click"
              ? {
                  ...s,
                  locator: [
                    { strategy: "css", selector: "#doesNotExist", reason: "deliberately broken for this test" },
                  ],
                }
              : s,
          ),
        };

        const { logger, consoleUrl } = loggerCapturingConsoleUrl("test-escalation-manual-recovery");
        const resultPromise = runReplay({
          runId: "test-escalation-manual-recovery",
          artifact: brokenArtifact,
          params: { memberId: "1001", accountType: "Standard Savings", openingDeposit: "100" },
          page: session.page,
          logger,
          escalate: createEscalationHandler(session.page, logger, "/tmp/replay-engine-test"),
        });

        const url = await consoleUrl;
        const consoleHtml = await (await fetch(url)).text();
        expect(consoleHtml).toContain("Manual action");

        const clickRes = await fetch(new URL("/action", url), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ type: "click", target: "#continueBtn" }),
        });
        expect(clickRes.ok).toBe(true);

        const resumeRes = await fetch(new URL("/resume", url), { method: "POST" });
        expect(resumeRes.ok).toBe(true);

        const result = await resultPromise;
        expect(result.status).toBe("success");
        if (result.status === "success") {
          expect(result.humanIntervention?.decision).toBe("resumed");
          expect(result.humanIntervention?.actions.map((a) => a.type)).toEqual(["click", "resume"]);
        }
      });
    },
    45_000,
  );
});
