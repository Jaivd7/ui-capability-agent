import type { Page } from "playwright";
import type { LiveView } from "../types.js";

/**
 * The live view: a screenshot of what the run's browser is looking at *right
 * now*.
 *
 * The page is the only place this information exists, and it exists for
 * exactly as long as the run holds its context — so this is a registry keyed
 * by run id, populated by the executor when it acquires a session and emptied
 * before that session is released. Deliberately not a field on `RunRecord`: a
 * record is JSON the API hands to callers, and a Playwright handle is neither
 * serializable nor something an API client should be able to reach.
 *
 * The escalation console already screenshots a paused run's page through the
 * intervention registry. That one answers "what is the operator looking at";
 * this one answers "what is the automation doing", which is a live question for
 * the whole run rather than just its paused moments. A run parked in an
 * escalation is registered here too, because the executor still holds the
 * session while the engine is suspended inside the handler.
 */

/**
 * Short on purpose. A screenshot competes with the run for the page, and a
 * poller asking every 1.5s must never be the reason a step times out. Missing
 * one frame is free; delaying the run is not.
 */
const SCREENSHOT_TIMEOUT_MS = 3_000;

export function createLiveView(): LiveView {
  const pages = new Map<string, Page>();
  /**
   * One screenshot per run at a time. A page mid-navigation can make
   * `screenshot()` slow, and a 1.5s poller against a 3s capture would otherwise
   * stack requests on the same page until the run crawls.
   */
  const inFlight = new Map<string, Promise<Buffer | undefined>>();

  return {
    register(runId: string, page: Page): void {
      pages.set(runId, page);
    },

    release(runId: string): void {
      pages.delete(runId);
      inFlight.delete(runId);
    },

    has(runId: string): boolean {
      return pages.has(runId);
    },

    screenshot(runId: string): Promise<Buffer | undefined> {
      const page = pages.get(runId);
      if (!page) return Promise.resolve(undefined);

      const existing = inFlight.get(runId);
      if (existing) return existing;

      // Every failure mode here is transient and expected: the context can be
      // closing as the run ends, and a capture can time out during a
      // navigation. None of them is worth a 500 — the caller gets "no frame
      // this time" and asks again in a second.
      const shot = page
        .screenshot({ timeout: SCREENSHOT_TIMEOUT_MS })
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(runId);
        });
      inFlight.set(runId, shot);
      return shot;
    },
  };
}

/**
 * What the `<img>` shows when there is no frame to serve.
 *
 * Served with a 200 rather than a 503 on purpose: a browser does not render
 * the body of an error response in an `<img>`, so the honest status code buys
 * a broken-image icon and nothing else. The placeholder says what is happening
 * in the image itself, which is the same information delivered somewhere the
 * reviewer will actually see it — and it needs no JavaScript, which the rest of
 * this page also doesn't.
 */
export function livePlaceholderSvg(message: string): string {
  const text = escapeXml(message);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400" role="img" aria-label="${text}">
  <rect width="640" height="400" fill="#f8fafc"/>
  <rect x="0.5" y="0.5" width="639" height="399" fill="none" stroke="#e2e8f0"/>
  <circle cx="320" cy="176" r="19" fill="none" stroke="#cbd5e1" stroke-width="2"/>
  <path d="M320 166v11" stroke="#cbd5e1" stroke-width="2" stroke-linecap="round"/>
  <circle cx="320" cy="185" r="1.6" fill="#cbd5e1"/>
  <text x="320" y="226" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="14" fill="#64748b">${text}</text>
</svg>`;
}

function escapeXml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}
