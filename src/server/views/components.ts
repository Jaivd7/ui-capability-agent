import type { RunStatus } from "../types.js";
import { STATUS_LABELS } from "../types.js";
import { escapeHtml } from "./layout.js";
import { icon } from "./icons.js";
import { SURFACE, TYPE } from "./theme.js";

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
 *
 * The tints are pitched against warm paper rather than the cool grey these were
 * originally picked on, and the neutral is `stone` so a business outcome reads
 * as a deliberate member of the palette instead of the one leftover grey.
 */
const STATUS_STYLES: Record<RunStatus, string> = {
  running: "bg-blue-50 text-blue-800 ring-blue-600/20",
  escalation_pending: "bg-amber-50 text-amber-900 ring-amber-600/30",
  succeeded: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
  business_outcome: "bg-stone-100 text-stone-700 ring-stone-500/25",
  failed: "bg-red-50 text-red-800 ring-red-600/20",
  crashed: "bg-red-100 text-red-900 ring-red-700/30",
};

const STATUS_DOTS: Record<RunStatus, string> = {
  running: "bg-blue-500 animate-pulse",
  escalation_pending: "bg-amber-500 animate-pulse",
  succeeded: "bg-emerald-600",
  business_outcome: "bg-stone-400",
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
  return `<span class="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-inset ring-violet-600/20" title="A human took control at some point during this run">${icon(
    "hand",
    { class: "h-3 w-3" },
  )} Human</span>`;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/** The declared type of an input param or output field, e.g. `currency`. */
export function typeBadge(type: string): string {
  return `<span class="inline-flex items-center rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-stone-600 ring-1 ring-inset ring-stone-200">${escapeHtml(
    type,
  )}</span>`;
}

/** `name: type` chip, for rendering a call contract compactly. */
export function typedFieldChip(name: string, type: string, opts?: { sensitive?: boolean }): string {
  const lock = opts?.sensitive
    ? `<span class="ml-1 text-amber-600" title="sensitive; redacted in logs and evidence">${icon("lock", {
        class: "h-3 w-3",
        label: "sensitive",
      })}</span>`
    : "";
  return `<span class="inline-flex items-center rounded-md bg-surface px-2 py-1 text-xs ring-1 ring-inset ring-rule"><span class="font-mono font-medium text-ink">${escapeHtml(
    name,
  )}</span><span class="text-stone-400">:&nbsp;</span><span class="font-mono text-muted">${escapeHtml(
    type,
  )}</span>${lock}</span>`;
}

export function roleBadge(role: string | null | undefined): string {
  if (!role) {
    return `<span class="inline-flex items-center rounded-full bg-stone-50 px-2 py-0.5 text-xs text-muted ring-1 ring-inset ring-rule">any role</span>`;
  }
  return `<span class="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20" title="required role">${icon(
    "user",
    { class: "h-3 w-3" },
  )} ${escapeHtml(role)}</span>`;
}

export function appBadge(app: string, displayName?: string): string {
  return `<span class="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700 ring-1 ring-inset ring-stone-300/60" title="${escapeHtml(
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
  return `<span class="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/30" title="Contains an irreversible step: guardrails may pause this run for human confirmation">${icon(
    "warning",
    { class: "h-3 w-3" },
  )} Irreversible</span>`;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/**
 * Hairline borders rather than drop shadows.
 *
 * A shadow says "this panel floats above the page", which is a claim about
 * depth that a console made of records and logs has no reason to make. A rule
 * says "this is a bounded region of the same sheet", which is what a card here
 * actually is — and it is what financial print has always done.
 */
export function card(
  title: string,
  body: string,
  opts?: {
    actions?: string;
    tone?: "default" | "info" | "warn" | "danger" | "ok";
    /** Raises one card above its siblings. Use at most once per page. */
    emphasis?: boolean;
  },
): string {
  const tone = opts?.tone ?? "default";
  const border: Record<string, string> = {
    default: "border-rule",
    info: "border-stone-300",
    warn: "border-amber-300",
    danger: "border-red-300",
    ok: "border-emerald-300",
  };
  const shell = opts?.emphasis ? SURFACE.cardEmphasis : `rounded-lg border bg-surface ${border[tone] ?? border["default"]}`;
  const header = title
    ? `<div class="flex items-center justify-between gap-4 border-b border-rule px-5 py-3">
        <h2 class="${TYPE.sectionTitle}">${escapeHtml(title)}</h2>
        ${opts?.actions ?? ""}
      </div>`
    : "";
  return `<section class="${shell}">${header}<div class="px-5 py-4">${body}</div></section>`;
}

export function table(headers: string[], rows: Cell[][]): string {
  if (rows.length === 0) return emptyState("Nothing to show yet.");
  const head = headers
    .map((h) => `<th scope="col" class="px-3 py-2.5 text-left ${TYPE.label}">${escapeHtml(h)}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr class="transition-colors hover:bg-paper">${row
          .map((cell) => `<td class="px-3 py-3 align-top text-sm text-stone-700">${cellHtml(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="overflow-x-auto"><table class="min-w-full divide-y divide-rule"><thead class="bg-paper"><tr>${head}</tr></thead><tbody class="divide-y divide-rule">${body}</tbody></table></div>`;
}

export function emptyState(message: string): string {
  return `<div class="${SURFACE.inset} px-5 py-8 text-center text-sm text-muted">${escapeHtml(message)}</div>`;
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
        `<div class="min-w-0"><dt class="${TYPE.label}">${escapeHtml(
          p.label,
        )}</dt><dd class="mt-0.5 break-words text-sm text-ink">${cellHtml(p.value)}</dd></div>`,
    )
    .join("")}</dl>`;
}

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

/**
 * One number, large, with its status underneath.
 *
 * These counts used to render as a list of chips with a 14px figure beside each
 * — the page's headline data set in the same size as its footnotes. A dashboard
 * needs somewhere for the eye to land first, and this is it.
 */
export function statTile(status: RunStatus, count: number): string {
  return `<div class="flex flex-col gap-1.5 rounded-lg border border-rule bg-surface px-4 py-3" data-stat="${escapeHtml(
    status,
  )}">
    <span class="${TYPE.stat}">${escapeHtml(String(count))}</span>
    <span class="flex items-center gap-1.5 text-[11px] font-medium text-muted">
      <span class="h-1.5 w-1.5 rounded-full ${STATUS_DOTS[status]}" aria-hidden="true"></span>
      ${escapeHtml(STATUS_LABELS[status])}
    </span>
  </div>`;
}

export function statRow(tiles: string[]): string {
  return `<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">${tiles.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * A sentence of rationale, folded down to a glyph.
 *
 * The console used to print its own design reasoning inline — why the runner is
 * single-flight, why a business outcome is not an error, why the page is
 * server-rendered. Each of those is worth saying once and worth being able to
 * find, and none of them is worth a paragraph on every render. They live here
 * instead: an accent glyph carrying the text as its tooltip.
 */
export function infoNote(text: string): string {
  return `<span class="inline-flex text-accent/70 transition-colors hover:text-accent" title="${escapeHtml(
    text,
  )}">${icon("info", { class: "h-3.5 w-3.5", label: text })}</span>`;
}

/** The same rationale, as a visible aside. For the one or two places it earns the room. */
export function asideNote(text: string): string {
  return `<p class="mt-3 flex gap-2 border-t border-rule pt-3 ${TYPE.meta}">
    <span class="mt-px text-accent/60">${icon("info", { class: "h-3.5 w-3.5" })}</span>
    <span class="flex-1">${escapeHtml(text)}</span>
  </p>`;
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

export interface CheatSheetCredential {
  role: string;
  username: string;
  /** The checked-in default. Absent when the environment overrides it. */
  password?: string;
  /** Name of the environment variable supplying the password. Never its value. */
  passwordFrom?: string;
  /** Extra sign-on fields, e.g. MERIDIAN CORE's branch selector. */
  extra?: Record<string, string>;
}

export interface CheatSheetData {
  credentials: CheatSheetCredential[];
  members: Array<{ id: string; note: string; shares: string[] }>;
  verifiedOn: string;
  /** True when the target is shared and its state will drift out from under this list. */
  volatile: boolean;
}

/**
 * The values you need in front of you to drive a run by hand, folded away until
 * asked for.
 *
 * Collapsed by default, and not because the information is unimportant: it is
 * needed intensely for about fifteen seconds and then not at all, which is
 * exactly the shape a disclosure fits. Open, it is the fastest lookup in the
 * console; closed, it costs one line.
 *
 * Passwords print the repository's default and never the effective value — see
 * the note in `apps/demo-data.ts` for why that distinction matters.
 */
export function cheatSheet(data: CheatSheetData, opts?: { compact?: boolean }): string {
  // The panel appears both full-width (catalog, invoke) and in the run page's
  // third-width sidebar. Tailwind's breakpoints are viewport-wide, so a
  // `lg:grid-cols-2` would split the sidebar copy into two unreadable columns on
  // exactly the wide screens it is meant to help. The caller says which it is.
  const columns = opts?.compact ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-2";
  const creds = data.credentials.length
    ? `<div class="flex flex-wrap gap-2">${data.credentials
        .map((c) => {
          const secret = c.passwordFrom
            ? `<span class="text-amber-700" title="Overridden in this environment; the value is deliberately not shown.">set via ${escapeHtml(
                c.passwordFrom,
              )}</span>`
            : `<span class="font-mono text-ink">${escapeHtml(c.password ?? "—")}</span>`;
          const extra = Object.entries(c.extra ?? {})
            .map(([k, v]) => ` <span class="text-stone-400">${escapeHtml(k)}</span> <span class="font-mono text-ink">${escapeHtml(v)}</span>`)
            .join("");
          return `<span class="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper px-2 py-1 text-xs">
            <span class="font-medium text-muted">${escapeHtml(c.role)}</span>
            <span class="font-mono text-ink">${escapeHtml(c.username)}</span>
            <span class="text-stone-300">/</span>
            ${secret}${extra}
          </span>`;
        })
        .join("")}</div>`
    : `<p class="${TYPE.meta}">No credentials configured for this app.</p>`;

  const members = data.members.length
    ? `<ul class="space-y-2.5">${data.members
        .map(
          (m) => `<li>
            <div class="flex flex-wrap items-baseline gap-2">
              <span class="font-mono text-sm font-medium text-ink">${escapeHtml(m.id)}</span>
              <span class="${TYPE.meta}">${escapeHtml(m.note)}</span>
            </div>
            ${
              m.shares.length
                ? `<div class="mt-1 flex flex-wrap gap-1">${m.shares
                    .map(
                      (s) =>
                        `<span class="rounded border border-rule bg-paper px-1.5 py-0.5 font-mono text-[11px] text-stone-700">${escapeHtml(
                          s,
                        )}</span>`,
                    )
                    .join("")}</div>`
                : ""
            }
          </li>`,
        )
        .join("")}</ul>`
    : `<p class="${TYPE.meta}">No members listed for this app.</p>`;

  const drift = data.volatile
    ? `Share codes drift — this is a live, shared host and other people's runs open new shares and place holds. Confirmed ${escapeHtml(
        data.verifiedOn,
      )}.`
    : `Confirmed ${escapeHtml(data.verifiedOn)}.`;

  return `<details class="rounded-lg border border-rule bg-surface">
    <summary class="flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-stone-600 hover:bg-paper">
      <span class="chev inline-flex transition-transform" aria-hidden="true">${icon("chevronRight", {
        class: "h-3.5 w-3.5",
      })}</span>
      ${icon("book", { class: "h-3.5 w-3.5 text-accent" })}
      Demo data
      ${
        opts?.compact
          ? ""
          : `<span class="ml-auto truncate font-normal text-stone-400">sign-on, members, share codes</span>`
      }
    </summary>
    <div class="grid ${columns} gap-5 border-t border-rule px-4 py-4">
      <div>
        <h4 class="mb-2 ${TYPE.label}">Sign-on</h4>
        ${creds}
      </div>
      <div>
        <h4 class="mb-2 ${TYPE.label}">Members &amp; shares</h4>
        ${members}
      </div>
    </div>
    <p class="border-t border-rule px-4 py-2.5 ${TYPE.meta}">${drift}</p>
  </details>`;
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
  if (!iso) return `<span class="text-stone-400">—</span>`;
  return `<span title="${escapeHtml(iso)}" class="whitespace-nowrap tabular-nums text-stone-600">${escapeHtml(
    timeAgo(iso),
  )}</span>`;
}

export function durationCell(ms: number | undefined): string {
  if (ms === undefined) return `<span class="text-stone-400">—</span>`;
  return `<span class="whitespace-nowrap tabular-nums text-stone-600">${escapeHtml(duration(ms))}</span>`;
}

/** Monospaced inline code. */
export function code(text: string): string {
  return `<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[12px] text-stone-700">${escapeHtml(
    text,
  )}</code>`;
}

/** First 12 chars of a content hash — enough to eyeball drift, short enough to read. */
export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}
