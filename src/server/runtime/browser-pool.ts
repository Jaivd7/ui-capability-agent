import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createSessionInContext, type DialogEvent } from "../../shared/session.js";

/**
 * One browser for the process, one context per run.
 *
 * The CLI's `startAuthenticatedSession` launches a browser per invocation,
 * which is right for a process that exists to do one run and exit. A server
 * that did that would pay a Chromium launch (~1s) on every call and would
 * hold nothing between them, so the browser is hoisted out and shared.
 *
 * The *context* is not shared, and that is the load-bearing half of this file.
 * Cookies are the session: two runs sharing a context would trample each
 * other's auth, and worse, a `reauth` recovery in one run would silently
 * re-login the other mid-flow — it would look like a flake, not like a bug.
 * `createSessionInContext` exists precisely so this module can own the browser
 * lifecycle while reusing the CLI's login path unchanged.
 */

export interface RunSession {
  context: BrowserContext;
  page: Page;
  dialogEvents: DialogEvent[];
  /** Closes this run's context. The shared browser stays up for the next run. */
  release(): Promise<void>;
}

export interface BrowserPool {
  acquire(o: { app: string; role: string; baseUrl?: string }): Promise<RunSession>;
  shutdown(): Promise<void>;
}

export function createBrowserPool(): BrowserPool {
  let browser: Browser | undefined;
  /**
   * In-flight launch, shared by concurrent acquires. The server is
   * single-flight today so this is belt-and-braces, but two simultaneous
   * `acquire`s racing on a lazily-launched browser would otherwise leak one
   * Chromium per lost race, and a leaked browser is invisible until the box
   * runs out of memory.
   */
  let launching: Promise<Browser> | undefined;

  async function ensureBrowser(): Promise<Browser> {
    // `isConnected()` rather than a plain null check: Chromium can die
    // underneath us (OOM kill, a crashed page taking the process with it) and
    // the handle stays non-null but every call on it throws. A relaunch here
    // turns "the server is permanently broken until restart" into "one run
    // failed."
    if (browser?.isConnected()) return browser;
    browser = undefined;

    if (!launching) {
      launching = chromium
        .launch({ headless: process.env.HEADLESS !== "false" })
        .then((launched) => {
          browser = launched;
          return launched;
        })
        .finally(() => {
          launching = undefined;
        });
    }
    return launching;
  }

  return {
    async acquire(o) {
      const active = await ensureBrowser();
      const context = await active.newContext();
      try {
        const { page, dialogEvents } = await createSessionInContext(context, {
          app: o.app,
          role: o.role,
          ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
        });
        return {
          context,
          page,
          dialogEvents,
          release: async () => {
            // Swallowed: the context may already be gone (browser crash,
            // shutdown race), and a failure to close it must never mask the
            // run's actual result, which is what the caller is here for.
            await context.close().catch(() => undefined);
          },
        };
      } catch (err) {
        // Login threw. Without this the context — and its page — leak for the
        // life of the process, one per failed login.
        await context.close().catch(() => undefined);
        throw err;
      }
    },

    async shutdown() {
      const pending = launching;
      launching = undefined;
      // A launch started but not finished still produces a browser that
      // nobody will ever close otherwise.
      if (pending) await pending.catch(() => undefined);
      const active = browser;
      browser = undefined;
      if (active) await active.close().catch(() => undefined);
    },
  };
}
