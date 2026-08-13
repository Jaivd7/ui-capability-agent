import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { installDialogAutoAccept } from "../shared/dialogs.js";
import type { MockCredentials } from "./credentials.js";

export interface DialogEvent {
  type: string;
  message: string;
  accepted: boolean;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  dialogEvents: DialogEvent[];
  close(): Promise<void>;
}

/**
 * Launches a browser and logs in via direct Playwright calls — never via
 * the LLM. See credentials.ts for why: this keeps auth structurally out of
 * both the model's context and the recorded artifact, rather than relying
 * on a redaction pass to scrub it after the fact.
 */
export async function startAuthenticatedSession(
  baseUrl: string,
  credentials: MockCredentials,
): Promise<BrowserSession> {
  const headless = process.env.HEADLESS !== "false";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const dialogEvents: DialogEvent[] = [];
  installDialogAutoAccept(page, (info) => dialogEvents.push(info));

  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/members/, { timeout: 10_000 });

  return {
    browser,
    context,
    page,
    dialogEvents,
    close: async () => {
      await browser.close();
    },
  };
}
