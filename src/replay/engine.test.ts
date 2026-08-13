import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArtifact, type CapabilityArtifact } from "../artifact/index.js";
import { readonlyCredentials, tellerCredentials } from "../shared/credentials.js";
import { startAuthenticatedSession, type BrowserSession } from "../shared/session.js";
import { createRunLogger } from "../logging/logger.js";
import { setGuardrailsConfigForTest, type GuardrailsConfig } from "../guardrails/config.js";
import { evaluateGuardrails } from "../guardrails/policy.js";
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

async function withSession(fn: (session: BrowserSession) => Promise<void>): Promise<void> {
  process.env.HEADLESS = "true";
  const session = await startAuthenticatedSession(BASE_URL, tellerCredentials());
  try {
    await fn(session);
  } finally {
    await session.close();
  }
}

describe("replay engine (live, against the mock app)", () => {
  it(
    "success: replays lookup-member-balance and extracts the balance as a number",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const logger = createRunLogger("test-success", "/tmp/replay-engine-test");
        const result = await runReplay({
          artifact,
          params: { memberId: "1001" },
          page: session.page,
          dialogEvents: session.dialogEvents,
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

  it(
    "business outcome: an unknown member ID reports MEMBER_NOT_FOUND, not a crash",
    async () => {
      await withSession(async (session) => {
        const artifact = loadArtifact("lookup-member-balance");
        const logger = createRunLogger("test-business", "/tmp/replay-engine-test");
        const result = await runReplay({
          artifact,
          params: { memberId: "99999999" },
          page: session.page,
          dialogEvents: session.dialogEvents,
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
          artifact: broken,
          params: { memberId: "1001" },
          page: session.page,
          dialogEvents: session.dialogEvents,
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
          artifact,
          params: { memberId: "1001", accountType: "Standard Savings", openingDeposit: "100" },
          page: session.page,
          dialogEvents: session.dialogEvents,
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
          artifact: artifactWithIrreversibleStep,
          params: { memberId: "1001" },
          page: session.page,
          dialogEvents: session.dialogEvents,
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
});
