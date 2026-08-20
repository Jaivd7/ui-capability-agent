import { createReadStream, existsSync } from "node:fs";
import { Router } from "express";
import { listAppAdapters } from "../apps/index.js";
import { ParamValidationError } from "../replay/coerce.js";
import { CapabilityNotFoundError } from "./runtime/run-executor.js";
import { PresetNotFoundError } from "./runtime/discovery-runner.js";
import { evidenceFilePath, listAvailableEvidence } from "./runtime/evidence-reader.js";
import { EVIDENCE_FILES, RunnerBusyError, type EvidenceFile, type ServerDeps } from "./types.js";

/**
 * The capability API: invoke by name with typed args, get a structured result.
 *
 * The load-bearing decision is what HTTP status means here. It describes the
 * *API interaction*, never the automation outcome — so a poll is always 200 and
 * the three-way ReplayResult union survives verbatim into the body, exactly as
 * a programmatic caller of `runReplay` would receive it.
 *
 * A `business_outcome` is not a 4xx because it isn't an error; the caller asked
 * a question and got a legitimate answer. The more interesting half is that a
 * `hard_failure` isn't a 5xx either — a 5xx would claim *the API broke*, which
 * is false. The automation ran as designed and reported honestly. Only a bug in
 * this layer is a 500.
 */
export function createApiRouter(deps: ServerDeps): Router {
  const api = Router();

  api.get("/capabilities", (req, res) => {
    const app = typeof req.query.app === "string" ? req.query.app : undefined;
    res.json({ capabilities: withLastRun(deps, deps.catalog.list(app)) });
  });

  api.get("/capabilities/:id", (req, res) => {
    const entry = deps.catalog.get(req.params.id);
    if (!entry) return notFound(res, "capability_not_found", `No capability "${req.params.id}".`);
    return res.json(entry);
  });

  api.post("/capabilities/:id/invoke", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const accepted = await deps.executor.invoke({
        capabilityId: req.params.id,
        params: (body.params as Record<string, unknown>) ?? {},
        ...(typeof body.role === "string" ? { role: body.role } : {}),
        ...(typeof body.escalate === "boolean" ? { escalate: body.escalate } : {}),
        ...(typeof body.evidenceDir === "string" ? { evidenceDir: body.evidenceDir } : {}),
      });
      // 202, not 201: we are accepting work, not creating a resource the
      // caller owns. The run is addressable, but it isn't theirs.
      return res.status(202).location(accepted.statusUrl).json(accepted);
    } catch (err) {
      return invokeError(res, err);
    }
  });

  /**
   * Re-record a capability. Same accept-and-poll contract as invoke, and the
   * same single-flight lock — the two kinds of run share one browser session.
   */
  api.post("/capabilities/:id/discover", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const accepted = await deps.executor.discover({
        capabilityId: req.params.id,
        ...(typeof body.role === "string" ? { role: body.role } : {}),
        ...(typeof body.escalate === "boolean" ? { escalate: body.escalate } : {}),
      });
      return res.status(202).location(accepted.statusUrl).json(accepted);
    } catch (err) {
      return invokeError(res, err);
    }
  });

  api.get("/runs", (req, res) => {
    const q = req.query;
    res.json({
      runs: deps.runs.list({
        ...(typeof q.app === "string" ? { app: q.app } : {}),
        ...(typeof q.capabilityId === "string" ? { capabilityId: q.capabilityId } : {}),
        ...(q.kind === "replay" || q.kind === "discovery" ? { kind: q.kind } : {}),
        ...(typeof q.limit === "string" ? { limit: Number(q.limit) } : {}),
      }),
    });
  });

  api.get("/runs/:runId", (req, res) => {
    const record = deps.runs.get(req.params.runId);
    if (!record) return notFound(res, "run_not_found", `No run "${req.params.runId}".`);
    return res.json({
      ...record,
      evidence: listAvailableEvidence(record.app, record.evidenceDir, record.runId),
    });
  });

  /**
   * Always 200 for a known run. A poller distinguishes states by the body's
   * `status`, and a non-terminal status is a fact about the run rather than a
   * failure of the request.
   */
  api.get("/runs/:runId/status", (req, res) => {
    const record = deps.runs.get(req.params.runId);
    if (!record) return notFound(res, "run_not_found", `No run "${req.params.runId}".`);
    return res.json({
      runId: record.runId,
      kind: record.kind,
      capabilityId: record.capabilityId,
      capabilityVersion: record.capabilityVersion,
      app: record.app,
      role: record.role,
      status: record.status,
      escalated: record.escalated,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt,
      progress: record.progress,
      escalation: record.escalationPending,
      result: record.result ?? null,
    });
  });

  api.get("/runs/:runId/events", async (req, res) => {
    const record = deps.runs.get(req.params.runId);
    if (!record) return notFound(res, "run_not_found", `No run "${req.params.runId}".`);
    const since = typeof req.query.since === "string" ? Number(req.query.since) : 0;
    const events = await deps.runs.events(record.runId, Number.isFinite(since) ? since : 0);
    const last = events[events.length
- 1];
    return res.json({ events, nextCursor: last ? last.index + 1 : since });
  });

  api.get("/runs/:runId/evidence/:file", (req, res) => {
    const record = deps.runs.get(req.params.runId);
    if (!record) return notFound(res, "run_not_found", `No run "${req.params.runId}".`);
    const file = req.params.file as EvidenceFile;
    // A closed set rather than a path parameter: joining a caller-supplied
    // segment onto a directory is the obvious traversal hole, and there is no
    // reason for this to be open.
    if (!EVIDENCE_FILES.includes(file)) {
      return notFound(res, "unknown_evidence_file", `"${req.params.file}" is not an evidence file.`);
    }
    const path = evidenceFilePath(record.app, record.evidenceDir, record.runId, file);
    if (!existsSync(path)) return notFound(res, "evidence_not_found", `No ${file} for this run.`);
    // A captured DOM snapshot is served as text: it came from the target app,
    // and rendering it as HTML would execute it in the dashboard's origin.
    res.type(file.endsWith(".png") ? "image/png" : file.endsWith(".json") ? "application/json" : "text/plain");
    return createReadStream(path).pipe(res);
  });

  /** Polled by the catalog and overview pages so Invoke re-enables without a refresh. */
  api.get("/runner", (_req, res) => {
    const active = deps.runs.active();
    res.json({ busy: active !== undefined, active: active ?? null });
  });

  api.get("/apps", (_req, res) => {
    res.json({
      apps: listAppAdapters().map((a) => ({
        id: a.id,
        displayName: a.displayName,
        baseUrl: a.target(process.env).baseUrl,
        roles: Object.keys(a.roles),
      })),
    });
  });

  return api;
}

/**
 * `lastRun` can't be filled by the catalog, which has no view of run history —
 * joining it here keeps the catalog a pure function of what's on disk.
 */
function withLastRun(deps: ServerDeps, entries: ReturnType<ServerDeps["catalog"]["list"]>) {
  return entries.map((entry) => {
    const [latest] = deps.runs.list({ capabilityId: entry.id, limit: 1 });
    return {
      ...entry,
      ...(latest
        ? {
            lastRun: {
              runId: latest.runId,
              status: latest.status,
              ...(latest.finishedAt !== undefined ? { finishedAt: latest.finishedAt } : {}),
            },
          }
        : {}),
    };
  });
}

function notFound(res: Parameters<Parameters<Router["get"]>[1]>[1], code: string, message: string) {
  return res.status(404).json({ error: { code, message } });
}

/** Maps the executor's typed failures onto the one status code each deserves. */
export function invokeError(res: Parameters<Parameters<Router["get"]>[1]>[1], err: unknown) {
  if (err instanceof CapabilityNotFoundError) {
    return res.status(404).json({ error: { code: "capability_not_found", message: err.message } });
  }
  if (err instanceof PresetNotFoundError) {
    // A recorded capability with no preset is a real and legitimate state —
    // the artifact exists, the recipe for re-recording it does not.
    return res.status(404).json({ error: { code: "preset_not_found", message: err.message } });
  }
  if (err instanceof ParamValidationError) {
    return res.status(400).json({
      error: { code: "invalid_params", message: err.message, fields: err.fields },
    });
  }
  if (err instanceof RunnerBusyError) {
    // The body carries the blocking run deliberately: an escalation-paused run
    // holds the single-flight lock for as long as the operator takes, so a
    // caller told "no" needs to be able to go and see why.
    return res.status(409).json({
      error: {
        code: "runner_busy",
        message: err.message,
        activeRun: { ...err.activeRun, runUrl: `/runs/${err.activeRun.runId}` },
      },
    });
  }
  return res.status(500).json({
    error: { code: "internal_error", message: err instanceof Error ? err.message : String(err) },
  });
}
