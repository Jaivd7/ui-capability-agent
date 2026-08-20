import type { RunStatus } from "../types.js";
import { STATUS_LABELS } from "../types.js";
import { escapeHtml } from "./layout.js";

/**
 * The shared vocabulary of small HTML fragments. Everything here is a pure
 * function returning a string; nothing reads data or touches the filesystem.
 *
 * A note on trust: helpers that take structured input (`table`, `keyValueList`)
 * escape plain strings and accept `{ html }` for values the caller has already
 * composed from these same helpers. That makes "this text came from the target
 * app" the default and "this is markup I built" the explicit case, rather than
 * the other way round.
 */

/** A cell value: a plain string (escaped) or pre-composed markup (passed through). */
export type Cell = string | { html: string };

export function cellHtml(cell: Cell): string {
  return typeof cell === "string" ? escapeHtml(cell) : cell.html;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Colour is doing semantic work here, so it is worth being explicit about one
 * choice: `business_outcome` is NOT red.
 *
 * "No member found with that ID" is a correct, expected answer to the question
 * the caller asked — the whole point of the three-way result split is that it
 * is not an error. If the console painted it the same colour as a hard failure,
 * the most interesting design decision in the API would be invisible in the one
 * place a reviewer actually looks. It renders neutral-informational instead:
 * distinct from success (green), distinct from failure (red), distinct from
 * in-flight (blue).
 */
const STATUS_STYLES: Record<RunStatus, string> = {
  running: "bg-blue-50 text-blue-700 ring-blue-600/20",
  escalation_pending: "bg-amber-50 text-amber-800 ring-amber-600/30",
  succeeded: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  business_outcome: "bg-slate-100 text-slate-700 ring-slate-500/25",
  failed: "bg-red-50 text-red-700 ring-red-600/20",
  crashed: "bg-red-100 text-red-900 ring-red-700/30",
};

const STATUS_DOTS: Record<RunStatus, string> = {
  running: "bg-blue-500 animate-pulse",
  escalation_pending: "bg-amber-500 animate-pulse",
  succeeded: "bg-emerald-500",
  business_outcome: "bg-slate-400",
  failed: "bg-red-500",
  crashed: "bg-red-700",
};

export function statusChip(status: RunStatus, escalated?: boolean): string {
  const style = STATUS_STYLES[status];
  const dot = STATUS_DOTS[status];
  const chip = `<span class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}" data-status="${escapeHtml(
    status,
  )}"><span class="h-1.5 w-1.5 rounded-full ${dot}" aria-hidden="true"></span>${escapeHtml(
    STATUS_LABELS[status],
  )}</span>`;
  return escalated ? `${chip} ${escalatedBadge()}` : chip;
}

export function escalatedBadge(): string {
  return `<span class="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-inset ring-violet-600/20" title="A human took control at some point during this run">&#9995; Human</span>`;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/** The declared type of an input param or output field, e.g. `currency`. */
export function typeBadge(type: string): string {
  return `<span class="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">${escapeHtml(
    type,
  )}</span>`;
}

/** `name: type` chip, for rendering a call contract compactly. */
export function typedFieldChip(name: string, type: string, opts?: { sensitive?: boolean }): string {
  const lock = opts?.sensitive
    ? `<span class="ml-1 text-amber-600" title="sensitive; redacted in logs and evidence" aria-label="sensitive">&#128274;</span>`
    : "";
  return `<span class="inline-flex items-center rounded-md bg-white px-2 py-1 text-xs ring-1 ring-inset ring-slate-200"><span class="font-mono font-medium text-slate-800">${escapeHtml(
    name,
  )}</span><span class="text-slate-400">:&nbsp;</span><span class="font-mono text-slate-500">${escapeHtml(
    type,
  )}</span>${lock}</span>`;
}

export function roleBadge(role: string | null | undefined): string {
  if (!role) {
    return `<span class="inline-flex items-center rounded-full bg-slate-50 px-2 py-0.5 text-xs text-slate-500 ring-1 ring-inset ring-slate-200">any role</span>`;
  }
  return `<span class="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20" title="required role">&#128100; ${escapeHtml(
    role,
  )}</span>`;
}

export function appBadge(app: string, displayName?: string): string {
  return `<span class="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300/60" title="${escapeHtml(
    app,
  )}">${escapeHtml(displayName ?? app)}</span>`;
}

/**
 * Marks a capability whose replay contains a state-mutating step that can't be
 * trivially undone. Amber rather than red: it isn't broken, it's consequential
 * — the run may stop and ask a human before it executes.
 */
export function irreversibleBadge(irreversible = true): string {
  if (!irreversible) return "";
  return `<span class="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/30" title="Contains an irreversible step: guardrails may pause this run for human confirmation">&#9888; Irreversible</span>`;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function card(title: string, body: string, opts?: { actions?: string; tone?: "default" | "info" | "warn" | "danger" | "ok" }): string {
  const tone = opts?.tone ?? "default";
  const ring: Record<string, string> = {
    default: "ring-slate-200",
    info: "ring-slate-300",
    warn: "ring-amber-300",
    danger: "ring-red-300",
    ok: "ring-emerald-300",
  };
  const header = title
    ? `<div class="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-3">
        <h2 class="text-sm font-semibold text-slate-900">${escapeHtml(title)}</h2>
        ${opts?.actions ?? ""}
      </div>`
    : "";
  return `<section class="rounded-xl bg-white shadow-sm ring-1 ring-inset ${
    ring[tone] ?? ring["default"]
  }">${header}<div class="px-5 py-4">${body}</div></section>`;
}

export function table(headers: string[], rows: Cell[][]): string {
  if (rows.length === 0) return emptyState("Nothing to show yet.");
  const head = headers
    .map(
      (h) =>
        `<th scope="col" class="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">${escapeHtml(
          h,
        )}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr class="hover:bg-slate-50/70">${row
          .map((cell) => `<td class="px-3 py-2.5 align-top text-sm text-slate-700">${cellHtml(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="overflow-x-auto"><table class="min-w-full divide-y divide-slate-200"><thead class="bg-slate-50/80"><tr>${head}</tr></thead><tbody class="divide-y divide-slate-100">${body}</tbody></table></div>`;
}

export function emptyState(message: string): string {
  return `<div class="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-5 py-8 text-center text-sm text-slate-500">${escapeHtml(
    message,
  )}</div>`;
}

export interface KeyValuePair {
  label: string;
  value: Cell;
}

export function keyValueList(pairs: KeyValuePair[]): string {
  if (pairs.length === 0) return emptyState("No fields.");
  return `<dl class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">${pairs
    .map(
      (p) =>
        `<div class="min-w-0"><dt class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">${escapeHtml(
          p.label,
        )}</dt><dd class="mt-0.5 break-words text-sm text-slate-800">${cellHtml(p.value)}</dd></div>`,
    )
    .join("")}</dl>`;
}

// ---------------------------------------------------------------------------
// Formatting (plain text out; call sites still escape)
// ---------------------------------------------------------------------------

/** Coarse relative time. Returns the input verbatim if it isn't a parseable date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const deltaMs = now - t;
  const future = deltaMs < 0;
  const s = Math.round(Math.abs(deltaMs) / 1000);
  const phrase =
    s < 5 ? "just now"
    : s < 60 ? `${s}s`
    : s < 3600 ? `${Math.floor(s / 60)}m`
    : s < 86400 ? `${Math.floor(s / 3600)}h`
    : `${Math.floor(s / 86400)}d`;
  if (phrase === "just now") return phrase;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/** `1.4s`, `2m 05s`, `840ms`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** An absolute timestamp with a relative tooltip, as a table cell. */
export function timestampCell(iso: string | undefined): string {
  if (!iso) return `<span class="text-slate-400">—</span>`;
  return `<span title="${escapeHtml(iso)}" class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(
    timeAgo(iso),
  )}</span>`;
}

export function durationCell(ms: number | undefined): string {
  if (ms === undefined) return `<span class="text-slate-400">—</span>`;
  return `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(duration(ms))}</span>`;
}

/** Monospaced inline code. */
export function code(text: string): string {
  return `<code class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] text-slate-700">${escapeHtml(
    text,
  )}</code>`;
}

/** First 12 chars of a content hash — enough to eyeball drift, short enough to read. */
export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}
