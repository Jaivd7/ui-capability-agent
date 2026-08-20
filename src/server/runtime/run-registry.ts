import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReplayResult } from "../../replay/result.js";
import type {
  Catalog,
  RunEvent,
  RunKind,
  RunQuery,
  RunRecord,
  RunSummary,
  RunRegistry,
} from "../types.js";
import { isTerminalStatus } from "../types.js";
import {
  evidenceRoot,
  readEvents,
  readFirstAndLastSync,
  type LogEnds,
} from "./evidence-reader.js";
import { statusFromEvents } from "./run-status.js";

/**
 * The registry: an index over the evidence tree, plus this process's live runs.
 *
 * Disk is the store. Nothing here is authoritative except the live map, and the
 * live map only holds runs this server started — which is exactly the set for
 * which "is a process still writing this?" has a knowable answer. Everything
 * else is re-derived from the logs, so a restart loses nothing but liveness.
 */

export interface RunRegistryDeps {
  /** Used to fill in `progress.stepsTotal`, which is in the artifact, not the log. */
  catalog?: Catalog;
  /**
   * Not in the module contract; defaulted to `evidenceRoot()`. Tests point it
   * at a temp tree instead of chdir'ing the whole process, which is what makes
   * them safe to run alongside anything else.
   */
  evidenceRoot?: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  record: RunRecord;
}

export function createRunRegistry(deps: RunRegistryDeps): RunRegistry {
  const root = deps.evidenceRoot ?? evidenceRoot();

  /** Runs this process started. Authoritative for anything it holds. */
  const live = new Map<string, RunRecord>();
  /** logPath -> derived record, invalidated on mtime/size change. */
  const cache = new Map<string, CacheEntry>();
  /** runId -> derived record, rebuilt from `cache` on every scan. */
  let fromDisk = new Map<string, RunRecord>();

  function scan(): void {
    const found = new Map<string, RunRecord>();
    const seen = new Set<string>();

    for (const logPath of listRunLogs(root)) {
      seen.add(logPath);
      const stats = statSync(logPath, { throwIfNoEntry: false });
      if (!stats) continue;

      const cached = cache.get(logPath);
      // Size as well as mtime: a log appended to twice inside one filesystem
      // mtime tick is entirely possible for a run that finishes in
      // milliseconds, and the second write is the one that says `run_end`.
      const record =
        cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size
          ? cached.record
          : deriveFromDisk(logPath, root, stats.mtimeMs, deps.catalog);
      if (!record) continue;

      cache.set(logPath, { mtimeMs: stats.mtimeMs, size: stats.size, record });
      found.set(record.runId, record);
    }

    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    fromDisk = found;
  }

  /**
   * Async only because the interface is. The work is synchronous because
   * `list()` is synchronous and both have to see the same tree.
   */
  async function rebuildFromDisk(): Promise<void> {
    // Nothing derived before a restart is worth keeping: the whole reason to
    // sweep is that liveness assumptions from the previous process are void.
    cache.clear();
    scan();
  }

  function merged(): RunRecord[] {
    scan();
    // A live record always wins: it holds unredacted outputs, the escalation
    // summary, and the only correct liveness answer. The disk-derived twin of
    // an in-flight run says `crashed`, because that's what an unfinished log
    // looks like from outside.
    const byId = new Map(fromDisk);
    for (const [runId, record] of live) byId.set(runId, record);
    return [...byId.values()];
  }

  return {
    rebuildFromDisk,

    list(query: RunQuery = {}): RunSummary[] {
      const rows = merged()
        .filter((r) => matches(r, query))
        .sort((a, b) => compareDesc(a, b));
      return (query.limit !== undefined ? rows.slice(0, query.limit) : rows).map(toSummary);
    },

    get(runId: string): RunRecord | undefined {
      const liveRecord = live.get(runId);
      if (liveRecord) return liveRecord;
      scan();
      return fromDisk.get(runId);
    },

    async events(runId: string, since = 0): Promise<RunEvent[]> {
      const record = live.get(runId) ?? fromDisk.get(runId);
      if (!record) {
        scan();
        const rescanned = fromDisk.get(runId);
        if (!rescanned) return [];
        return readEvents(rescanned.logPath, since);
      }
      return readEvents(record.logPath, since);
    },

    create(record: RunRecord): void {
      live.set(record.runId, record);
    },

    update(runId: string, patch: Partial<RunRecord>): void {
      const existing = live.get(runId) ?? fromDisk.get(runId);
      if (!existing) {
        throw new Error(`Cannot update unknown run "${runId}".`);
      }
      // Updating a disk-derived run promotes it into the live map, which is
      // right: something in this process now owns it.
      live.set(runId, { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() });
    },

    active(): RunSummary | undefined {
      // Single-flight by design, so "the" active run is well defined. Sorted
      // newest-first anyway, so a leaked non-terminal record can't shadow the
      // run that's actually going.
      const running = merged().filter((r) => !isTerminalStatus(r.status)).sort(compareDesc);
      const first = running[0];
      return first ? toSummary(first) : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Disk derivation
// ---------------------------------------------------------------------------

/** `evidence/<app>/<evidenceDir>/<runId>.jsonl`, excluding `<runId>.probe.jsonl`. */
function listRunLogs(root: string): string[] {
  if (!existsSync(root)) return [];
  const logs: string[] = [];
  for (const app of subdirectories(root)) {
    for (const dir of subdirectories(join(root, app))) {
      for (const file of readdirSync(join(root, app, dir))) {
        if (!file.endsWith(".jsonl") || file.endsWith(".probe.jsonl")) continue;
        logs.push(join(root, app, dir, file));
      }
    }
  }
  return logs.sort();
}

function subdirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * A record from the two ends of a log.
 *
 * `isLive: false` unconditionally, and that is the crash derivation: this
 * function only ever runs for a run the live map doesn't hold, so either the
 * process that wrote it is gone (boot sweep, or a run from an earlier
 * process) or it belongs to a different process this server has no way to
 * supervise. In both cases "no run_end" means no result is coming. The one
 * case where an unfinished log is genuinely in flight — a run this server
 * started — never reaches here, because the live record shadows it.
 */
function deriveFromDisk(
  logPath: string,
  root: string,
  mtimeMs: number,
  catalog: Catalog | undefined,
): RunRecord | undefined {
  const location = locationOf(logPath, root);
  if (!location) return undefined;
  const { app, evidenceDir, runId } = location;

  const ends = readFirstAndLastSync(logPath);
  const first = ends.first;
  const last = ends.last;
  const runEnd = ends.runEnd;
  const derived = statusFromEvents(endsAsEvents(ends), false);
  const mtimeIso = new Date(mtimeMs).toISOString();
  const startedAt = first?.timestamp || mtimeIso;
  const finishedAt = runEnd ? runEnd.timestamp || mtimeIso : undefined;
  const capabilityId = str(first?.capabilityId) ?? capabilityIdFromRunId(runId);

  const summary: RunSummary = {
    runId,
    kind: kindOf(first, runEnd),
    capabilityId,
    // The directory the file lives in is more trustworthy than the log line:
    // logs written before run_start carried app/role at all still land in the
    // right place on disk.
    app,
    role: str(first?.role) ?? "unknown",
    status: derived.status,
    escalated: derived.escalated,
    startedAt,
    ...(typeof first?.capabilityVersion === "number" ? { capabilityVersion: first.capabilityVersion } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...durationOf(startedAt, finishedAt),
  };

  const result = readResultJson(logPath);
  const stepsTotal = catalog?.get(capabilityId)?.artifact.steps.length;
  const error = errorFor(derived.status, runEnd, result);

  return {
    ...summary,
    baseUrl: str(first?.baseUrl) ?? "",
    evidenceDir,
    logPath,
    updatedAt: last?.timestamp || mtimeIso,
    // Already redacted: run_start logs params through redactParamsForLog.
    params: isPlainObject(first?.params) ? first.params : {},
    progress: {
      // Not the count of `step_result` lines — only two events were read, so
      // counting them would understate a long run as "1 step done". The
      // end-of-run total is the one honest number available from the ends.
      stepsCompleted: completedFromRunEnd(runEnd),
      ...(stepsTotal !== undefined ? { stepsTotal } : {}),
      ...(derived.progress.currentStepId !== undefined
        ? { currentStepId: derived.progress.currentStepId }
        : {}),
      ...(derived.progress.currentStepDescription !== undefined
        ? { currentStepDescription: derived.progress.currentStepDescription }
        : {}),
    },
    // Only from result.json. Reconstructing a result from the two ends alone
    // would produce a success with no outputs, which reads as "it returned
    // nothing" rather than "we didn't look" — a detail view wanting the real
    // thing can re-derive from `events()`.
    ...(result ? { result } : {}),
    ...(derived.discoveryOutcome !== undefined ? { discoveryOutcome: derived.discoveryOutcome } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * The sampled events, in log order. Deduplicated by line ordinal because the
 * three slots overlap constantly — a one-line log is all three, and a replay
 * log's last line is usually also its run_end — and a duplicate would double
 * every count derived from them.
 */
function endsAsEvents(ends: LogEnds): RunEvent[] {
  const byIndex = new Map<number, RunEvent>();
  for (const event of [ends.first, ends.runEnd, ends.last]) {
    if (event) byIndex.set(event.index, event);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function locationOf(
  logPath: string,
  root: string,
): { app: string; evidenceDir: string; runId: string } | undefined {
  const relative = logPath.startsWith(root) ? logPath.slice(root.length) : logPath;
  const parts = relative.split(/[/\\]/).filter((p) => p !== "");
  if (parts.length !== 3) return undefined;
  const [app, evidenceDir, file] = parts as [string, string, string];
  return { app, evidenceDir, runId: file.replace(/\.jsonl$/, "") };
}

/**
 * Run ids are `<capabilityId>-<epochMillis>` by construction in both CLIs.
 * Only used for logs written before run_start carried `capabilityId` — the
 * committed evidence from earlier phases is exactly that.
 */
function capabilityIdFromRunId(runId: string): string {
  return runId.replace(/-\d{9,}$/, "");
}

function kindOf(first: RunEvent | undefined, runEnd: RunEvent | undefined): RunKind {
  if (first?.kind === "discovery" || first?.kind === "replay") return first.kind;
  return runEnd?.outcome !== undefined || first?.goal !== undefined ? "discovery" : "replay";
}

/** Replay counts `stepsExecuted`, discovery counts `stepCount`. */
function completedFromRunEnd(runEnd: RunEvent | undefined): number {
  if (typeof runEnd?.stepsExecuted === "number") return runEnd.stepsExecuted;
  if (typeof runEnd?.stepCount === "number") return runEnd.stepCount;
  return 0;
}

function durationOf(startedAt: string, finishedAt: string | undefined): { durationMs?: number } {
  if (finishedAt === undefined) return {};
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return {};
  return { durationMs: Math.max(0, end - start) };
}

function errorFor(
  status: RunSummary["status"],
  runEnd: RunEvent | undefined,
  result: ReplayResult | undefined,
): string | undefined {
  if (status === "crashed") {
    return "Run log has no run_end event: the process writing it exited before the run finished.";
  }
  if (status !== "failed") return undefined;
  if (result?.status === "hard_failure") return result.reason;
  return str(runEnd?.reason) ?? "Run failed.";
}

/**
 * The authoritative result, written next to the log by the replay CLI and
 * already redacted per the artifact's `sensitive` flags.
 */
function readResultJson(logPath: string): ReplayResult | undefined {
  const path = logPath.replace(/\.jsonl$/, ".result.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(parsed)) return undefined;
    const status = parsed.status;
    if (status !== "success" && status !== "business_outcome" && status !== "hard_failure") {
      return undefined;
    }
    return parsed as unknown as ReplayResult;
  } catch {
    // A truncated or hand-edited result.json degrades the row, it doesn't
    // remove the run from history.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

function matches(record: RunRecord, query: RunQuery): boolean {
  if (query.app !== undefined && record.app !== query.app) return false;
  if (query.capabilityId !== undefined && record.capabilityId !== query.capabilityId) return false;
  if (query.kind !== undefined && record.kind !== query.kind) return false;
  if (query.status !== undefined && record.status !== query.status) return false;
  if (query.escalated !== undefined && record.escalated !== query.escalated) return false;
  return true;
}

/** Newest first, with runId as a tiebreak so paging is stable. */
function compareDesc(a: RunSummary, b: RunSummary): number {
  return b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId);
}

function toSummary(record: RunRecord): RunSummary {
  const { runId, kind, capabilityId, app, role, status, escalated, startedAt } = record;
  return {
    runId,
    kind,
    capabilityId,
    app,
    role,
    status,
    escalated,
    startedAt,
    ...(record.capabilityVersion !== undefined ? { capabilityVersion: record.capabilityVersion } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
