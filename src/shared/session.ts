import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { credentialsFor, getAppAdapter, resolveTargetFor } from "../apps/index.js";
import { type DialogEvent, installDialogAutoAccept } from "./dialogs.js";

export type { DialogEvent } from "./dialogs.js";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  dialogEvents: DialogEvent[];
  close(): Promise<void>;
}

export interface SessionOptions {
  app: string;
  role: string;
  /** Overrides the adapter's resolved baseUrl — used by tests pointing at a local port. */
  baseUrl?: string;
}

/**
 * Logs in via direct Playwright calls — never via the LLM. See
 * src/apps/types.ts for why: this keeps auth structurally out of both the
 * model's context and the recorded artifact, rather than relying on a
 * redaction pass to scrub it after the fact.
 *
 * Split from the browser lifecycle so a long-lived server can own one browser
 * and hand each run its own context. Cookies *are* the session, so a context
 * per run is not tidiness — two runs sharing one would trample each other's
 * auth, and a `reauth` in one would silently re-login the other.
 */
export async function createSessionInContext(
  context: BrowserContext,
  opts: SessionOptions,
): Promise<{ page: Page; dialogEvents: DialogEvent[] }> {
  const adapter = getAppAdapter(opts.app);
  const target = { ...resolveTargetFor(opts.app), ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) };

  const page = await context.newPage();
  const dialogEvents: DialogEvent[] = [];
  installDialogAutoAccept(page, (info) => dialogEvents.push(info));

  await adapter.login(page, target, credentialsFor(opts.app, opts.role));
  return { page, dialogEvents };
}

/**
 * Launches a browser and returns an authenticated session that owns it. The
 * CLI path: one run, one browser, closed on exit. The server uses
 * `createSessionInContext` against a pooled browser instead.
 */
export async function startAuthenticatedSession(opts: SessionOptions): Promise<BrowserSession> {
  const headless = process.env.HEADLESS !== "false";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const { page, dialogEvents } = await createSessionInContext(context, opts);

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
