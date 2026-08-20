import type { HumanAction, HumanIntervention } from "../../../escalation/types.js";
import type { EvidenceFile, RunEvent, RunRecord } from "../../types.js";
import { isTerminalStatus } from "../../types.js";
import { escapeHtml, escapeUrl } from "../layout.js";
import {
  appBadge,
  card,
  code,
  duration,
  emptyState,
  escalatedBadge,
  keyValueList,
  roleBadge,
  statusChip,
  table,
  timeAgo,
  typeBadge,
} from "../components.js";

/**
 * One page serves a live run and an archived one. They are not two views: the
 * only difference is whether the status is terminal, which decides whether a
 * screenshot is streaming and whether a result section exists yet. Building it
 * once means the thing a reviewer watches live is byte-for-byte the thing they
 * link to afterwards — no "it looked different while it was running".
 */

export interface RunDetailOptions {
  evidence: EvidenceFile[];
  /** True while the server intends the page to poll. */
  live: boolean;
}

export function runDetailPage(record: RunRecord, events: RunEvent[], opts: RunDetailOptions): string {
  const terminal = isTerminalStatus(record.status);
  const live = opts.live && !terminal;

  return `${header(record)}
  ${escalationBanner(record)}
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
    <div class="space-y-6 lg:col-span-2">
      ${resultSection(record)}
      ${card(
        "Timeline",
        timeline(events, live),
        { actions: `<span class="text-xs text-slate-400">${escapeHtml(String(events.length))} events</span>` },
      )}
      ${humanSection(record)}
    </div>
    <div class="space-y-6">
      ${inputsCard(record)}
      ${live ? liveScreenshot(record) : ""}
      ${evidenceCard(record, opts.evidence)}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function header(record: RunRecord): string {
  const title = record.kind === "discovery" ? `Discovery: ${record.capabilityId}` : record.capabilityId;
  return `<div class="mb-6">
    <a href="/runs" class="text-xs text-slate-500 hover:text-slate-800">&larr; Runs</a>
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <h1 class="text-xl font-semibold tracking-tight text-slate-900">${escapeHtml(title)}</h1>
      ${
        record.capabilityVersion !== undefined
          ? `<span class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">v${escapeHtml(
              String(record.capabilityVersion),
            )}</span>`
          : ""
      }
      ${appBadge(record.app)}
      ${roleBadge(record.role)}
      <span data-run-status>${statusChip(record.status)}</span>
      ${record.escalated ? escalatedBadge() : ""}
    </div>
    <p class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
      <span class="font-mono text-slate-400">${escapeHtml(record.runId)}</span>
      <span>${escapeHtml(record.kind)}</span>
      <span title="${escapeHtml(record.startedAt)}">started ${escapeHtml(timeAgo(record.startedAt))}</span>
      <span>${escapeHtml(
        record.durationMs !== undefined ? `took ${duration(record.durationMs)}` : "still running",
      )}</span>
      <span>${escapeHtml(record.baseUrl)}</span>
      ${
        record.progress.stepsTotal !== undefined
          ? `<span class="tabular-nums">step ${escapeHtml(
              String(record.progress.stepsCompleted),
            )}/${escapeHtml(String(record.progress.stepsTotal))}</span>`
          : `<span class="tabular-nums">${escapeHtml(String(record.progress.stepsCompleted))} steps done</span>`
      }
    </p>
    ${
      record.progress.currentStepDescription && !isTerminalStatus(record.status)
        ? `<p class="mt-2 text-sm text-slate-600">Currently: ${escapeHtml(
            record.progress.currentStepDescription,
          )}</p>`
        : ""
    }
  </div>`;
}

function escalationBanner(record: RunRecord): string {
  const esc = record.escalationPending;
  if (!esc) return "";
  const href = esc.consoleUrl || `/runs/${escapeUrl(record.runId)}/escalation`;
  return `<div class="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-5 py-4">
    <div class="flex flex-wrap items-start gap-4">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-amber-900">&#9995; This run is paused and waiting for you</p>
        <p class="mt-1 text-sm text-amber-900">${escapeHtml(esc.reason)}</p>
        <p class="mt-1 text-xs text-amber-800">
          ${escapeHtml(esc.kind)} &middot; raised ${escapeHtml(timeAgo(esc.raisedAt))}
          ${
            esc.pendingAction
              ? ` &middot; pending action: ${escapeHtml(esc.pendingAction.description)} (${escapeHtml(
                  esc.pendingAction.locatorSummary,
                )})`
              : ""
          }
        </p>
      </div>
      <a href="${escapeHtml(href)}" class="shrink-0 rounded-lg bg-amber-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-700">
        Take control &rarr;
      </a>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function inputsCard(record: RunRecord): string {
  const entries = Object.entries(record.params);
  const body = entries.length
    ? keyValueList(
        entries.map(([name, value]) => ({
          label: name,
          value: { html: `<span class="font-mono text-slate-800">${escapeHtml(formatValue(value))}</span>` },
        })),
      )
    : `<p class="text-sm text-slate-400">No parameters.</p>`;

  const query = entries
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const reinvoke = `/capabilities/${escapeUrl(record.capabilityId)}/invoke${query ? `?${escapeHtml(query)}` : ""}`;

  return card("Inputs as submitted", body, {
    actions: `<a href="${reinvoke}" class="text-xs font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900">Re-invoke with these</a>`,
  });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function timeline(events: RunEvent[], live: boolean): string {
  const rows = events.map((event, i) => {
    const prev = i > 0 ? events[i - 1] : undefined;
    return timelineRow(event, prev?.timestamp);
  });

  const list = rows.length
    ? `<ol id="timeline" class="divide-y divide-slate-100">${rows.join("")}</ol>`
    : `<ol id="timeline" class="divide-y divide-slate-100"></ol>${emptyState("No events logged yet.")}`;

  const footer = live
    ? `<p id="timeline-live" class="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500"></span>
        Watching for new events. The page reloads itself once the run finishes.
      </p>`
    : "";
  return `${list}${footer}`;
}

interface EventStyle {
  label: string;
  tone: string;
  glyph: string;
}

function styleFor(event: RunEvent): EventStyle {
  const ok = boolField(event, "ok");
  switch (event.type) {
    case "step_result":
      return ok
        ? { label: "step", tone: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", glyph: "&#10003;" }
        : { label: "step", tone: "bg-red-50 text-red-700 ring-red-600/20", glyph: "&#10007;" };
    case "step_retry":
      return { label: "retry", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: "&#8635;" };
    case "flow_restart":
      return { label: "flow restart", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: "&#8634;" };
    case "known_outcome":
      return { label: "known outcome", tone: "bg-slate-100 text-slate-700 ring-slate-500/25", glyph: "&#9873;" };
    case "locator_resolved":
      return boolField(event, "usedFallback")
        ? { label: "locator fallback", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: "&#9888;" }
        : { label: "locator", tone: "bg-slate-100 text-slate-600 ring-slate-400/25", glyph: "&#9678;" };
    case "checkpoint_passed":
      return { label: "checkpoint", tone: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", glyph: "&#10003;" };
    case "checkpoint_failed":
      return { label: "checkpoint", tone: "bg-red-50 text-red-700 ring-red-600/20", glyph: "&#10007;" };
    case "escalation_raised":
      return { label: "escalation", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: "&#9995;" };
    case "escalation_resolved":
      return { label: "escalation", tone: "bg-violet-50 text-violet-700 ring-violet-600/20", glyph: "&#9995;" };
    case "human_action":
      return { label: "human", tone: "bg-violet-50 text-violet-700 ring-violet-600/20", glyph: "&#128100;" };
    case "extracted":
      return { label: "extracted", tone: "bg-blue-50 text-blue-700 ring-blue-600/20", glyph: "&#8659;" };
    case "run_start":
      return { label: "run start", tone: "bg-slate-100 text-slate-600 ring-slate-400/25", glyph: "&#9654;" };
    case "run_end":
      return { label: "run end", tone: "bg-slate-100 text-slate-600 ring-slate-400/25", glyph: "&#9632;" };
    default:
      return { label: event.type, tone: "bg-slate-100 text-slate-600 ring-slate-400/25", glyph: "&#183;" };
  }
}

/** Plain-text one-line description of an event. Escaped by the caller. */
export function describeEvent(event: RunEvent): string {
  const parts: string[] = [];
  switch (event.type) {
    case "step_result": {
      const attempt = numberField(event, "attempt");
      parts.push(stringField(event, "stepId") ?? "step");
      if (boolField(event, "humanApproved")) parts.push("(approved by a human)");
      if (attempt !== undefined && attempt > 1) parts.push(`attempt ${attempt}`);
      if (!boolField(event, "ok")) parts.push(`failed: ${stringField(event, "error") ?? "unknown error"}`);
      break;
    }
    case "step_retry":
      parts.push(
        `${stringField(event, "stepId") ?? "step"} retrying (${stringField(event, "reason") ?? "unspecified"})`,
      );
      break;
    case "flow_restart":
      parts.push(`whole flow restarted, attempt ${numberField(event, "attempt") ?? "?"}`);
      break;
    case "known_outcome": {
      const classification = stringField(event, "classification") ?? "";
      const id = stringField(event, "outcomeId") ?? "";
      parts.push(`${id} (${classification})`);
      const action = stringField(event, "action");
      if (action) parts.push(`recovery: ${action}`);
      if (boolField(event, "exhausted")) parts.push("recovery attempts exhausted");
      break;
    }
    case "locator_resolved": {
      const index = numberField(event, "candidateIndex");
      const matches = numberField(event, "matchCount");
      parts.push(`${stringField(event, "stepId") ?? "step"} resolved via ${stringField(event, "strategy") ?? "?"}`);
      if (boolField(event, "usedFallback")) parts.push(`FELL BACK to candidate #${index ?? "?"} — the primary locator no longer matches`);
      if (matches !== undefined && matches > 1) parts.push(`${matches} elements matched (ambiguous)`);
      break;
    }
    case "checkpoint_passed":
      parts.push(stringField(event, "description") ?? "checkpoint passed");
      break;
    case "checkpoint_failed":
      parts.push(stringField(event, "description") ?? "checkpoint failed");
      if (stringField(event, "observed")) parts.push(`observed: ${stringField(event, "observed")}`);
      break;
    case "escalation_raised":
      parts.push(`${stringField(event, "kind") ?? "escalation"}: ${stringField(event, "reason") ?? ""}`);
      break;
    case "escalation_resolved":
      parts.push(
        `${stringField(event, "decision") ?? "resolved"} after ${numberField(event, "actionCount") ?? 0} human actions`,
      );
      break;
    case "human_action":
      parts.push(`${stringField(event, "actionType") ?? "action"}: ${stringField(event, "detail") ?? ""}`);
      break;
    case "extracted":
      parts.push(`${stringField(event, "outputName") ?? "output"} = ${stringField(event, "value") ?? ""}`);
      break;
    default: {
      const fields = Object.entries(event)
        .filter(([k]) => k !== "type" && k !== "timestamp" && k !== "index")
        .slice(0, 6)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
      parts.push(fields.join(" "));
    }
  }
  return parts.filter(Boolean).join(" · ");
}

function timelineRow(event: RunEvent, previousTimestamp: string | undefined): string {
  const style = styleFor(event);
  const gap = elapsed(previousTimestamp, event.timestamp);
  const fallback = event.type === "locator_resolved" && boolField(event, "usedFallback");

  return `<li data-event-index="${escapeHtml(String(event.index))}" class="flex gap-3 py-2.5${
    fallback ? " bg-amber-50/60" : ""
  }">
    <span class="w-14 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-slate-400" title="${escapeHtml(
      event.timestamp,
    )}">${escapeHtml(gap)}</span>
    <span class="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium ring-1 ring-inset ${
      style.tone
    }"><span aria-hidden="true">${style.glyph}</span>${escapeHtml(style.label)}</span>
    <span class="min-w-0 flex-1 break-words text-sm text-slate-700">${escapeHtml(describeEvent(event))}</span>
  </li>`;
}

function elapsed(previous: string | undefined, current: string): string {
  if (!previous) return "0.0s";
  const a = Date.parse(previous);
  const b = Date.parse(current);
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  return `+${duration(Math.max(0, b - a))}`;
}

function stringField(event: RunEvent, key: string): string | undefined {
  const v = event[key];
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
}

function numberField(event: RunEvent, key: string): number | undefined {
  const v = event[key];
  return typeof v === "number" ? v : undefined;
}

function boolField(event: RunEvent, key: string): boolean {
  return event[key] === true;
}

// ---------------------------------------------------------------------------
// Live screenshot
// ---------------------------------------------------------------------------

function liveScreenshot(record: RunRecord): string {
  return card(
    "Live view",
    `<img id="live-screenshot" src="/runs/${escapeUrl(record.runId)}/screenshot" alt="Live screenshot of the browser session"
       class="w-full rounded-lg border border-slate-200 bg-slate-100">
     <p class="mt-2 text-xs text-slate-400">Refreshed while the run is in flight.</p>`,
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function resultSection(record: RunRecord): string {
  const result = record.result;

  if (!result) {
    if (record.status === "crashed") {
      return card(
        "Result",
        `<p class="text-sm text-red-700">The process running this capability died before it could record a result.</p>
         ${record.error ? `<pre class="mt-2 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-xs text-slate-100">${escapeHtml(record.error)}</pre>` : ""}`,
        { tone: "danger" },
      );
    }
    if (record.discoveryOutcome) {
      return card("Discovery outcome", `<p class="text-sm text-slate-700">${escapeHtml(record.discoveryOutcome)}</p>`);
    }
    return card(
      "Result",
      `<p class="text-sm text-slate-500">${escapeHtml(
        record.status === "escalation_pending"
          ? "Suspended mid-call inside an escalation. No result exists yet — the engine is waiting on a human, not failing."
          : "In flight. A result appears here when the run finishes.",
      )}</p>`,
    );
  }

  if (result.status === "success") {
    const rows = Object.entries(result.outputs).map(([name, value]) => [
      { html: `<span class="font-mono text-slate-800">${escapeHtml(name)}</span>` },
      { html: typeBadge(typeof value === "number" ? "number" : "string") },
      { html: `<span class="font-mono text-slate-900">${escapeHtml(String(value))}</span>` },
    ]);
    const outputs = rows.length
      ? table(["Output", "Type", "Value"], rows)
      : `<p class="text-sm text-slate-500">No outputs declared for this capability.</p>`;
    const checkpoints = result.checkpointsPassed.length
      ? `<ul class="mt-3 space-y-1">${result.checkpointsPassed
          .map(
            (c) =>
              `<li class="flex gap-2 text-sm text-slate-700"><span class="text-emerald-600" aria-hidden="true">&#10003;</span>${escapeHtml(
                c,
              )}</li>`,
          )
          .join("")}</ul>`
      : "";
    return card(
      "Success",
      `${outputs}
       <div class="mt-4 border-t border-slate-100 pt-3">
         <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Checkpoints passed</h3>
         ${checkpoints || `<p class="mt-1 text-sm text-slate-400">None recorded.</p>`}
         <p class="mt-3 text-xs text-slate-400">${escapeHtml(
           `${result.stepsExecuted} steps executed.`,
         )}</p>
       </div>`,
      { tone: "ok" },
    );
  }

  if (result.status === "business_outcome") {
    // Neutral by construction. See the note in components.ts: this is the
    // answer the caller asked for, not a failure, and painting it red would
    // erase the distinction the result type exists to draw.
    return card(
      "Business outcome",
      `<div class="flex flex-wrap items-start gap-4">
        <span class="inline-flex items-center rounded-lg bg-slate-100 px-2.5 py-1 font-mono text-sm font-medium text-slate-800 ring-1 ring-inset ring-slate-300">${escapeHtml(
          result.code,
        )}</span>
        <p class="min-w-0 flex-1 text-sm text-slate-800">${escapeHtml(result.message)}</p>
      </div>
      <p class="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
        This is a legitimate, expected result — the flow ran correctly and the app answered.
        It is reported to the caller as an outcome with a code, not as an error.
        Matched known outcome ${escapeHtml(result.outcomeId)}.
      </p>`,
      { tone: "info" },
    );
  }

  const failureLinks = `<div class="mt-4 flex flex-wrap gap-3 border-t border-red-100 pt-3 text-xs">
      <a class="font-medium text-red-700 underline underline-offset-2" href="/runs/${escapeUrl(
        record.runId,
      )}/evidence/failure.png">Failure screenshot</a>
      <a class="font-medium text-red-700 underline underline-offset-2" href="/runs/${escapeUrl(
        record.runId,
      )}/evidence/failure.dom.html">DOM snapshot</a>
    </div>`;

  return card(
    "Hard failure",
    `${keyValueList([
      { label: "Step", value: { html: code(result.stepId) } },
      { label: "Step description", value: result.stepDescription },
      { label: "Reason", value: { html: `<span class="text-red-700">${escapeHtml(result.reason)}</span>` } },
      { label: "Expected", value: result.expected ?? "—" },
      { label: "Observed", value: result.observed ?? "—" },
    ])}${failureLinks}`,
    { tone: "danger" },
  );
}

// ---------------------------------------------------------------------------
// Human intervention
// ---------------------------------------------------------------------------

function humanSection(record: RunRecord): string {
  const intervention: HumanIntervention | undefined =
    record.humanIntervention ??
    (record.result && "humanIntervention" in record.result ? record.result.humanIntervention : undefined);
  if (!intervention) return "";

  const rows = intervention.actions.map((action) => {
    const blocked = isBlocked(action);
    const cellClass = blocked ? "line-through text-red-700" : "text-slate-700";
    return [
      { html: `<span class="whitespace-nowrap font-mono text-[11px] text-slate-400" title="${escapeHtml(
        action.timestamp,
      )}">${escapeHtml(timeAgo(action.timestamp))}</span>` },
      { html: `<span class="${cellClass} font-medium">${escapeHtml(action.type)}</span>` },
      {
        html: `<span class="${cellClass}">${escapeHtml(action.detail)}</span>${
          blocked
            ? ` <span class="ml-1 inline-flex items-center rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 ring-1 ring-inset ring-red-600/20">blocked by guardrails</span>`
            : ""
        }`,
      },
    ];
  });

  const body = `${keyValueList([
    { label: "Kind", value: intervention.kind },
    { label: "Decision", value: intervention.decision },
    { label: "Raised", value: intervention.raisedAt },
    { label: "Resolved", value: intervention.resolvedAt },
    { label: "Reason", value: intervention.reason },
    {
      label: "Screenshot",
      value: intervention.screenshotPath
        ? {
            html: `<a class="underline underline-offset-2" href="/runs/${escapeUrl(
              record.runId,
            )}/evidence/escalation.png">escalation.png</a>`,
          }
        : "—",
    },
  ])}
  <div class="mt-4 border-t border-slate-100 pt-3">
    <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">What the human did</h3>
    ${rows.length ? table(["When", "Action", "Detail"], rows) : emptyState("No actions were recorded.")}
  </div>`;

  return card("Human intervention", body, { tone: "warn" });
}

/**
 * `blocked` is not on `HumanAction` today; the guardrail layer is what would
 * set it. Read defensively so a blocked manual action renders correctly if and
 * when the field lands, without this package forcing a change to the escalation
 * types. See the report.
 */
function isBlocked(action: HumanAction): boolean {
  return (action as HumanAction & { blocked?: unknown }).blocked === true;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const EVIDENCE_LABELS: Record<EvidenceFile, string> = {
  jsonl: "Run log (JSONL)",
  "result.json": "Result JSON",
  "failure.png": "Failure screenshot",
  "failure.dom.html": "DOM snapshot at failure",
  "escalation.png": "Screenshot at escalation",
  "artifact.json": "Capability artifact",
  "transcript.json": "Model transcript",
  "quality.json": "Checkpoint quality report",
  "probe.jsonl": "Probe log",
};

function evidenceCard(record: RunRecord, evidence: EvidenceFile[]): string {
  const body = evidence.length
    ? `<ul class="divide-y divide-slate-100">${evidence
        .map(
          (file) => `<li class="flex items-center justify-between gap-3 py-2 text-sm">
            <a class="text-slate-700 underline underline-offset-2 hover:text-slate-900" href="/runs/${escapeUrl(
              record.runId,
            )}/evidence/${escapeUrl(file)}">${escapeHtml(EVIDENCE_LABELS[file])}</a>
            <span class="font-mono text-[11px] text-slate-400">${escapeHtml(file)}</span>
          </li>`,
        )
        .join("")}</ul>`
    : emptyState("No evidence files written for this run yet.");

  return card(
    "Evidence",
    `${body}<p class="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400">${escapeHtml(
      record.evidenceDir,
    )}</p>`,
  );
}
