import { Router, type Response } from "express";
import { safeRouter } from "../shared/express-safety.js";
import { getAppAdapter, listRoles } from "../apps/index.js";
import { demoDataFor } from "../apps/demo-data.js";
import type { CheatSheetData } from "./views/components.js";
import { ParamValidationError } from "../replay/coerce.js";
import { invokeError } from "./api.js";
import { CapabilityNotFoundError } from "./runtime/run-executor.js";
import { listAvailableEvidence } from "./runtime/evidence-reader.js";
import { livePlaceholderSvg } from "./runtime/live-view.js";
import { layout } from "./views/layout.js";
import { catalogPage, type DemoLink } from "./views/pages/catalog.js";
import { askPanel } from "./views/pages/ask.js";
import { invokeUrlFor, resolveIntent, type RoutableCapability } from "../chat/resolve-intent.js";
import { invokePage } from "./views/pages/invoke.js";
import { runDetailPage } from "./views/pages/run-detail.js";
import { runsPage } from "./views/pages/runs.js";
import { faultsPage } from "./views/pages/faults.js";
import { discoveryPage, type DiscoveryPreset } from "./views/pages/discovery.js";
import { CAPABILITY_PRESETS } from "../discovery/capability-presets.js";
import { PresetNotFoundError } from "./runtime/discovery-runner.js";
import {
  applyFaultSettings,
  describeArmedFault,
  readFaultSettings,
  supportsFaultInjection,
  type FaultSettings,
  type InjectKind,
} from "./runtime/fault-injection.js";
import { pollScript, runnerPollScript } from "./views/poll-script.js";
import { isTerminalStatus, RunnerBusyError, type RunStatus, type ServerDeps } from "./types.js";

/**
 * The pages. Every one is rendered complete on the server and works with
 * JavaScript disabled; the poll scripts only add liveness. The client never
 * renders a *result* — that logic exists exactly once, here — so a run page
 * that has gone terminal reloads rather than trying to draw the outcome.
 */
const FAULT_APP = "meridian-core";

export function createUiRouter(deps: ServerDeps): Router {
  const ui = safeRouter(Router());

  /**
   * Last known fault state, refreshed whenever the panel is opened or changed.
   * Cached rather than fetched per page render: it costs a sign-on round trip
   * against the target, and the banner exists to stop a reviewer forgetting
   * they armed something — a few seconds of staleness does not undermine that.
   */
  let armed: FaultSettings | undefined;
  const banner = () => describeArmedFault(armed);
  /** The demo-data panel for one app, or undefined if that app has none listed. */
  const demoFor = (app: string): CheatSheetData | undefined => cheatSheets([app])[app];
  const page = (opts: { title: string; activeNav?: string; body: string; pollScript?: string }) =>
    layout({
      ...opts,
      ...(banner() ? { faultBanner: banner()! } : {}),
    });

  /**
   * The catalog, served at both `/` and `/capabilities`.
   *
   * Two paths rather than a redirect because `/capabilities` is linked from
   * inside the console (Invoke's cancel, the run detail breadcrumb) and from
   * whatever anyone has already bookmarked, and a redirect would put a pointless
   * round trip on the most-followed link in the app.
   */
  const renderCatalog = (req: { query?: unknown }, res: Response) => {
    // Pass the *detail* entries: the catalog type deliberately omits steps and
    // locators, because those are UI knowledge an agent shouldn't need — but a
    // human reviewer reading the page wants the recipe.
    const details = deps.catalog.list().map((e) => deps.catalog.get(e.id) ?? e);
    const active = deps.runs.active();
    // The ask box sits above the catalog rather than on a page of its own, so
    // the manual route is never more than a scroll away — see views/pages/ask.ts.
    const q = queryValues(req.query);
    const ask = askPanel({
      modelConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      ...(q.request ? { request: q.request } : {}),
      ...(q.note ? { note: q.note } : {}),
      examples: askExamples(details),
    });
    res.send(
      page({
        title: "Capabilities",
        activeNav: "capabilities",
        body: ask + catalogPage(details, {
          ...(active ? { active } : {}),
          counts: countByStatus(deps),
          demoLinks: demoLinks(deps),
          cheatSheets: cheatSheets(details.map((e) => e.app)),
        }),
        pollScript: runnerPollScript(),
      }),
    );
  };

  ui.get("/", renderCatalog);
  ui.get("/capabilities", renderCatalog);

  /**
   * Resolve a sentence to a prefilled invoke form.
   *
   * A 303 to a URL a person could have typed is the entire output — this route
   * never invokes, never touches the browser pool, and adds no reach a human
   * did not already have. The failure modes all land back on the catalog with
   * an explanation rather than on an error page, because the catalog is the
   * fallback: everything the router might have found is listed on it.
   */
  ui.post("/ask", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const request = typeof body.request === "string" ? body.request.trim() : "";
    const back = (note?: string) =>
      res.redirect(
        303,
        `/?${new URLSearchParams({ ...(request ? { request } : {}), ...(note ? { note } : {}) }).toString()}`,
      );

    if (!request) return back();
    if (!process.env.ANTHROPIC_API_KEY) {
      return back("ANTHROPIC_API_KEY is not set, so requests cannot be routed. Pick a capability below instead.");
    }

    const capabilities: RoutableCapability[] = deps.catalog.list().map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      inputParams: e.inputParams,
    }));

    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const intent = await resolveIntent(request, {
        client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
        capabilities,
      });
      if (intent.kind === "unclear") return back(intent.message);
      return res.redirect(303, invokeUrlFor(intent));
    } catch (err) {
      // A router outage must not take the console down with it. The catalog is
      // right there and works.
      return back(`Could not reach the model to route that (${err instanceof Error ? err.message : String(err)}).`);
    }
  });

  ui.get("/capabilities/:id/invoke", (req, res) => {
    const entry = deps.catalog.get(req.params.id);
    if (!entry) return res.status(404).send(page({ title: "Not found", body: notFoundBody(req.params.id) }));
    const active = deps.runs.active();
    return res.send(
      page({
        title: `Invoke ${entry.name}`,
        activeNav: "capabilities",
        body: invokePage(entry, {
          roles: listRoles(entry.app),
              ...(demoFor(entry.app) ? { demo: demoFor(entry.app)! } : {}),
          ...(active ? { busyWith: active } : {}),
          values: queryValues(req.query),
        }),
        pollScript: runnerPollScript(),
      }),
    );
  });

  ui.post("/capabilities/:id/invoke", async (req, res) => {
    const entry = deps.catalog.get(req.params.id);
    if (!entry) return res.status(404).send(page({ title: "Not found", body: notFoundBody(req.params.id) }));

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
      // A browser gets the form back with the problem on it. Falling through to
      // `invokeError` would answer an HTML form post with a JSON error body —
      // which is right for the API and useless in a tab.
      if (err instanceof ParamValidationError || err instanceof CapabilityNotFoundError) {
        const active = deps.runs.active();
        return res.status(400).send(
          page({
            title: `Invoke ${entry.name}`,
            activeNav: "capabilities",
            body: invokePage(entry, {
              roles: listRoles(entry.app),
              ...(demoFor(entry.app) ? { demo: demoFor(entry.app)! } : {}),
              ...(active ? { busyWith: active } : {}),
              values: form,
              errors: err instanceof ParamValidationError ? err.fields : [{ name: "capability", problem: err.message }],
            }),
          }),
        );
      }
      // Losing a race for the single-flight runner is the most likely failure
      // here, not the least: the invoke button is only disabled once the poll
      // notices, so two tabs — or one impatient double-click — reach this.
      if (err instanceof RunnerBusyError) {
        return res.status(409).send(
          page({
            title: `Invoke ${entry.name}`,
            activeNav: "capabilities",
            body: invokePage(entry, {
              roles: listRoles(entry.app),
              ...(demoFor(entry.app) ? { demo: demoFor(entry.app)! } : {}),
              busyWith: err.activeRun,
              values: form,
            }),
            pollScript: runnerPollScript(),
          }),
        );
      }
      return invokeError(res, err);
    }
  });

  ui.get("/runs", (req, res) => {
    const q = req.query;
    res.send(
      page({
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
      return res.status(404).send(page({ title: "Not found", body: notFoundBody(req.params.runId) }));
    }
    const events = await deps.runs.events(record.runId);
    const live = !isTerminalStatus(record.status);
    return res.send(
      page({
        title: `Run ${record.runId}`,
        activeNav: "runs",
        body: runDetailPage(record, events, {
          evidence: listAvailableEvidence(record.app, record.evidenceDir, record.runId),
          live,
          // The values you would need to drive this app by hand, on the page
          // where you are most likely to be taking over from the machine.
          ...(demoFor(record.app) ? { demo: demoFor(record.app)! } : {}),
        }),
        ...(live ? { pollScript: pollScript({ runId: record.runId }) } : {}),
      }),
    );
  });

  /**
   * The frame behind the run page's "Live view".
   *
   * A UI route rather than an API one: `/api` is the contract an agent invokes
   * a capability through, and what the browser happens to be showing a human
   * mid-run is not part of that contract. The run page is the only caller.
   *
   * Never cached. The poll script cache-busts with a timestamp, but the
   * server-rendered `<img>` does not, and a cached first frame would leave the
   * live view frozen on the login screen for the whole run.
   */
  ui.get("/runs/:runId/screenshot", async (req, res) => {
    const record = deps.runs.get(req.params.runId);
    res.setHeader("Cache-Control", "no-store");
    if (!record) return res.status(404).type("text/plain").send("No such run.");

    const png = await deps.liveView?.screenshot(req.params.runId);
    if (png) return res.type("image/png").send(png);

    return res
      .type("image/svg+xml")
      .send(
        livePlaceholderSvg(
          isTerminalStatus(record.status)
            ? "This run has finished — the browser session is closed."
            : "Waiting for the browser session to open…",
        ),
      );
  });

  ui.get("/discovery", (_req, res) => {
    const active = deps.runs.active();
    res.send(
      page({
        title: "Discovery",
        activeNav: "discovery",
        body: discoveryPage({
          presets: presetRows(deps),
          recent: deps.runs.list({ kind: "discovery", limit: 8 }),
          ...(active ? { busyWith: active } : {}),
          // Checked rather than assumed: discovery is the only path that calls
          // a model, and finding out it cannot in the middle of a demo is the
          // worst possible time.
          modelConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
          model: DISCOVERY_MODEL,
        }),
        pollScript: runnerPollScript(),
      }),
    );
  });

  ui.post("/discovery/:id/run", async (req, res) => {
    try {
      const accepted = await deps.executor.discover({ capabilityId: req.params.id });
      // 303 so a refresh of the run page cannot start a second recording.
      return res.redirect(303, accepted.runUrl);
    } catch (err) {
      if (err instanceof PresetNotFoundError) {
        return res.status(404).send(page({ title: "Not found", body: notFoundBody(req.params.id) }));
      }
      return invokeError(res, err);
    }
  });

  ui.get("/faults", async (_req, res) => {
    if (!supportsFaultInjection(FAULT_APP)) {
      return res.status(404).send(page({ title: "Faults", body: notFoundBody("fault injection") }));
    }
    let error: string | undefined;
    try {
      armed = await readFaultSettings(FAULT_APP);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return res.send(
      page({
        title: "Fault injection",
        activeNav: "faults",
        body: faultsPage({ app: FAULT_APP, ...(armed ? { settings: armed } : {}), ...(error ? { error } : {}) }),
      }),
    );
  });

  ui.post("/faults", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    // A form with two submit buttons sends the clicked one last; "Disarm
    // everything" relies on that rather than on JavaScript.
    const raw = Array.isArray(body.forcedInject) ? body.forcedInject.at(-1)! : body.forcedInject;
    const settings: FaultSettings = {
      forcedInject: (raw as InjectKind | "none") || "none",
      errorRate: Number(body.errorRate ?? 0),
    };
    let error: string | undefined;
    try {
      await applyFaultSettings(FAULT_APP, settings);
      armed = settings;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return res.send(
      page({
        title: "Fault injection",
        activeNav: "faults",
        body: faultsPage({
          app: FAULT_APP,
          settings,
          ...(error ? { error } : { saved: true }),
        }),
      }),
    );
  });

  return ui;
}

/** Shown on the Discovery tab so the page names the model it is about to spend money on. */
const DISCOVERY_MODEL = "Claude Sonnet 5";

/**
 * The presets, joined to whatever is already on disk.
 *
 * Driven by the preset registry rather than the catalog: a capability that has
 * never been recorded on this machine still has a goal and can still be run,
 * and it is the more interesting row on the page — it is the one that proves
 * the artifacts were not hand-written.
 */
function presetRows(deps: ServerDeps): DiscoveryPreset[] {
  return Object.values(CAPABILITY_PRESETS)
    .map((preset) => {
      const existing = deps.catalog.get(preset.id);
      return {
        id: preset.id,
        app: preset.app,
        name: preset.name,
        goal: preset.goal,
        role: preset.preconditions.requiredRole ?? listRoles(preset.app)[0] ?? "",
        params: preset.params.map((p) => ({ name: p.name, exampleValue: p.exampleValue })),
        hasArtifact: existing !== undefined,
        ...(existing ? { currentVersion: existing.version } : {}),
      };
    })
    .sort((a, b) => a.app.localeCompare(b.app) || a.name.localeCompare(b.name));
}

/**
 * Known-good sign-on and member values for each app on the page.
 *
 * Assembled here rather than in the view because the view layer is pure by
 * construction — no data access, no `process.env` — and reading the environment
 * is exactly what makes this correct. Every adapter credential is
 * `env("SOME_VAR", "default")`, so on a machine where the real variable is set,
 * printing the effective value would publish a working password to anyone who
 * opens the console. The panel gets the checked-in default, or the *name* of
 * the variable that overrode it, and never the override itself.
 */
function cheatSheets(apps: string[]): Record<string, CheatSheetData> {
  const out: Record<string, CheatSheetData> = {};
  for (const app of new Set(apps)) {
    const demo = demoDataFor(app);
    if (!demo) continue;
    let adapter;
    try {
      adapter = getAppAdapter(app);
    } catch {
      continue;
    }
    out[app] = {
      credentials: Object.entries(adapter.roles).map(([role, creds]) => {
        const envVars = demo.credentialEnv[role];
        const overridden = envVars ? process.env[envVars.password] !== undefined : false;
        return {
          role,
          username: creds.username,
          ...(overridden ? { passwordFrom: envVars!.password } : { password: creds.password }),
          ...(creds.extra ? { extra: creds.extra } : {}),
        };
      }),
      members: demo.members.map((m) => ({ id: m.id, note: m.note, shares: m.shares })),
      verifiedOn: demo.verifiedOn,
      volatile: demo.volatile,
    };
  }
  return out;
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
  if (deps.catalog.get("meridian-read-member-record")) {
    links.push({
      label: "Happy path",
      description: "Read a member's name and contact details off the record page.",
      href: "/capabilities/meridian-read-member-record/invoke?memberId=101555",
    });
    links.push({
      label: "Business outcome",
      description: "The same capability against a member that does not exist — a legitimate answer, not a crash.",
      href: "/capabilities/meridian-read-member-record/invoke?memberId=999999",
    });
  }
  if (deps.catalog.get("meridian-place-account-hold")) {
    links.push({
      label: "Permission denied",
      description: "A supervisor-only action invoked as a teller — refused before the run touches the host.",
      href: "/capabilities/meridian-place-account-hold/invoke?memberId=101555&shareCode=MMKT-5&reasonCode=LEGAL&notes=Demo&role=teller",
    });
  }
  if (deps.catalog.get("meridian-read-share-balance")) {
    links.push({
      label: "Hard failure, escalated",
      description: "A share code that does not exist. No known outcome matches, so the run stops and hands you the live session.",
      href: "/capabilities/meridian-read-share-balance/invoke?memberId=101555&shareCode=BOGUS-9",
    });
  }
  return links;
}

/**
 * Sample requests for the ask box, phrased from what is actually recorded.
 *
 * Built from the catalog rather than hard-coded, so a console with different
 * capabilities suggests different things — and an example never references a
 * capability that is not there to route to. The member number is the one the
 * app's own demo data panel already publishes, so it is a value a reviewer has
 * seen before rather than a magic constant.
 */
function askExamples(entries: Array<{ id: string; inputParams: Array<{ name: string }> }>): string[] {
  const has = (id: string) => entries.some((e) => e.id === id);
  const out: string[] = [];
  if (has("meridian-read-member-record")) out.push("read member 101555's contact details");
  if (has("meridian-read-share-balance")) out.push("balance of share S0001 for 101555");
  if (has("meridian-find-member-by-name")) out.push("find the member called Turing");
  return out.slice(0, 3);
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
  return `<div class="rounded-lg border border-rule bg-surface p-8 text-center">
    <p class="text-sm text-stone-600">Nothing here for <code class="rounded bg-stone-100 px-1 font-mono">${escapeText(
      what,
    )}</code>.</p>
    <a class="mt-4 inline-block text-sm font-medium text-accent underline underline-offset-2" href="/">Back to capabilities</a>
  </div>`;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
