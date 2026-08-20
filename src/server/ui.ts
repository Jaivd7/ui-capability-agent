import { Router } from "express";
import { listAppAdapters, listRoles } from "../apps/index.js";
import { ParamValidationError } from "../replay/coerce.js";
import { invokeError } from "./api.js";
import { CapabilityNotFoundError } from "./runtime/run-executor.js";
import { listAvailableEvidence } from "./runtime/evidence-reader.js";
import { layout } from "./views/layout.js";
import { catalogPage } from "./views/pages/catalog.js";
import { invokePage } from "./views/pages/invoke.js";
import { overviewPage, type DemoLink } from "./views/pages/overview.js";
import { runDetailPage } from "./views/pages/run-detail.js";
import { runsPage } from "./views/pages/runs.js";
import { pollScript, runnerPollScript } from "./views/poll-script.js";
import { isTerminalStatus, type RunStatus, type ServerDeps } from "./types.js";

/**
 * The pages. Every one is rendered complete on the server and works with
 * JavaScript disabled; the poll scripts only add liveness. The client never
 * renders a *result* — that logic exists exactly once, here — so a run page
 * that has gone terminal reloads rather than trying to draw the outcome.
 */
export function createUiRouter(deps: ServerDeps): Router {
  const ui = Router();

  ui.get("/", (_req, res) => {
    const recent = deps.runs.list({ limit: 5 });
    const counts = countByStatus(deps);
    res.send(
      layout({
        title: "Overview",
        activeNav: "overview",
        body: overviewPage({
          apps: listAppAdapters().map((a) => ({
            id: a.id,
            displayName: a.displayName,
            baseUrl: a.target(process.env).baseUrl,
          })),
          ...(deps.runs.active() ? { active: deps.runs.active()! } : {}),
          recent,
          counts,
          demoLinks: demoLinks(deps),
        }),
        pollScript: runnerPollScript(),
      }),
    );
  });

  ui.get("/capabilities", (_req, res) => {
    // Pass the *detail* entries: the catalog type deliberately omits steps and
    // locators, because those are UI knowledge an agent shouldn't need — but a
    // human reviewer reading the page wants the recipe.
    const details = deps.catalog.list().map((e) => deps.catalog.get(e.id) ?? e);
    res.send(
      layout({
        title: "Capabilities",
        activeNav: "capabilities",
        body: catalogPage(details),
        pollScript: runnerPollScript(),
      }),
    );
  });

  ui.get("/capabilities/:id/invoke", (req, res) => {
    const entry = deps.catalog.get(req.params.id);
    if (!entry) return res.status(404).send(layout({ title: "Not found", body: notFoundBody(req.params.id) }));
    const active = deps.runs.active();
    return res.send(
      layout({
        title: `Invoke ${entry.name}`,
        activeNav: "capabilities",
        body: invokePage(entry, {
          roles: listRoles(entry.app),
          ...(active ? { busyWith: active } : {}),
          values: queryValues(req.query),
        }),
        pollScript: runnerPollScript(),
      }),
    );
  });

  ui.post("/capabilities/:id/invoke", async (req, res) => {
    const entry = deps.catalog.get(req.params.id);
    if (!entry) return res.status(404).send(layout({ title: "Not found", body: notFoundBody(req.params.id) }));

    const form = (req.body ?? {}) as Record<string, string>;
    const { role, escalate, ...params } = form;
    try {
      const accepted = await deps.executor.invoke({
        capabilityId: entry.id,
        params,
        ...(role ? { role } : {}),
        // The form's checkbox posts "true"/"false" via its hidden companion.
        escalate: escalate !== "false",
      });
      // 303 so a refresh of the run page cannot re-submit the invocation.
      return res.redirect(303, accepted.runUrl);
    } catch (err) {
      if (err instanceof ParamValidationError || err instanceof CapabilityNotFoundError) {
        const active = deps.runs.active();
        return res.status(400).send(
          layout({
            title: `Invoke ${entry.name}`,
            activeNav: "capabilities",
            body: invokePage(entry, {
              roles: listRoles(entry.app),
              ...(active ? { busyWith: active } : {}),
              values: form,
              errors: err instanceof ParamValidationError ? err.fields : [{ name: "capability", problem: err.message }],
            }),
          }),
        );
      }
      return invokeError(res, err);
    }
  });

  ui.get("/runs", (req, res) => {
    const q = req.query;
    res.send(
      layout({
        title: "Runs",
        activeNav: "runs",
        body: runsPage(
          deps.runs.list({
            ...(typeof q.app === "string" && q.app ? { app: q.app } : {}),
            ...(typeof q.capabilityId === "string" && q.capabilityId ? { capabilityId: q.capabilityId } : {}),
            ...(q.kind === "replay" || q.kind === "discovery" ? { kind: q.kind } : {}),
          }),
        ),
      }),
    );
  });

  ui.get("/runs/:runId", async (req, res) => {
    const record = deps.runs.get(req.params.runId);
    if (!record) {
      return res.status(404).send(layout({ title: "Not found", body: notFoundBody(req.params.runId) }));
    }
    const events = await deps.runs.events(record.runId);
    const live = !isTerminalStatus(record.status);
    return res.send(
      layout({
        title: `Run ${record.runId}`,
        activeNav: "runs",
        body: runDetailPage(record, events, {
          evidence: listAvailableEvidence(record.app, record.evidenceDir, record.runId),
          live,
        }),
        ...(live ? { pollScript: pollScript({ runId: record.runId }) } : {}),
      }),
    );
  });

  return ui;
}

function countByStatus(deps: ServerDeps): Record<RunStatus, number> {
  const counts: Record<RunStatus, number> = {
    running: 0,
    escalation_pending: 0,
    succeeded: 0,
    business_outcome: 0,
    failed: 0,
    crashed: 0,
  };
  for (const run of deps.runs.list()) counts[run.status] += 1;
  return counts;
}

/**
 * Three deep links that put a reviewer one click from each branch of the error
 * taxonomy, instead of asking them to guess which member id makes the
 * interesting thing happen.
 */
function demoLinks(deps: ServerDeps): DemoLink[] {
  const links: DemoLink[] = [];
  const read = deps.catalog.get("meridian-read-member-record");
  if (read) {
    links.push({
      label: "Happy path",
      description: "Read a member's record and one share balance.",
      href: "/capabilities/meridian-read-member-record/invoke?memberId=101555&shareCode=S0001",
    });
    links.push({
      label: "Business outcome",
      description: "The same capability against a member that does not exist — a legitimate answer, not a crash.",
      href: "/capabilities/meridian-read-member-record/invoke?memberId=999999&shareCode=S0001",
    });
  }
  const hold = deps.catalog.get("meridian-place-account-hold");
  if (hold) {
    links.push({
      label: "Permission denied",
      description: "A supervisor-only action invoked as a teller — refused before the run touches the host.",
      href: "/capabilities/meridian-place-account-hold/invoke?memberId=101555&shareCode=MMKT-5&reasonCode=LEGAL&notes=Demo&role=teller",
    });
  }
  return links;
}

/** Query params prefill the invoke form, which is what makes "re-invoke with these" a link. */
function queryValues(query: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

function notFoundBody(what: string): string {
  return `<div class="rounded-lg border border-slate-200 bg-white p-8 text-center">
    <p class="text-sm text-slate-600">Nothing here for <code class="rounded bg-slate-100 px-1">${escapeText(what)}</code>.</p>
    <a class="mt-4 inline-block text-sm font-medium text-slate-900 underline" href="/">Back to overview</a>
  </div>`;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
