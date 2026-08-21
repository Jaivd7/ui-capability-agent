import { createDashboardApp } from "./app.js";
import { buildDeps } from "./deps.js";
import "dotenv/config";

const PORT = Number(process.env.DASHBOARD_PORT ?? 4300);

async function main(): Promise<void> {
  const deps = await buildDeps();
  const app = createDashboardApp(deps);

  const server = app.listen(PORT, () => {
    console.log(`Dashboard listening on http://localhost:${PORT}`);
    console.log(`  ${deps.catalog.list().length} capabilities, ${deps.runs.list().length} runs on disk`);
  });

  /**
   * A paused escalation is a *parked promise* inside a live run, so the
   * shutdown path resolves it rather than dropping it: the run then unwinds
   * through its ordinary abort path and writes a real terminal record
   * explaining why. Dropping it would leave a run that simply stops, which the
   * boot sweep would later class as `crashed` — true, but far less useful than
   * "the server shut down while waiting for an operator".
   */
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received; finishing in-flight work.`);
    server.close();
    deps.interventions.abortAll("server shut down while awaiting operator");
    await deps.executor.drain(10_000);
    await deps.pool.shutdown();
    process.exit(signal === "uncaughtException" ? 1 : 0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  /**
   * The backstop behind `safeRouter`, which should mean nothing reaches here.
   *
   * It stays anyway, and the two cases are treated differently on purpose.
   *
   * A stray rejection is logged and the server keeps serving: the process holds
   * a browser pool and, more importantly, any parked escalation — a suspended
   * promise with a human on the other end of it. Killing all of that over one
   * failed request is a far worse outcome than the failed request, and Node's
   * default (exit) is tuned for programs that own less.
   *
   * An uncaught exception is not survivable in the same way, so it takes the
   * *graceful* path rather than the default abrupt exit. That matters here
   * specifically: `shutdown` resolves every waiting intervention as aborted, so
   * a parked run unwinds and writes a real terminal record explaining why,
   * instead of vanishing and being reclassified as `crashed` by the next boot
   * sweep. Same reasoning as the SIGINT handler above — the difference between
   * "stopped" and "we know why it stopped" is the whole point of the evidence.
   */
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection (server continuing):", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception; shutting down gracefully:", err);
    void shutdown("uncaughtException");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
