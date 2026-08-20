import { createBrowserPool, type BrowserPool } from "./runtime/browser-pool.js";
import { createCatalog } from "./runtime/catalog.js";
import { createRunExecutor } from "./runtime/run-executor.js";
import { createRunRegistry } from "./runtime/run-registry.js";
import type { ServerDeps } from "./types.js";

export interface BuiltDeps extends ServerDeps {
  pool: BrowserPool;
}

/**
 * Wires the runtime together. Order matters in one place: the registry takes
 * the catalog, because `progress.stepsTotal` lives in the artifact rather than
 * in the run log.
 */
export async function buildDeps(): Promise<BuiltDeps> {
  const catalog = createCatalog();
  const runs = createRunRegistry({ catalog });
  // At startup nothing is running by definition, so any log without a terminal
  // event belongs to a process that is gone. That is the only moment the
  // distinction between "in flight" and "died" is knowable, which is why the
  // sweep happens here rather than being inferred later.
  await runs.rebuildFromDisk();
  const pool = createBrowserPool();
  const executor = createRunExecutor({ catalog, runs, pool });
  return { catalog, runs, executor, pool };
}
