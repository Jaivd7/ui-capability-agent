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
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
