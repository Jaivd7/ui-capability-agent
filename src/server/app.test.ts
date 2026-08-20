import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDashboardApp } from "./app.js";
import { createLiveView } from "./runtime/live-view.js";
import type {
  Catalog,
  LiveView,
  RunExecutor,
  RunQuery,
  RunRecord,
  RunRegistry,
  RunStatus,
  RunSummary,
} from "./types.js";

/**
 * The composed app, over real HTTP.
 *
 * Every other test in this package tests a piece: the views are pure functions
 * checked as strings, the registry is checked against a temp evidence tree, the
 * executor is checked against a stubbed pool. Nothing asked the *route table* a
 * question, which is how the run page shipped an `<img src>` pointing at a
 * route that was never implemented — the view test asserted the URL, and the
 * URL was wrong in both places at once.
 *
 * So these tests fetch what the pages actually emit, rather than what a view
 * says it emits.
 */

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "cap-1",
    kind: "replay",
    capabilityId: "cap",
    app: "meridian-core",
    role: "teller",
    status: "running",
    escalated: false,
    startedAt: "2026-08-20T10:00:00.000Z",
    baseUrl: "https://example.test",
    evidenceDir: "replay-run",
    logPath: "/tmp/does-not-exist.jsonl",
    updatedAt: "2026-08-20T10:00:00.000Z",
    params: { memberId: "101555" },
    progress: { stepsTotal: 3, stepsCompleted: 1 },
    ...overrides,
  };
}

function stubRegistry(records: RunRecord[]): RunRegistry {
  const byId = new Map(records.map((r) => [r.runId, r]));
  return {
    rebuildFromDisk: async () => undefined,
    list: (_query?: RunQuery) => [...byId.values()] as RunSummary[],
    get: (runId) => byId.get(runId),
    events: async () => [],
    create: () => undefined,
    update: () => undefined,
    active: () => undefined,
  };
}

const stubCatalog: Catalog = { list: () => [], get: () => undefined, refresh: () => undefined };
const stubExecutor: RunExecutor = {
  invoke: async () => {
    throw new Error("not used");
  },
  drain: async () => undefined,
};

function pageReturning(bytes: string): Page {
  return { screenshot: async () => Buffer.from(bytes) } as unknown as Page;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let server: Server | undefined;
let base = "";

function start(deps: { runs: RunRegistry; liveView?: LiveView }): Promise<void> {
  const app = createDashboardApp({
    catalog: stubCatalog,
    runs: deps.runs,
    executor: stubExecutor,
    ...(deps.liveView ? { liveView: deps.liveView } : {}),
  });
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

beforeEach(() => {
  server = undefined;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

// ---------------------------------------------------------------------------

describe("GET /runs/:runId/screenshot", () => {
  it("serves a PNG of the live page while the run holds it", async () => {
    const liveView = createLiveView();
    liveView.register("cap-1", pageReturning("png-bytes"));
    await start({ runs: stubRegistry([record()]), liveView });

    const res = await fetch(`${base}/runs/cap-1/screenshot`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from("png-bytes"));
  });

  it("is never cached, so the img the server rendered does not freeze on frame one", async () => {
    const liveView = createLiveView();
    liveView.register("cap-1", pageReturning("png-bytes"));
    await start({ runs: stubRegistry([record()]), liveView });

    const res = await fetch(`${base}/runs/cap-1/screenshot`);

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves a placeholder image, not an error, before the session opens", async () => {
    // The window between accepting an invoke and Chromium reaching a page is
    // several seconds, and it is precisely when someone is watching. A 4xx/5xx
    // here would render as a broken-image icon: a browser does not draw the
    // body of an error response in an <img>.
    await start({ runs: stubRegistry([record()]), liveView: createLiveView() });

    const res = await fetch(`${base}/runs/cap-1/screenshot`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(await res.text()).toContain("Waiting for the browser session");
  });

  it("says the session is closed once the run is terminal", async () => {
    await start({
      runs: stubRegistry([record({ status: "succeeded", finishedAt: "2026-08-20T10:00:09.000Z" })]),
      liveView: createLiveView(),
    });

    const res = await fetch(`${base}/runs/cap-1/screenshot`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("finished");
  });

  it("degrades to the placeholder when the capture itself fails", async () => {
    const liveView = createLiveView();
    liveView.register("cap-1", {
      screenshot: async () => {
        throw new Error("Target page, context or browser has been closed");
      },
    } as unknown as Page);
    await start({ runs: stubRegistry([record()]), liveView });

    const res = await fetch(`${base}/runs/cap-1/screenshot`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("404s for a run it has never heard of", async () => {
    await start({ runs: stubRegistry([]), liveView: createLiveView() });

    const res = await fetch(`${base}/runs/nope/screenshot`);

    expect(res.status).toBe(404);
  });

  it("still answers when the server was composed without a live view at all", async () => {
    await start({ runs: stubRegistry([record()]) });

    const res = await fetch(`${base}/runs/cap-1/screenshot`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });
});

describe("the run page's own links resolve", () => {
  /**
   * The regression guard for this whole class of bug: take the URL the live
   * run page really emits and fetch it. An assertion about the string in the
   * view cannot fail when the route is missing; this can.
   */
  it("the live view's img src is a route this server serves", async () => {
    const statuses: RunStatus[] = ["running", "escalation_pending"];
    for (const status of statuses) {
      const liveView = createLiveView();
      liveView.register("cap-1", pageReturning("png-bytes"));
      await start({ runs: stubRegistry([record({ status })]), liveView });

      const html = await (await fetch(`${base}/runs/cap-1`)).text();
      const src = /<img[^>]*id="live-screenshot"[^>]*src="([^"]+)"/.exec(html)?.[1];
      expect(src, `no live screenshot img rendered for a ${status} run`).toBeDefined();

      const res = await fetch(`${base}${src!.replace(/&amp;/g, "&")}`);
      expect(res.status, `${src} is not served`).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/png");

      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    }
  });

  it("the poll script's screenshot URL matches the route, not just the img's", async () => {
    const liveView = createLiveView();
    liveView.register("cap-1", pageReturning("png-bytes"));
    await start({ runs: stubRegistry([record()]), liveView });

    const html = await (await fetch(`${base}/runs/cap-1`)).text();
    // The script builds it by concatenation, so the literal tail is what there
    // is to check — and it is a different literal from the img's, in a
    // different file, which is exactly why both were wrong together.
    expect(html).toContain('"/runs/" + encodeURIComponent(runId) + "/screenshot?t="');

    const res = await fetch(`${base}/runs/cap-1/screenshot?t=12345`);
    expect(res.status).toBe(200);
  });
});
