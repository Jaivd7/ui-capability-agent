import express, { type Express } from "express";
import { createApiRouter } from "./api.js";
import { createUiRouter } from "./ui.js";
import type { ServerDeps } from "./types.js";

/**
 * Composes the dashboard. Deliberately does not call `listen` — the app is
 * built from injected deps so it can be exercised in a test without a browser,
 * a target app, or a port.
 */
export function createDashboardApp(deps: ServerDeps): Express {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/api", createApiRouter(deps));
  app.use("/", createUiRouter(deps));
  return app;
}
