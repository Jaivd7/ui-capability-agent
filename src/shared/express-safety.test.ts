import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asyncRoute, errorHandler, safeRouter } from "./express-safety.js";

/**
 * The regression these guard: an async handler that rejects was invisible to
 * Express 4, so the promise was dropped, Node's default turned it into an
 * uncaught exception, and the dashboard exited — taking the browser pool and
 * every parked escalation with it. The proof is negative (no unhandled
 * rejection reaches the process) so each test listens for one directly.
 */
async function withServer(app: express.Express, fn: (base: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Fails the test if anything escapes to the process while `fn` runs. */
async function assertNoUnhandledRejection(fn: () => Promise<void>): Promise<void> {
  const escaped: unknown[] = [];
  const onReject = (reason: unknown) => escaped.push(reason);
  process.on("unhandledRejection", onReject);
  try {
    await fn();
    // A rejection is delivered on a later turn than the response, so give the
    // microtask queue a chance to surface one before declaring success.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off("unhandledRejection", onReject);
  }
  expect(escaped).toEqual([]);
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});
function silenceConsole() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  spies.push(spy);
  return spy;
}

describe("safeRouter", () => {
  it("turns a rejected async handler into a 500 instead of an unhandled rejection", async () => {
    silenceConsole();
    const router = safeRouter(express.Router());
    router.get("/boom", async () => {
      throw new Error("EACCES: permission denied, open 'run.jsonl'");
    });
    const app = express().use(router).use(errorHandler);

    await assertNoUnhandledRejection(async () => {
      await withServer(app, async (base) => {
        const res = await fetch(`${base}/boom`);
        expect(res.status).toBe(500);
        expect(await res.text()).toContain("EACCES");
      });
    });
  });

  it("catches a synchronous throw too", async () => {
    silenceConsole();
    const router = safeRouter(express.Router());
    router.get("/sync", () => {
      throw new Error("sync boom");
    });
    const app = express().use(router).use(errorHandler);
    await withServer(app, async (base) => {
      expect((await fetch(`${base}/sync`)).status).toBe(500);
    });
  });

  it("leaves a successful handler untouched", async () => {
    const router = safeRouter(express.Router());
    router.get("/ok", async (_req, res) => {
      res.json({ ok: true });
    });
    await withServer(express().use(router), async (base) => {
      expect(await (await fetch(`${base}/ok`)).json()).toEqual({ ok: true });
    });
  });

  it("does not wrap 4-arity error middleware, which would drop it from the pipeline", async () => {
    silenceConsole();
    const router = safeRouter(express.Router());
    router.get("/boom", async () => {
      throw new Error("nope");
    });
    let sawError = false;
    router.use(((err: unknown, _req: unknown, res: express.Response, _next: unknown) => {
      sawError = true;
      res.status(503).send("handled by the router's own error middleware");
    }) as express.ErrorRequestHandler);

    await withServer(express().use(router), async (base) => {
      expect((await fetch(`${base}/boom`)).status).toBe(503);
    });
    expect(sawError).toBe(true);
  });
});

describe("errorHandler", () => {
  it("answers /api in JSON and everything else in text", async () => {
    silenceConsole();
    const router = safeRouter(express.Router());
    router.get("/api/thing", async () => {
      throw new Error("blew up");
    });
    router.get("/page", async () => {
      throw new Error("blew up");
    });
    const app = express().use(router).use(errorHandler);

    await withServer(app, async (base) => {
      const api = await fetch(`${base}/api/thing`);
      expect(api.headers.get("content-type")).toContain("application/json");
      expect(await api.json()).toEqual({ error: "internal_error", message: "blew up" });

      const page = await fetch(`${base}/page`);
      expect(page.headers.get("content-type")).toContain("text/plain");
      expect(await page.text()).toContain("Something went wrong");
    });
  });

  it("logs every failure, since the request is not otherwise recorded anywhere", async () => {
    const spy = silenceConsole();
    const router = safeRouter(express.Router());
    router.get("/boom", async () => {
      throw new Error("recorded");
    });
    await withServer(express().use(router).use(errorHandler), async (base) => {
      await fetch(`${base}/boom`);
    });
    expect(spy).toHaveBeenCalled();
  });
});

describe("asyncRoute", () => {
  it("forwards a rejection to next() rather than letting it escape", async () => {
    const next = vi.fn();
    const err = new Error("x");
    await new Promise<void>((resolve) => {
      asyncRoute(async () => {
        throw err;
      })({} as express.Request, {} as express.Response, ((e: unknown) => {
        next(e);
        resolve();
      }) as express.NextFunction);
    });
    expect(next).toHaveBeenCalledWith(err);
  });
});
