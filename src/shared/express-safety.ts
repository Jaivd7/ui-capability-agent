import type { ErrorRequestHandler, IRouter, NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Keeping a rejected promise in a route from killing the process.
 *
 * Express 4 forwards a *synchronous* throw in a handler to its error pipeline,
 * but an `async` handler that rejects is invisible to it — the returned promise
 * is simply dropped. Node has defaulted `--unhandled-rejections=throw` since
 * v15, so that dropped promise becomes an uncaught exception and, with no
 * handler installed, exits the process.
 *
 * That was not theoretical here. `GET /api/runs/:runId/events` is what the run
 * page polls, and it awaits `readEvents`, which deliberately swallows ENOENT (a
 * run's log can legitimately not exist yet) and rethrows everything else —
 * EACCES, EMFILE, EIO. One of those on the hottest route in the console took
 * down the browser pool and every parked escalation with it, and because the
 * process died rather than shutting down, those interventions never got the
 * terminal record `abortAll` exists to write. They resurfaced as `crashed`.
 *
 * Wrapping is preferred over upgrading to Express 5 (which awaits handlers
 * itself) because that is a major-version change to the one dependency every
 * surface in this project routes through, for a fix that is four lines.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    try {
      const returned = handler(req, res, next);
      // Duck-typed rather than `instanceof Promise`: an async function returns
      // a native promise, but a handler is free to return any thenable.
      if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
        void (returned as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Applies `asyncRoute` to every handler registered on a router, once, at
 * construction.
 *
 * The alternative was wrapping each handler at its own call site, which is the
 * same fix written seventeen times and forgotten on the eighteenth — the next
 * route someone adds is exactly the one that would not be covered. Doing it to
 * the router means a handler cannot opt out by accident.
 *
 * Four-argument handlers are left alone: that arity *is* how Express
 * distinguishes error middleware, and wrapping one would change its signature
 * and quietly remove it from the error pipeline.
 */
export function safeRouter<T extends IRouter>(router: T): T {
  const methods = ["get", "post", "put", "patch", "delete", "all", "use"] as const;
  for (const method of methods) {
    const original = router[method].bind(router) as (...args: unknown[]) => unknown;
    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(
        ...args.map((arg) =>
          typeof arg === "function" && (arg as { length: number }).length < 4
            ? asyncRoute(arg as Parameters<typeof asyncRoute>[0])
            : arg,
        ),
      );
  }
  return router;
}

/**
 * The last `app.use`. Answers in the caller's own idiom rather than one format
 * for everyone: an agent polling `/api` gets a JSON error it can branch on, a
 * human gets readable text.
 *
 * It deliberately does not try to render the console's HTML shell. This handler
 * runs when something has already gone wrong, and reaching back into the view
 * layer — which can itself throw — is how an error handler becomes the thing
 * that crashes. Plain text is the honest floor.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const message = err instanceof Error ? err.message : String(err);
  // Logged unconditionally: this is the only record that the request failed,
  // since the run's own JSONL belongs to the run and not to the request.
  console.error(`[${req.method} ${req.originalUrl}] unhandled error:`, err);

  // Headers already sent means a response was streaming when it failed; there
  // is no status left to set, and Express's default handler closes the socket.
  if (res.headersSent) return next(err);

  if (req.originalUrl.startsWith("/api/")) {
    res.status(500).json({ error: "internal_error", message });
    return;
  }
  res.status(500).type("text/plain").send(`Something went wrong handling this request.\n\n${message}`);
};
