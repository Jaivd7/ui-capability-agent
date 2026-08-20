import { createBrowserPool, type BrowserPool } from "./runtime/browser-pool.js";
import { createCatalog } from "./runtime/catalog.js";
import { createRunExecutor } from "./runtime/run-executor.js";
import { createRunRegistry } from "./runtime/run-registry.js";
import type { ServerDeps } from "./types.js";
import { getAppAdapter } from "../apps/index.js";
import { loadGuardrailsConfig } from "../guardrails/config.js";
import { createEscalationHandler } from "../escalation/intervention.js";
import { createInterventionRegistry, type InterventionRegistry } from "../escalation/intervention-registry.js";

export interface BuiltDeps extends ServerDeps {
  pool: BrowserPool;
  interventions: InterventionRegistry;
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
  const interventions = createInterventionRegistry();

  const executor = createRunExecutor({
    catalog,
    runs,
    pool,
    // The console is a few routes on *this* server now, so the handler only
    // needs to know where it is mounted. Nothing is started per run.
    escalate: ({ evidenceDir, page, logger, app, artifact }) =>
      createEscalationHandler({
        page,
        logger,
        evidenceDir,
        registry: interventions,
        policy: {
          guardrails: loadGuardrailsConfig(app),
          app,
          artifact,
          sensitiveValues: [],
        },
        basePathFor: (id) => `/runs/${id}/escalation`,
        preResumeCheck: async (pending) => {
          const loggedOut = await getAppAdapter(app).isLoggedOut(pending.page).catch(() => false);
          if (!loggedOut) return null;
          // reauth's scope is restart_flow for a good reason: a fresh login
          // lands on a blank menu, so the half-completed transaction the
          // operator was looking at is gone. Silently re-walking a transfer to
          // re-reach a button approved minutes ago, against different page
          // state, is exactly what must never happen automatically.
          return "The session expired while awaiting operator input; this run cannot safely resume. Re-invoke the capability.";
        },
      }),
  });

  return { catalog, runs, executor, pool, interventions };
}
