import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EVIDENCE_FILES, type EvidenceFile, type RunEvent } from "../types.js";

/**
 * Reading the evidence tree a run wrote, and nothing else.
 *
 * The dashboard's whole read path is "what's on disk", so this module is
 * deliberately the only place that knows the `evidence/<app>/<dir>/<runId>.<ext>`
 * layout. Everything above it addresses evidence by (app, dir, runId, file)
 * and never by a path it composed itself.
 *
 * Two properties matter more than speed here:
 *  - A malformed line is skipped, never thrown. The log is appended to by a
 *    live process, so the last line of a file being read mid-write is
 *    routinely half a JSON object. A timeline that 500s because it polled at
 *    the wrong microsecond is worse than a timeline that's one event behind.
 *  - Every event carries the ordinal of the line it came from, so a poller can
 *    ask for `since = last.index + 1` and get a delta. Malformed lines consume
 *    an ordinal rather than being squeezed out, so the numbering is stable
 *    across re-reads even if a half-written line later becomes valid.
 */

/**
 * Resolved per call rather than captured in a module const: tests point the
 * process at a temp tree, and a const frozen at import time would silently
 * ignore that.
 */
export function evidenceRoot(): string {
  return join(process.cwd(), "evidence");
}

/** Events from line `since` onward. Lines before it are never parsed. */
export async function readEvents(logPath: string, since = 0): Promise<RunEvent[]> {
  const text = await readTextAsync(logPath);
  return text === undefined ? [] : eventsFromText(text, since);
}

export interface LogEnds {
  first?: RunEvent;
  last?: RunEvent;
  /**
   * The closing `run_end`, which is *not* always the last line: the discovery
   * CLI appends `recording_score` after the loop returns, and any future
   * post-run bookkeeping would land there too. Treating the final line as the
   * outcome reads every scored discovery run as crashed.
   */
  runEnd?: RunEvent;
  /** Non-blank lines, i.e. the event count including any malformed ones. */
  count: number;
}

/**
 * The handful of events a history row needs, without building an object per
 * line.
 *
 * The file is read whole — at this project's scale that's a few hundred KB and
 * a streaming line reader would be more machinery than the problem deserves —
 * but only the ends are turned into objects, which is the part that actually
 * costs something when a list view touches every run on every request. The
 * search for `run_end` string-matches before it parses, so the usual case
 * (it's the last or second-to-last line) parses one extra line and the worst
 * case parses none.
 */
export async function readFirstAndLast(logPath: string): Promise<LogEnds> {
  const text = await readTextAsync(logPath);
  return text === undefined ? { count: 0 } : endsFromText(text);
}

/**
 * Synchronous twin of `readFirstAndLast`, for `RunRegistry.list()`.
 *
 * `list()` is synchronous by contract (the views render from it inline), and
 * it needs disk-derived rows. Blocking on a local file read is the honest way
 * to satisfy that; the alternative — a cache that only a prior async call can
 * fill — makes `list()` silently return stale or empty history. The mtime
 * cache in the registry keeps the actual number of these reads near zero.
 */
export function readFirstAndLastSync(logPath: string): LogEnds {
  const text = readTextSync(logPath);
  return text === undefined ? { count: 0 } : endsFromText(text);
}

/** Synchronous twin of `readEvents`, same reason as above. */
export function readEventsSync(logPath: string, since = 0): RunEvent[] {
  const text = readTextSync(logPath);
  return text === undefined ? [] : eventsFromText(text, since);
}

export function evidenceFilePath(
  app: string,
  evidenceDir: string,
  runId: string,
  file: EvidenceFile,
): string {
  // `file` is a closed union, but app/evidenceDir/runId arrive from run records
  // that were themselves derived from disk or from an HTTP request. One bad
  // segment is all a traversal needs, so they're checked here rather than at
  // each call site.
  assertPathSegment(app, "app");
  assertPathSegment(evidenceDir, "evidenceDir");
  assertPathSegment(runId, "runId");
  return join(evidenceRoot(), app, evidenceDir, `${runId}.${file}`);
}

/** Which of the fixed evidence files this run actually produced. */
export function listAvailableEvidence(
  app: string,
  evidenceDir: string,
  runId: string,
): EvidenceFile[] {
  return EVIDENCE_FILES.filter((file) => existsSync(evidenceFilePath(app, evidenceDir, runId, file)));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function eventsFromText(text: string, since: number): RunEvent[] {
  const lines = text.split("\n");
  const events: RunEvent[] = [];
  for (let i = Math.max(0, since); i < lines.length; i += 1) {
    const event = parseLine(lines[i], i);
    if (event) events.push(event);
  }
  return events;
}

function endsFromText(text: string): LogEnds {
  const lines = text.split("\n");

  let first: RunEvent | undefined;
  for (let i = 0; i < lines.length && !first; i += 1) first = parseLine(lines[i], i);

  let last: RunEvent | undefined;
  for (let i = lines.length - 1; i >= 0 && !last; i -= 1) last = parseLine(lines[i], i);

  let runEnd: RunEvent | undefined;
  for (let i = lines.length - 1; i >= 0 && !runEnd; i -= 1) {
    // The substring can also appear inside a `reason` string, so a hit is only
    // a candidate — the parsed event still has to be a run_end.
    if (!lines[i]?.includes(RUN_END_MARKER)) continue;
    const candidate = parseLine(lines[i], i);
    if (candidate?.type === "run_end") runEnd = candidate;
  }

  let count = 0;
  for (const line of lines) if (line.trim() !== "") count += 1;

  return {
    ...(first ? { first } : {}),
    ...(last ? { last } : {}),
    ...(runEnd ? { runEnd } : {}),
    count,
  };
}

/** JSON.stringify emits no spaces, so this is what every writer produces. */
const RUN_END_MARKER = '"type":"run_end"';

/** Returns undefined for blank, unparseable, or non-event lines. */
function parseLine(raw: string | undefined, index: number): RunEvent | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  // `type` is the one field every writer in the codebase sets (see
  // src/logging/logger.ts); a line without it isn't a run event, whatever else
  // it may be.
  if (typeof record.type !== "string") return undefined;

  return {
    ...record,
    index,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
    type: record.type,
  };
}

async function readTextAsync(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

function readTextSync(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/**
 * A missing log isn't an error: a run's row can exist before its first line is
 * flushed, and a poller shouldn't have to distinguish "not yet" from "gone".
 */
function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function assertPathSegment(value: string, label: string): void {
  if (value === "" || value === "." || value === ".." || /[/\\\0]/.test(value)) {
    throw new Error(`Invalid ${label} path segment: ${JSON.stringify(value)}`);
  }
}
