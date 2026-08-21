import express, { type Express } from "express";
import { errorHandler } from "../shared/express-safety.js";
import { createApiRouter } from "./api.js";
import { createUiRouter } from "./ui.js";
import type { ServerDeps } from "./types.js";
import { escalationRouter } from "../escalation/routes.js";
import type { InterventionRegistry } from "../escalation/intervention-registry.js";

/**
 * Composes the dashboard. Deliberately does not call `listen` — the app is
 * built from injected deps so it can be exercised in a test without a browser,
 * a target app, or a port.
 */
export function createDashboardApp(deps: ServerDeps & { interventions?: InterventionRegistry }): Express {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/api", createApiRouter(deps));
  // Mounted before the UI router so a paused run's console wins over the
  // generic /runs/:runId page.
  if (deps.interventions) {
    app.use("/runs/:runId/escalation", escalationRouter(deps.interventions));
  }
  app.use("/", createUiRouter(deps));
  // Last, so a rejection escaping any router above lands here instead of
  // becoming an unhandled rejection that exits the process.
  app.use(errorHandler);
  return app;
}
