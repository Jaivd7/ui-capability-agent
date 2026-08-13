import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { MockCredentials } from "./credentials.js";
import { type DialogEvent, installDialogAutoAccept } from "./dialogs.js";
import { performLogin } from "./login.js";

export type { DialogEvent } from "./dialogs.js";

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
 * on a redaction pass to scrub it after the fact. Used to bootstrap both a
 * discovery run and a replay run — both start from the same authenticated
 * baseline, never as artifact-recorded steps.
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

  await performLogin(page, baseUrl, credentials);

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
