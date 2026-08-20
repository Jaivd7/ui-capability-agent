import type { Page } from "playwright";
import type { AppAdapter, Credentials, RecoveryActionImpl } from "./types.js";

/**
 * The original take-home target: a local, deliberately legacy-ish mock app.
 * Kept alongside the hosted one rather than retired, because "the same engine
 * drives two different targets" is a claim a reviewer can run, and the diff
 * alone is not.
 *
 * Its login form has real `<label>` elements, which is exactly why the core's
 * accessibility-first locator strategy looked universally right until it met a
 * target that has none.
 */

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const ACTIONS: Record<string, RecoveryActionImpl> = {
  reauth: {
    scope: "restart_flow",
    run: async (ctx) => {
      const adapter = LEGACY_CORE_BANKING;
      await adapter.login(ctx.page, ctx.target, credentialsFor(ctx.sessionRole));
    },
  },
  dismissAndRetry: {
    scope: "retry_step",
    run: async (ctx) => {
      // Generic dismiss: Escape closes any focused native or in-page modal
      // without needing to know its specific markup.
      await ctx.page.keyboard.press("Escape").catch(() => undefined);
    },
  },
  reloadAndRetry: {
    scope: "retry_step",
    run: async (ctx) => {
      await ctx.page.reload();
    },
  },
};

function credentialsFor(role: string): Credentials {
  const creds = LEGACY_CORE_BANKING.roles[role];
  if (!creds) throw new Error(`No credentials for role "${role}" on legacy-core-banking.`);
  return creds;
}

export const LEGACY_CORE_BANKING: AppAdapter = {
  id: "legacy-core-banking",
  displayName: "Meridian Core Banking (local mock)",

  target: (e) => ({
    app: "legacy-core-banking",
    baseUrl: e.MOCK_APP_BASE_URL ?? `http://localhost:${e.MOCK_APP_PORT ?? "4000"}`,
    entryRoute: "/members",
    tenant: null,
  }),

  roles: {
    teller: {
      username: env("MOCK_TELLER_USERNAME", "teller1"),
      password: env("MOCK_TELLER_PASSWORD", "bankdemo123"),
    },
    readonly: {
      username: env("MOCK_READONLY_USERNAME", "viewer1"),
      password: env("MOCK_READONLY_PASSWORD", "bankdemo123"),
    },
  },

  login: async (page: Page, target, credentials) => {
    await page.goto(`${target.baseUrl}/login`);
    await page.getByLabel("Username").fill(credentials.username);
    await page.getByLabel("Password").fill(credentials.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/members/, { timeout: 10_000 });
  },

  isLoggedOut: async (page: Page) => page.locator('input#username').isVisible().catch(() => false),

  recoveryActions: ACTIONS,
};
