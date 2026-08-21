import type { AddressInfo } from "node:net";
import express from "express";
import { errorHandler } from "../shared/express-safety.js";
import { escalationRouter } from "./routes.js";
import type { InterventionRegistry } from "./intervention-registry.js";

/**
 * Keeps `--escalate` working for the CLIs now that the console is normally a
 * few routes on the dashboard.
 *
 * It mounts *the same router* rather than reimplementing the endpoints, so the
 * console a human drives from a terminal run is the console they drive from the
 * dashboard — and the action policy cannot be enforced in one and quietly
 * skipped in the other. That is strictly better than before, when the console
 * only existed inside `raiseIntervention` and there was exactly one copy
 * because there was exactly one caller.
 */
export interface StandaloneConsole {
  url: string;
  basePathFor: (runId: string) => string;
  close: () => Promise<void>;
}

export async function startStandaloneConsole(registry: InterventionRegistry): Promise<StandaloneConsole> {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/runs/:runId/escalation", escalationRouter(registry));

  /**
   * The router redirects to the run's page once an intervention resolves,
   * because on the dashboard that is where an operator wants to land — they
   * watch the rest of the run finish. A CLI run has no such page, so this is
   * the terminus instead. Serving it here rather than branching the redirect
   * keeps one router with one behaviour.
   */
  app.get("/runs/:runId", (req, res) => {
    res.send(
      `<!doctype html><meta charset="utf-8"><title>Intervention resolved</title>` +
        `<body style="font-family:-apple-system,sans-serif;max-width:640px;margin:48px auto;padding:0 16px">` +
        `<h2>Intervention resolved</h2>` +
        `<p>Automation has taken back control of run <code>${String(req.params.runId).replace(/[<>&]/g, "")}</code>.` +
        ` You can close this window; the terminal is showing the rest of the run.</p></body>`,
    );
  });

  app.use(errorHandler);

  return new Promise<StandaloneConsole>((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      const url = `http://localhost:${port}`;
      resolve({
        url,
        basePathFor: (runId) => `${url}/runs/${runId}/escalation`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
