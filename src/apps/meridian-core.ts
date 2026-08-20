import type { Page } from "playwright";
import type { AppAdapter, Credentials, RecoveryActionImpl } from "./types.js";

/**
 * MERIDIAN CORE — the hosted target.
 *
 * Two properties of this app shaped more of the adaptation than anything else:
 *
 *  - **No accessibility affordances at all.** Not one `<label>`, `for=`,
 *    `aria-*`, `role=`, `id=` or test id on any page; nested `<table>` with
 *    `<td class="lbl">` as purely visual labels. So sign-on is located by
 *    `name` attribute, which is part of the form's submission contract rather
 *    than its styling — stable in exactly the way a class or `nth-child` isn't.
 *  - **Sign-on takes a third field**, `branch`, as a `<select>`. It isn't
 *    required (the app defaults to MAIN-001), but it's the concrete reason a
 *    login adapter had to be a function rather than a table of strings.
 */

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** Sleep between retries of a transient server fault. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ACTIONS: Record<string, RecoveryActionImpl> = {
  reauth: {
    scope: "restart_flow",
    run: async (ctx) => {
      await MERIDIAN_CORE.login(ctx.page, ctx.target, credentialsFor(ctx.sessionRole));
    },
  },
  dismissAndRetry: {
    scope: "retry_step",
    run: async (ctx) => {
      // The maintenance interstitial offers a "Continue" link; fall back to
      // Escape for anything modal that doesn't.
      const cont = ctx.page.getByRole("link", { name: "Continue" });
      if (await cont.isVisible().catch(() => false)) {
        await cont.click().catch(() => undefined);
        return;
      }
      await ctx.page.keyboard.press("Escape").catch(() => undefined);
    },
  },
  reloadAndRetry: {
    scope: "retry_step",
    run: async (ctx) => {
      // A 500 here is modelled as transient, so back off before retrying
      // rather than hammering. The delay lives in the action implementation
      // rather than in the schema because the recovery-action registry is
      // already per-app and `run(ctx)` is a free function — widening the
      // schema's closed enum to express "sleep first" would be a format
      // change to encode an app-specific fact.
      await sleep(retryDelayMs(ctx.attempt));
      await ctx.page.reload();
    },
  },
};

/**
 * ~1s then ~2s. Deliberately not full exponential growth: `maxAttempts` stays
 * small, so the tail would never be reached and the demo would just be slower.
 */
function retryDelayMs(attempt: number): number {
  return attempt <= 1 ? 1_000 : 2_000;
}

function credentialsFor(role: string): Credentials {
  const creds = MERIDIAN_CORE.roles[role];
  if (!creds) throw new Error(`No credentials for role "${role}" on meridian-core.`);
  return creds;
}

export const MERIDIAN_CORE: AppAdapter = {
  id: "meridian-core",
  displayName: "MERIDIAN CORE (credit-union member servicing console)",

  target: (e) => ({
    app: "meridian-core",
    baseUrl: e.MERIDIAN_BASE_URL ?? "https://web-sample.interface-hiring.com",
    entryRoute: "/menu",
    tenant: null,
  }),

  roles: {
    teller: {
      username: env("MERIDIAN_TELLER_USERNAME", "teller1"),
      password: env("MERIDIAN_TELLER_PASSWORD", "password"),
      extra: { branch: env("MERIDIAN_BRANCH", "MAIN-001") },
    },
    supervisor: {
      username: env("MERIDIAN_SUPERVISOR_USERNAME", "super1"),
      password: env("MERIDIAN_SUPERVISOR_PASSWORD", "password"),
      extra: { branch: env("MERIDIAN_BRANCH", "MAIN-001") },
    },
  },

  login: async (page: Page, target, credentials) => {
    await page.goto(`${target.baseUrl}/signon`);
    // Located by `name`, not by label — this form has no labels at all.
    await page.locator('input[name="operator"]').fill(credentials.username);
    await page.locator('input[name="password"]').fill(credentials.password);
    const branch = credentials.extra?.branch;
    if (branch) {
      await page.locator('select[name="branch"]').selectOption(branch);
    }
    await page.locator('input[type="submit"][value="Sign On"]').click();
    // A failed sign-on redirects back to /signon?err=... rather than erroring,
    // so waiting for /menu is what distinguishes success from failure.
    await page.waitForURL(/\/menu/, { timeout: 15_000 });
  },

  isLoggedOut: async (page: Page) =>
    page.locator('input[name="operator"]').isVisible().catch(() => false),

  recoveryActions: ACTIONS,
};
