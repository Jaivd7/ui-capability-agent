import type { CapabilityArtifact, InputParam, OutputField } from "../artifact/schema.js";
import type { ParamValue } from "../artifact/template.js";
import type { ReplayResult } from "../replay/result.js";
import type { HumanIntervention, InterventionContext } from "../escalation/types.js";

/**
 * The contracts the dashboard server is built from.
 *
 * Written before any of the modules that implement them, deliberately: the
 * read path, the views and the executor are independent enough to build in
 * parallel, and the one thing that would make that go wrong is each of them
 * inventing its own shape for a run. This file is the shared vocabulary.
 */

// ---------------------------------------------------------------------------
// Two status vocabularies, kept apart on purpose
// ---------------------------------------------------------------------------

/**
 * The *process lifecycle* of a run, which is a strictly larger vocabulary than
 * the automation outcome.
 *
 * `ReplayResult["status"]` has three values and describes what the automation
 * concluded. This has six and describes where the run *is* — including two
 * states that are not outcomes at all: a run parked inside an escalation
 * (no result exists yet; the engine is suspended mid-call) and a run whose
 * process died (no result will ever exist).
 *
 * Mapping is one-way, `ReplayResult` -> `RunStatus`. Nothing ever converts back.
 */
export type RunStatus =
  | "running"
  | "escalation_pending"
  | "succeeded"
  | "business_outcome"
  | "failed"
  | "crashed";

export type RunKind = "replay" | "discovery";

export function isTerminalStatus(status: RunStatus): boolean {
  return status !== "running" && status !== "escalation_pending";
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunProgress {
  /** Known for replay (the artifact's step count); undefined for discovery. */
  stepsTotal?: number;
  stepsCompleted: number;
  currentStepId?: string;
  currentStepDescription?: string;
}

export interface EscalationSummary {
  kind: InterventionContext["kind"];
  reason: string;
  raisedAt: string;
  /** Dashboard path, e.g. `/runs/<id>/escalation`. */
  consoleUrl: string;
  pendingAction?: { description: string; locatorSummary: string };
}

/** Enough to render a history row without reading the whole log. */
export interface RunSummary {
  runId: string;
  kind: RunKind;
  capabilityId: string;
  capabilityVersion?: number;
  app: string;
  role: string;
  status: RunStatus;
  /**
   * Derived, never a status of its own: a run can be both `succeeded` and
   * escalated, and collapsing that into one field loses the more interesting
   * half.
   */
  escalated: boolean;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface RunRecord extends RunSummary {
  baseUrl: string;
  /** Directory under `evidence/<app>/` this run wrote to. */
  evidenceDir: string;
  logPath: string;
  updatedAt: string;
  /** Already redacted per `inputParams[].sensitive`. */
  params: Record<string, unknown>;
  progress: RunProgress;
  escalationPending?: EscalationSummary;
  /** Replay only. Outputs are unredacted here — see the note on RunRegistry. */
  result?: ReplayResult;
  humanIntervention?: HumanIntervention;
  /** Discovery only: the loop's own outcome vocabulary, kept for fidelity. */
  discoveryOutcome?: string;
  error?: string;
}

/** A parsed line of a run's JSONL, as the timeline renders it. */
export interface RunEvent {
  index: number;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

/**
 * The evidence files a run can produce. A fixed set rather than a path
 * parameter: joining a caller-supplied segment onto a directory is the obvious
 * traversal hole, and there is no reason for this to be open.
 */
export const EVIDENCE_FILES = [
  "jsonl",
  "result.json",
  "failure.png",
  "failure.dom.html",
  "escalation.png",
  "artifact.json",
  "transcript.json",
  "quality.json",
  "probe.jsonl",
] as const;
export type EvidenceFile = (typeof EVIDENCE_FILES)[number];

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * What an agent needs to invoke a capability by name without knowing anything
 * about the UI.
 *
 * `steps`, `checkpoints` and locator chains are deliberately absent: those
 * *are* UI knowledge, and shipping them in a catalog whose whole premise is
 * "you don't need to know the UI" would quietly contradict it. They're on the
 * detail view, for a human reviewer and for debugging.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  version: number;
  schemaVersion: string;
  contentHash: string;
  app: string;
  appDisplayName: string;
  baseUrl: string;
  requiredRole: string | null;
  /** True if any step is marked irreversible — i.e. this call may block on a human. */
  irreversible: boolean;
  inputParams: InputParam[];
  outputs: OutputField[];
  knownOutcomes: Array<{
    id: string;
    classification: "business" | "recoverable";
    code?: string;
    message?: string;
    description: string;
  }>;
  lastRun?: { runId: string; status: RunStatus; finishedAt?: string };
}

export interface CatalogEntryDetail extends CatalogEntry {
  artifact: CapabilityArtifact;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export interface InvokeRequest {
  capabilityId: string;
  /** Raw values; coerced against the artifact's declared types by src/replay/coerce.ts. */
  params: Record<string, unknown>;
  role?: string;
  /** Defaults to true on the server, unlike the CLIs — see the plan's E6. */
  escalate?: boolean;
  evidenceDir?: string;
}

export interface InvokeAccepted {
  runId: string;
  capabilityId: string;
  status: RunStatus;
  statusUrl: string;
  runUrl: string;
  warnings: string[];
}

/** Thrown by the executor when a run is already in flight. */
export class RunnerBusyError extends Error {
  constructor(readonly activeRun: RunSummary) {
    super(`A run is already in progress: ${activeRun.runId}`);
    this.name = "RunnerBusyError";
  }
}

// ---------------------------------------------------------------------------
// Module interfaces
// ---------------------------------------------------------------------------

export interface RunQuery {
  app?: string;
  capabilityId?: string;
  kind?: RunKind;
  status?: RunStatus;
  escalated?: boolean;
  limit?: number;
}

/**
 * Disk is the durable store; this is a cache of the current process's runs plus
 * the single-flight lock.
 *
 * One thing genuinely is not derivable from the log: a crashed run and an
 * in-flight run are byte-identical (a `run_start`, no `run_end`), because the
 * missing fact is "the process writing this is gone." `rebuildFromDisk` fixes
 * that by exploiting the one moment when it *is* knowable — at startup nothing
 * is running, so any unfinished log belongs to a dead process.
 *
 * Live records hold unredacted outputs, because an operator at the dashboard is
 * entitled to see a balance they just asked for. Records rebuilt from disk hold
 * whatever the persisted evidence holds, which is redacted. That asymmetry is
 * intentional and matches the existing rule in the replay CLI.
 */
export interface RunRegistry {
  rebuildFromDisk(): Promise<void>;
  list(query?: RunQuery): RunSummary[];
  get(runId: string): RunRecord | undefined;
  /** Full event log, read on demand rather than held in memory. */
  events(runId: string, since?: number): Promise<RunEvent[]>;
  create(record: RunRecord): void;
  update(runId: string, patch: Partial<RunRecord>): void;
  /** The single in-flight run, if any. */
  active(): RunSummary | undefined;
}

export interface Catalog {
  list(app?: string): CatalogEntry[];
  get(id: string): CatalogEntryDetail | undefined;
  /** Re-reads from disk when a file's mtime changed. */
  refresh(): void;
}

export interface RunExecutor {
  invoke(req: InvokeRequest): Promise<InvokeAccepted>;
  /**
   * Re-record a capability with the LLM in the loop. Shares the single-flight
   * lock with `invoke`: one browser session, one run, whichever kind.
   */
  discover(req: { capabilityId: string; role?: string; escalate?: boolean }): Promise<InvokeAccepted>;
  /** Resolves when no run is in flight. Used by graceful shutdown. */
  drain(timeoutMs: number): Promise<void>;
}

/**
 * The live browser page of whichever run is in flight, for the run page's
 * "Live view".
 *
 * Kept out of `RunRecord` deliberately: a record is JSON the API serializes to
 * callers, and a Playwright handle is neither serializable nor something an API
 * client should reach. The executor owns the lifetime — registered when it
 * acquires a session, released before that session is closed — so a runId that
 * is absent here has no live page *by definition*, whatever its status says.
 */
export interface LiveView {
  register(runId: string, page: import("playwright").Page): void;
  release(runId: string): void;
  has(runId: string): boolean;
  /** A PNG of the run's current page, or undefined when there is no frame to give. */
  screenshot(runId: string): Promise<Buffer | undefined>;
}

export interface ServerDeps {
  catalog: Catalog;
  runs: RunRegistry;
  executor: RunExecutor;
  /**
   * Optional so the app can be composed without a browser — the view tests and
   * the executor tests both build deps by hand, and neither has a page to show.
   */
  liveView?: LiveView;
  /** Base path the dashboard is mounted at, for building links. */
  basePath?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers the views and the API both need
// ---------------------------------------------------------------------------

export function statusFromResult(result: ReplayResult): RunStatus {
  switch (result.status) {
    case "success":
      return "succeeded";
    case "business_outcome":
      return "business_outcome";
    case "hard_failure":
      return "failed";
  }
}

/** Human-facing label for a status chip. */
export const STATUS_LABELS: Record<RunStatus, string> = {
  running: "Running",
  escalation_pending: "Awaiting operator",
  succeeded: "Success",
  business_outcome: "Business outcome",
  failed: "Failed",
  crashed: "Crashed",
};

export type { ParamValue };
