import type { Page } from "playwright";
import type { MockCredentials } from "./credentials.js";

/**
 * Raw login steps only — no browser/context lifecycle. Used both to
 * bootstrap a fresh discovery/replay session and as the implementation of
 * the "reauth" recovery action a replaying artifact can trigger mid-flow
 * (see src/replay/app-config.ts). Keeping this as one function means the
 * login flow is defined once, not re-implemented slightly differently for
 * "the first login" vs. "recovering from a session timeout."
 */
export async function performLogin(page: Page, baseUrl: string, credentials: MockCredentials): Promise<void> {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/members/, { timeout: 10_000 });
}
