import type { HumanAction, HumanIntervention } from "../../../escalation/types.js";
import type { EvidenceFile, RunEvent, RunRecord } from "../../types.js";
import { isTerminalStatus } from "../../types.js";
import { escapeHtml, escapeUrl } from "../layout.js";
import { icon } from "../icons.js";
import { TYPE } from "../theme.js";
import { describeTable, parseDelimitedTable, type DelimitedTable } from "../tabular.js";
import {
  appBadge,
  card,
  cheatSheet,
  code,
  duration,
  emptyState,
  escalatedBadge,
  infoNote,
  keyValueList,
  roleBadge,
  statusChip,
  table,
  timeAgo,
  typeBadge,
  type CheatSheetData,
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
  /** Known-good sign-on and member values for this run's target app. */
  demo?: CheatSheetData;
}

export function runDetailPage(record: RunRecord, events: RunEvent[], opts: RunDetailOptions): string {
  const terminal = isTerminalStatus(record.status);
  const live = opts.live && !terminal;

  return `${header(record)}
  ${escalationBanner(record)}
  ${live ? liveScreenshot(record) : ""}
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
    <div class="space-y-6 lg:col-span-2">
      ${resultSection(record)}
      ${card(
        "Timeline",
        timeline(events, live),
        { actions: `<span class="${TYPE.meta}">${escapeHtml(String(events.length))} events</span>` },
      )}
      ${humanSection(record)}
    </div>
    <div class="space-y-6">
      ${inputsCard(record)}
      ${/* Bare, not in a card: the disclosure carries its own header. */ ""}
      ${opts.demo ? cheatSheet(opts.demo, { compact: true }) : ""}
      ${evidenceCard(record, opts.evidence)}
    </div>
  </div>
  ${escalationOverlay(record)}`;
}

/**
 * The operator console, over the run page rather than in a tab of its own.
 *
 * The console is already a complete document served at
 * `/runs/:runId/escalation`, and `console-view.ts` builds every one of its form
 * actions from `basePath` rather than from an absolute literal — which is
 * exactly what makes it work unmodified in a frame. So this embeds it instead
 * of reimplementing it: the policy in `action-policy.ts` stays enforced in one
 * place, and the standalone console a CLI escalation opens is byte-for-byte the
 * same surface.
 *
 * `<dialog open>` is rendered by the server whenever the run is paused. There
 * is no script here at all — the existing poll already reloads this page when
 * the status changes, so the overlay appears on the reload that reports the
 * pause and is gone on the reload that reports its resolution. The "Take
 * control" link in the banner underneath stays as the route for anyone with
 * JavaScript off or a browser without `<dialog>`.
 */
function escalationOverlay(record: RunRecord): string {
  if (record.status !== "escalation_pending" || !record.escalationPending) return "";
  const src = `/runs/${escapeUrl(record.runId)}/escalation`;
  return `<dialog open aria-label="Operator console"
    class="fixed inset-0 z-30 m-0 h-full max-h-full w-full max-w-full bg-ink/40 p-4 backdrop:bg-transparent sm:p-8">
    <div class="mx-auto flex h-full max-w-4xl flex-col overflow-hidden rounded-lg border border-amber-300 bg-surface">
      <div class="flex shrink-0 items-center gap-3 border-b border-rule bg-amber-50 px-5 py-3">
        <span class="text-amber-700">${icon("hand", { class: "h-4 w-4" })}</span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-amber-900">This run is paused and waiting for you</p>
          <p class="truncate text-xs text-amber-800">${escapeHtml(record.escalationPending.reason)}</p>
        </div>
        <a href="${src}" target="_blank" rel="noreferrer noopener"
           class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-400 bg-surface px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100">
          ${icon("externalLink", { class: "h-3.5 w-3.5" })} Open in a tab
        </a>
      </div>
      <iframe src="${src}" title="Operator console" class="min-h-0 flex-1 w-full border-0 bg-surface"></iframe>
    </div>
  </dialog>`;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function header(record: RunRecord): string {
  const title = record.kind === "discovery" ? `Discovery: ${record.capabilityId}` : record.capabilityId;
  return `<div class="mb-6">
    <a href="/runs" class="text-xs text-stone-500 hover:text-stone-800">&larr; Runs</a>
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <h1 class="${TYPE.pageTitle}">${escapeHtml(title)}</h1>
      ${
        record.capabilityVersion !== undefined
          ? `<span class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-500">v${escapeHtml(
              String(record.capabilityVersion),
            )}</span>`
          : ""
      }
      ${appBadge(record.app)}
      ${roleBadge(record.role)}
      <span data-run-status>${statusChip(record.status)}</span>
      ${record.escalated ? escalatedBadge() : ""}
    </div>
    <p class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-500">
      <span class="font-mono text-stone-400">${escapeHtml(record.runId)}</span>
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
        ? `<p class="mt-2 text-sm text-stone-600">Currently: ${escapeHtml(
            record.progress.currentStepDescription,
          )}</p>`
        : ""
    }
  </div>`;
}

/**
 * Only while someone is actually waiting.
 *
 * `escalationPending` is deliberately never cleared — it is the record of what
 * was asked for, and the run detail page's "Human intervention" card reports
 * what came of it. But `status` is the authority on whether anyone is still
 * waiting, and rendering a "this run is paused and waiting for you" call to
 * action against a run that finished ten minutes ago invites an operator to
 * take control of a session that no longer exists.
 */
function escalationBanner(record: RunRecord): string {
  const esc = record.escalationPending;
  if (!esc || record.status !== "escalation_pending") return "";
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
          value: { html: `<span class="font-mono text-stone-800">${escapeHtml(formatValue(value))}</span>` },
        })),
      )
    : `<p class="text-sm text-stone-400">No parameters.</p>`;

  const query = entries
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const reinvoke = `/capabilities/${escapeUrl(record.capabilityId)}/invoke${query ? `?${escapeHtml(query)}` : ""}`;

  return card("Inputs as submitted", body, {
    actions: `<a href="${reinvoke}" class="text-xs font-medium text-stone-600 underline underline-offset-2 hover:text-stone-900">Re-invoke with these</a>`,
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

/**
 * A rail with a node per event, rather than a list of log lines.
 *
 * The rail is a border on the `<ol>` and each node is absolutely positioned on
 * it, which matters for more than looks: the poll script appends live rows to
 * this same `<ol>`, so the geometry has to come from the container rather than
 * from anything the server renders per row. A live row lands on the rail
 * without the client needing to know how the rail is drawn.
 */
function timeline(events: RunEvent[], live: boolean): string {
  const rows = events.map((event, i) => {
    const prev = i > 0 ? events[i - 1] : undefined;
    return timelineRow(event, prev?.timestamp);
  });

  const RAIL = "relative ml-2 border-l border-rule";
  const list = rows.length
    ? `<ol id="timeline" class="${RAIL}">${rows.join("")}</ol>`
    : `<ol id="timeline" class="${RAIL}"></ol>${emptyState("No events logged yet.")}`;

  const footer = live
    ? `<p id="timeline-live" class="mt-3 flex items-center gap-2 border-t border-rule pt-3 ${TYPE.meta}">
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
        ? { label: "step", tone: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", glyph: icon("check", { class: "h-3 w-3" }) }
        : { label: "step", tone: "bg-red-50 text-red-700 ring-red-600/20", glyph: icon("x", { class: "h-3 w-3" }) };
    case "step_retry":
      return { label: "retry", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: icon("retry", { class: "h-3 w-3" }) };
    case "flow_restart":
      return { label: "flow restart", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: icon("restart", { class: "h-3 w-3" }) };
    case "known_outcome":
      return { label: "known outcome", tone: "bg-stone-100 text-stone-700 ring-stone-500/25", glyph: icon("flag", { class: "h-3 w-3" }) };
    case "locator_resolved":
      return boolField(event, "usedFallback")
        ? { label: "locator fallback", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: icon("warning", { class: "h-3 w-3" }) }
        : { label: "locator", tone: "bg-stone-100 text-stone-600 ring-stone-400/25", glyph: icon("target", { class: "h-3 w-3" }) };
    case "checkpoint_passed":
      return { label: "checkpoint", tone: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", glyph: icon("check", { class: "h-3 w-3" }) };
    case "checkpoint_failed":
      return { label: "checkpoint", tone: "bg-red-50 text-red-700 ring-red-600/20", glyph: icon("x", { class: "h-3 w-3" }) };
    case "escalation_raised":
      return { label: "escalation", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: icon("hand", { class: "h-3 w-3" }) };
    case "escalation_resolved":
      return { label: "escalation", tone: "bg-violet-50 text-violet-700 ring-violet-600/20", glyph: icon("hand", { class: "h-3 w-3" }) };
    case "human_action":
      return { label: "human", tone: "bg-violet-50 text-violet-700 ring-violet-600/20", glyph: icon("user", { class: "h-3 w-3" }) };
    case "extracted":
      return { label: "extracted", tone: "bg-blue-50 text-blue-700 ring-blue-600/20", glyph: icon("download", { class: "h-3 w-3" }) };
    // Discovery's vocabulary. The model's turn is styled to stand out from
    // everything else on the page, because on a discovery run it *is* the page:
    // watching the reasoning arrive is the point of the tab.
    case "model_decision":
      return { label: "model", tone: "bg-indigo-50 text-indigo-700 ring-indigo-600/25", glyph: icon("model", { class: "h-3 w-3" }) };
    case "model_no_tool_call":
      return { label: "model", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: icon("model", { class: "h-3 w-3" }) };
    case "action_result":
      return boolField(event, "ok")
        ? { label: "acted", tone: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", glyph: icon("check", { class: "h-3 w-3" }) }
        : { label: "acted", tone: "bg-red-50 text-red-700 ring-red-600/20", glyph: icon("x", { class: "h-3 w-3" }) };
    case "observation":
      return { label: "observed", tone: "bg-stone-100 text-stone-600 ring-stone-400/25", glyph: icon("eye", { class: "h-3 w-3" }) };
    case "checkpoint_rejected":
      return { label: "refused", tone: "bg-amber-50 text-amber-800 ring-amber-600/30", glyph: icon("warning", { class: "h-3 w-3" }) };
    case "guardrail_blocked":
      return { label: "guardrail", tone: "bg-red-50 text-red-700 ring-red-600/20", glyph: icon("ban", { class: "h-3 w-3" }) };
    case "recording_score":
      return { label: "scored", tone: "bg-violet-50 text-violet-700 ring-violet-600/20", glyph: icon("star", { class: "h-3 w-3" }) };
    case "run_start":
      return { label: "run start", tone: "bg-stone-100 text-stone-600 ring-stone-400/25", glyph: icon("play", { class: "h-3 w-3" }) };
    case "run_end":
      return { label: "run end", tone: "bg-stone-100 text-stone-600 ring-stone-400/25", glyph: icon("stop", { class: "h-3 w-3" }) };
    default:
      return { label: event.type, tone: "bg-stone-100 text-stone-600 ring-stone-400/25", glyph: icon("dot", { class: "h-3 w-3" }) };
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
    case "model_decision": {
      // Ordered for someone watching this arrive live: the verb, then the
      // model's own description of what it is doing, then how it chose to
      // find the element, then why. The raw locator chain is JSON and would
      // otherwise be the only thing that fits on the line.
      const input = isRecord(event["input"]) ? event["input"] : {};
      parts.push(stringField(event, "tool") ?? "?");
      if (typeof input["description"] === "string") parts.push(input["description"]);
      const locator = summarizeLocator(input["locator"]);
      if (locator) parts.push(locator);
      const rest = summarizeInput(input, ["description", "locator"]);
      if (rest) parts.push(rest);
      const reasoning = stringField(event, "reasoning");
      if (reasoning) parts.push(`"${reasoning}"`);
      break;
    }
    case "model_no_tool_call":
      parts.push(`turn produced no tool call: ${stringField(event, "text") ?? "(no text)"}`);
      break;
    case "action_result":
      parts.push(stringField(event, "tool") ?? "action");
      if (!boolField(event, "ok")) parts.push(`failed: ${stringField(event, "detail") ?? "unknown"}`);
      else if (stringField(event, "detail")) parts.push(stringField(event, "detail")!);
      break;
    case "observation":
      parts.push(stringField(event, "url") ?? "");
      break;
    case "checkpoint_rejected":
      parts.push(`checkpoint refused at record time: ${stringField(event, "reason") ?? ""}`);
      break;
    case "guardrail_blocked":
      parts.push(`${stringField(event, "tool") ?? "action"} blocked: ${stringField(event, "reason") ?? ""}`);
      break;
    case "recording_score":
      parts.push(
        `grade ${stringField(event, "grade") ?? "?"} (${stringField(event, "score") ?? "?"}) — ${
          stringField(event, "errors") ?? 0
        } error(s), ${stringField(event, "warnings") ?? 0} warning(s)`,
      );
      break;
    default: {
      const fields = Object.entries(event)
        .filter(([k]) => k !== "type" && k !== "timestamp" && k !== "index")
        .slice(0, 6)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
      parts.push(fields.join(" "));
    }
  }
  // Collapsed to one line: several events quote multi-line text back at us —
  // a zod validation error, a scraped page fragment — and a timeline row is a
  // single line by construction. The full text is always in the JSONL.
  return parts.filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
}

/** The rail node's colour, read off the chip tone so the two can't drift apart. */
function dotFor(tone: string): string {
  if (tone.includes("emerald")) return "bg-emerald-500";
  if (tone.includes("red")) return "bg-red-500";
  if (tone.includes("amber")) return "bg-amber-500";
  if (tone.includes("indigo")) return "bg-indigo-500";
  if (tone.includes("violet")) return "bg-violet-500";
  if (tone.includes("blue")) return "bg-blue-500";
  return "bg-stone-300";
}

function timelineRow(event: RunEvent, previousTimestamp: string | undefined): string {
  const style = styleFor(event);
  const gap = elapsed(previousTimestamp, event.timestamp);
  const fallback = event.type === "locator_resolved" && boolField(event, "usedFallback");

  return `<li data-event-index="${escapeHtml(String(event.index))}" class="relative flex gap-3 py-2.5 pl-5${
    fallback ? " bg-amber-50/60" : ""
  }">
    <span class="absolute -left-[4.5px] top-4 h-2 w-2 rounded-full ring-2 ring-surface ${dotFor(
      style.tone,
    )}" aria-hidden="true"></span>
    <span class="w-12 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-stone-400" title="${escapeHtml(
      event.timestamp,
    )}">${escapeHtml(gap)}</span>
    <span class="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium ring-1 ring-inset ${
      style.tone
    }">${style.glyph}${escapeHtml(style.label)}</span>
    <span class="min-w-0 flex-1 break-words">${renderEvent(event)}</span>
  </li>`;
}

/**
 * The structured counterpart to `describeEvent`.
 *
 * `describeEvent` joins everything it knows with " · " and collapses the result
 * to a single line — a CLI log line, which is what it was written to be, and
 * which is what the timeline had been printing into HTML. For a model turn that
 * meant the tool it called, its own description of the action, the locator it
 * chose and its stated reasoning all arriving as one undifferentiated run of
 * grey 14px text, with the reasoning — the whole reason to watch a discovery
 * run — indistinguishable from the machinery around it.
 *
 * So the interesting event types get real markup here and everything else falls
 * through unchanged. `describeEvent` keeps its exact signature and output: it is
 * exported, it is asserted on, and the poll script's client-side twin of it has
 * to agree with it.
 */
function renderEvent(event: RunEvent): string {
  const plain = (text: string) => `<span class="text-sm text-stone-700">${escapeHtml(text)}</span>`;

  switch (event.type) {
    case "model_decision": {
      const input = isRecord(event["input"]) ? event["input"] : {};
      const tool = stringField(event, "tool") ?? "?";
      const description = typeof input["description"] === "string" ? input["description"] : "";
      const detail = [summarizeLocator(input["locator"]), summarizeInput(input, ["description", "locator"])]
        .filter(Boolean)
        .join(" · ");
      const reasoning = stringField(event, "reasoning");
      return `<div class="space-y-1">
        <p class="text-sm text-stone-800">
          <span class="mr-1.5 rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-indigo-700">${escapeHtml(
            tool,
          )}</span>${escapeHtml(description)}
        </p>
        ${detail ? `<p class="font-mono text-[11px] text-stone-500">${escapeHtml(detail)}</p>` : ""}
        ${
          reasoning
            ? `<p class="border-l-2 border-indigo-200 pl-2.5 text-[13px] italic leading-snug text-stone-600">${escapeHtml(
                reasoning,
              )}</p>`
            : ""
        }
      </div>`;
    }

    case "extracted":
      return `<p class="text-sm">
        <span class="font-mono text-stone-600">${escapeHtml(stringField(event, "outputName") ?? "output")}</span>
        <span class="mx-1 text-stone-400">=</span>
        <span class="font-mono font-medium text-ink">${escapeHtml(stringField(event, "value") ?? "")}</span>
      </p>`;

    case "step_result": {
      if (boolField(event, "ok")) return plain(describeEvent(event));
      const stepId = stringField(event, "stepId") ?? "step";
      const error = stringField(event, "error") ?? "unknown error";
      return `<div class="space-y-1">
        <p class="text-sm text-stone-800"><span class="font-mono text-stone-600">${escapeHtml(stepId)}</span> failed</p>
        <p class="rounded border border-red-200 bg-red-50 px-2 py-1 font-mono text-[11px] leading-snug text-red-800">${escapeHtml(
          error,
        )}</p>
      </div>`;
    }

    case "recording_score": {
      const grade = stringField(event, "grade") ?? "?";
      const tone =
        grade.startsWith("A") ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20"
        : grade.startsWith("B") ? "bg-blue-50 text-blue-800 ring-blue-600/20"
        : "bg-amber-50 text-amber-900 ring-amber-600/30";
      return `<p class="flex flex-wrap items-center gap-2 text-sm text-stone-700">
        <span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${tone}">grade ${escapeHtml(
          grade,
        )}</span>
        <span class="${TYPE.meta}">score ${escapeHtml(stringField(event, "score") ?? "?")} &middot; ${escapeHtml(
          String(stringField(event, "errors") ?? 0),
        )} error(s), ${escapeHtml(String(stringField(event, "warnings") ?? 0))} warning(s)</span>
      </p>`;
    }

    default:
      return plain(describeEvent(event));
  }
}

function elapsed(previous: string | undefined, current: string): string {
  if (!previous) return "0.0s";
  const a = Date.parse(previous);
  const b = Date.parse(current);
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  return `+${duration(Math.max(0, b - a))}`;
}

/** A tool call's remaining arguments on one line, long values clipped. */
function summarizeInput(input: Record<string, unknown>, omit: string[] = []): string {
  return Object.entries(input)
    .filter(([k]) => !omit.includes(k))
    .map(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${text && text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
    })
    .join(", ");
}

/**
 * The chosen locator in the same shorthand `describeCandidate` uses, and only
 * the primary candidate: the ordered chain is the artifact's business, and on
 * a timeline it is forty characters of JSON where the interesting fact is
 * "it went for the accessible name".
 */
function summarizeLocator(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  if (!isRecord(first)) return undefined;
  const str = (k: string): string => (typeof first[k] === "string" ? (first[k] as string) : "");
  const suffix = value.length > 1 ? ` +${value.length - 1} fallback` : "";
  switch (first["strategy"]) {
    case "role":
      return `role(${str("role")}${str("name") ? `, "${str("name")}"` : ""})${suffix}`;
    case "css":
      return `css("${str("selector")}")${suffix}`;
    case "xpath":
      return `xpath("${str("expression")}")${suffix}`;
    case "testId":
      return `testId("${str("testId")}")${suffix}`;
    default:
      return str("text") ? `${String(first["strategy"])}("${str("text")}")${suffix}` : undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * Full content width, above the two-column grid.
 *
 * It used to sit in the right-hand sidebar, which is a third of the page: a
 * 1280px-wide capture rendered at ~300px, where the point of it is reading a
 * banking screen someone is watching over your shoulder. The page is a
 * six-column max width, so out here it renders close to native size.
 */
function liveScreenshot(record: RunRecord): string {
  return card(
    "Live view",
    `<a href="/runs/${escapeUrl(record.runId)}/screenshot" target="_blank" rel="noreferrer noopener"
        title="Open this frame full size in a new tab">
       <img id="live-screenshot" src="/runs/${escapeUrl(record.runId)}/screenshot"
         alt="Live screenshot of the browser session"
         class="w-full rounded-lg border border-rule bg-stone-100">
     </a>`,
    {
      actions: `<span class="flex items-center gap-1.5 ${TYPE.meta}">Click to open a frame full size ${infoNote(
        "The browser this run is driving, refreshed while it is in flight.",
      )}</span>`,
    },
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
         ${record.error ? `<pre class="mt-2 overflow-x-auto rounded-lg bg-stone-900 px-3 py-2 text-xs text-stone-100">${escapeHtml(record.error)}</pre>` : ""}`,
        { tone: "danger" },
      );
    }
    if (record.discoveryOutcome) {
      return card("Discovery outcome", `<p class="text-sm text-stone-700">${escapeHtml(record.discoveryOutcome)}</p>`);
    }
    return card(
      "Result",
      `<p class="text-sm text-stone-500">${escapeHtml(
        record.status === "escalation_pending"
          ? "Suspended mid-call inside an escalation. No result exists yet — the engine is waiting on a human, not failing."
          : "In flight. A result appears here when the run finishes.",
      )}</p>`,
    );
  }

  if (result.status === "success") {
    // An output that is a whole table arrives as one tab/newline-delimited
    // string (see views/tabular.ts). Rendering it in the Value cell is what
    // produced a single unreadable line, so a tabular value is summarised here
    // and drawn as a real table underneath, where it has the width to be read.
    const tabular: Array<{ name: string; parsed: DelimitedTable; raw: string }> = [];
    const rows = Object.entries(result.outputs).map(([name, value]) => {
      const parsed = parseDelimitedTable(value);
      if (parsed) tabular.push({ name, parsed, raw: String(value) });
      return [
        { html: `<span class="font-mono text-stone-800">${escapeHtml(name)}</span>` },
        { html: typeBadge(typeof value === "number" ? "number" : "string") },
        {
          html: parsed
            ? `<span class="text-stone-500">${escapeHtml(describeTable(parsed))}</span>`
            : `<span class="font-mono text-stone-900">${escapeHtml(String(value))}</span>`,
        },
      ];
    });
    const outputs = rows.length
      ? table(["Output", "Type", "Value"], rows) + tabular.map(tabularOutput).join("")
      : `<p class="text-sm text-stone-500">No outputs declared for this capability.</p>`;
    const checkpoints = result.checkpointsPassed.length
      ? `<ul class="mt-3 space-y-1">${result.checkpointsPassed
          .map(
            (c) =>
              `<li class="flex gap-2 text-sm text-stone-700"><span class="text-emerald-600" aria-hidden="true">&#10003;</span>${escapeHtml(
                c,
              )}</li>`,
          )
          .join("")}</ul>`
      : "";
    return card(
      "Success",
      `${outputs}
       <div class="mt-4 border-t border-stone-100 pt-3">
         <h3 class="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Checkpoints passed</h3>
         ${checkpoints || `<p class="mt-1 text-sm text-stone-400">None recorded.</p>`}
         <p class="mt-3 text-xs text-stone-400">${escapeHtml(
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
        <span class="inline-flex items-center rounded-lg bg-stone-100 px-2.5 py-1 font-mono text-sm font-medium text-stone-800 ring-1 ring-inset ring-stone-300">${escapeHtml(
          result.code,
        )}</span>
        <p class="min-w-0 flex-1 text-sm text-stone-800">${escapeHtml(result.message)}</p>
        ${infoNote(
          "A legitimate, expected result — the flow ran correctly and the app answered. It is reported to the caller as an outcome with a code, not as an error.",
        )}
      </div>
      <p class="mt-3 border-t border-rule pt-3 ${TYPE.meta}">Matched known outcome ${escapeHtml(
        result.outcomeId,
      )}.</p>`,
      { tone: "info" },
    );
  }

  const failureLinks = `<div class="mt-4 flex flex-wrap gap-3 border-t border-red-100 pt-3 text-xs">
      <a class="font-medium text-red-700 underline underline-offset-2" href="/api/runs/${escapeUrl(
        record.runId,
      )}/evidence/failure.png">Failure screenshot</a>
      <a class="font-medium text-red-700 underline underline-offset-2" href="/api/runs/${escapeUrl(
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

/**
 * One table-valued output, drawn full width under the outputs list.
 *
 * The raw string stays reachable in a disclosure rather than being replaced.
 * What the capability actually returned is the evidence — the table is a
 * reading of it — and a reviewer checking a balance against a screenshot needs
 * the bytes, not this function's interpretation of them.
 */
function tabularOutput(entry: { name: string; parsed: DelimitedTable; raw: string }): string {
  return `<div class="mt-4 border-t border-stone-100 pt-3">
    <h3 class="${TYPE.label}">${escapeHtml(entry.name)}</h3>
    <div class="mt-2">${table(entry.parsed.header, entry.parsed.rows.map((r) => r.map((c) => c)))}</div>
    <details class="mt-2">
      <summary class="cursor-pointer text-xs text-muted">Raw extracted value</summary>
      <pre class="mt-2 overflow-x-auto rounded-lg bg-stone-900 px-3 py-2 text-xs text-stone-100">${escapeHtml(
        entry.raw,
      )}</pre>
    </details>
  </div>`;
}

function humanSection(record: RunRecord): string {
  const intervention: HumanIntervention | undefined =
    record.humanIntervention ??
    (record.result && "humanIntervention" in record.result ? record.result.humanIntervention : undefined);
  if (!intervention) return "";

  const rows = intervention.actions.map((action) => {
    const blocked = isBlocked(action);
    const cellClass = blocked ? "line-through text-red-700" : "text-stone-700";
    return [
      { html: `<span class="whitespace-nowrap font-mono text-[11px] text-stone-400" title="${escapeHtml(
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
            html: `<a class="underline underline-offset-2" href="/api/runs/${escapeUrl(
              record.runId,
            )}/evidence/escalation.png">escalation.png</a>`,
          }
        : "—",
    },
  ])}
  <div class="mt-4 border-t border-stone-100 pt-3">
    <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-500">What the human did</h3>
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

/**
 * Evidence is served by the API route, and these link straight at it.
 *
 * There is one reader of the evidence tree and it already gets the details
 * right: a fixed filename set rather than a path parameter, a DOM snapshot
 * served as text so it cannot execute in the dashboard's origin. A second
 * copy on the UI router would be a second place for those to drift. These
 * links pointed at a `/runs/:runId/evidence/:file` page that was never
 * implemented, so every one of them 404'd.
 */
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
    ? `<ul class="divide-y divide-stone-100">${evidence
        .map(
          (file) => `<li class="flex items-center justify-between gap-3 py-2 text-sm">
            <a class="text-stone-700 underline underline-offset-2 hover:text-stone-900" href="/api/runs/${escapeUrl(
              record.runId,
            )}/evidence/${escapeUrl(file)}">${escapeHtml(EVIDENCE_LABELS[file])}</a>
            <span class="font-mono text-[11px] text-stone-400">${escapeHtml(file)}</span>
          </li>`,
        )
        .join("")}</ul>`
    : emptyState("No evidence files written for this run yet.");

  return card(
    "Evidence",
    `${body}<p class="mt-3 border-t border-stone-100 pt-3 text-xs text-stone-400">${escapeHtml(
      record.evidenceDir,
    )}</p>`,
  );
}
