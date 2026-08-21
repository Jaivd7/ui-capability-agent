import type { RunStatus, RunSummary } from "../../types.js";
import { STATUS_LABELS } from "../../types.js";
import { escapeHtml, escapeUrl } from "../layout.js";
import {
  appBadge,
  card,
  durationCell,
  emptyState,
  statusChip,
  table,
  timeAgo,
  timestampCell,
} from "../components.js";

/**
 * The landing page, written for the one reader who matters: someone who has
 * just been handed this URL and has five minutes.
 *
 * Hence the two things at the top. First, runner state — because the runner is
 * single-flight and "why is my invoke button disabled" has exactly one answer,
 * which should be on screen rather than discovered. Second, the demo script:
 * three deep links that put the reviewer one click from the happy path, the
 * business-outcome path and the injected-fault path, instead of asking them to
 * guess which member ID makes the interesting thing happen.
 */

export interface DemoLink {
  label: string;
  description: string;
  href: string;
}

export interface OverviewOptions {
  apps: Array<{ id: string; displayName: string; baseUrl: string }>;
  /** The single in-flight run, if any. */
  active?: RunSummary;
  recent: RunSummary[];
  counts: Record<RunStatus, number>;
  demoLinks?: DemoLink[];
}

export function overviewPage(opts: OverviewOptions): string {
  return `<div class="mb-6">
    <h1 class="text-xl font-semibold tracking-tight text-slate-900">Overview</h1>
    <p class="mt-1 max-w-2xl text-sm text-slate-500">
      Capabilities are recorded once by a model and replayed deterministically with no model in the loop.
      This console is where you invoke them and watch what happens.
    </p>
  </div>
  ${runnerCard(opts.active)}
  <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
    <div class="space-y-6 lg:col-span-2">
      ${demoCard(opts.demoLinks ?? [])}
      ${recentCard(opts.recent)}
    </div>
    <div class="space-y-6">
      ${countsCard(opts.counts)}
      ${appsCard(opts.apps)}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------

function runnerCard(active: RunSummary | undefined): string {
  if (!active) {
    return `<div data-runner-state="idle" class="flex flex-wrap items-center gap-3 rounded-xl bg-white px-5 py-4 shadow-sm ring-1 ring-inset ring-slate-200">
      <span class="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true"></span>
      <p class="text-sm font-medium text-slate-800">Runner idle</p>
      <p class="text-sm text-slate-500">Nothing is in flight. Any capability can be invoked now.</p>
      <a href="/capabilities" class="ml-auto rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-700">Browse capabilities &rarr;</a>
    </div>`;
  }

  const href = `/runs/${escapeUrl(active.runId)}`;

  if (active.status === "escalation_pending") {
    return `<div data-runner-state="paused" class="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4">
      <div class="flex flex-wrap items-center gap-3">
        <span class="h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-hidden="true"></span>
        <p class="text-sm font-semibold text-amber-900">Paused &mdash; awaiting you</p>
        <p class="text-sm text-amber-900">${escapeHtml(active.capabilityId)} stopped and handed the browser session over. Nothing else can run until you resolve it.</p>
        <a href="${href}/escalation" class="ml-auto rounded-lg bg-amber-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-700">Take control &rarr;</a>
      </div>
      <p class="mt-2 text-xs text-amber-800"><a class="underline underline-offset-2" href="${href}">${escapeHtml(
        active.runId,
      )}</a> &middot; <span title="${escapeHtml(active.startedAt)}">started ${escapeHtml(
        timeAgo(active.startedAt),
      )}</span></p>
    </div>`;
  }

  return `<div data-runner-state="running" class="flex flex-wrap items-center gap-3 rounded-xl bg-white px-5 py-4 shadow-sm ring-1 ring-inset ring-blue-200">
    <span class="h-2 w-2 animate-pulse rounded-full bg-blue-500" aria-hidden="true"></span>
    <p class="text-sm font-medium text-slate-800">Running ${escapeHtml(active.capabilityId)}</p>
    ${statusChip(active.status, active.escalated)}
    <p class="text-sm text-slate-500">The runner is single-flight: one browser session, one run at a time.</p>
    <a href="${href}" class="ml-auto rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-700">Watch it &rarr;</a>
  </div>`;
}

function demoCard(links: DemoLink[]): string {
  if (links.length === 0) {
    return card("Demo script", emptyState("No demo links configured."));
  }
  const buttons = links
    .map(
      (link) => `<a href="${escapeHtml(link.href)}"
        class="group flex flex-col rounded-lg border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-slate-400 hover:bg-slate-50">
        <span class="text-sm font-medium text-slate-900">${escapeHtml(link.label)}</span>
        <span class="mt-1 text-xs text-slate-500">${escapeHtml(link.description)}</span>
        <span class="mt-2 text-xs font-medium text-slate-400 group-hover:text-slate-700">Open prefilled form &rarr;</span>
      </a>`,
    )
    .join("");

  return card(
    "Demo script",
    `<p class="mb-3 text-sm text-slate-500">One click per branch of the result contract. Each opens a prefilled invoke form &mdash; nothing runs until you submit.</p>
     <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">${buttons}</div>`,
  );
}

function recentCard(recent: RunSummary[]): string {
  const runs = recent.slice(0, 5);
  const body = runs.length
    ? table(
        ["Run", "Capability", "Status", "Started", "Duration"],
        runs.map((run) => [
          {
            html: `<a class="font-mono text-[12px] text-slate-800 underline underline-offset-2" href="/runs/${escapeUrl(
              run.runId,
            )}">${escapeHtml(run.runId)}</a>`,
          },
          { html: `<span class="text-slate-800">${escapeHtml(run.capabilityId)}</span>` },
          { html: statusChip(run.status, run.escalated) },
          { html: timestampCell(run.startedAt) },
          { html: durationCell(run.durationMs) },
        ]),
      )
    : emptyState("No runs yet.");

  return card("Recent runs", body, {
    actions: `<a href="/runs" class="text-xs font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900">All runs</a>`,
  });
}

const COUNT_ORDER: RunStatus[] = [
  "running",
  "escalation_pending",
  "succeeded",
  "business_outcome",
  "failed",
  "crashed",
];

function countsCard(counts: Record<RunStatus, number>): string {
  const rows = COUNT_ORDER.map(
    (status) => `<li class="flex items-center justify-between gap-3 py-1.5">
      ${statusChip(status)}
      <span class="font-mono text-sm tabular-nums text-slate-700">${escapeHtml(String(counts[status] ?? 0))}</span>
    </li>`,
  ).join("");
  return card("Runs by status", `<ul class="divide-y divide-slate-100">${rows}</ul>`);
}

function appsCard(apps: Array<{ id: string; displayName: string; baseUrl: string }>): string {
  const body = apps.length
    ? `<ul class="divide-y divide-slate-100">${apps
        .map(
          (app) => `<li class="py-2.5">
            <div class="flex flex-wrap items-center gap-2">
              ${appBadge(app.id, app.displayName)}
              <span class="font-mono text-[11px] text-slate-400">${escapeHtml(app.id)}</span>
            </div>
            <a href="${escapeHtml(app.baseUrl)}" class="mt-0.5 block text-xs text-slate-500 underline underline-offset-2 hover:text-slate-800" rel="noreferrer noopener" target="_blank">${escapeHtml(
              app.baseUrl,
            )}</a>
          </li>`,
        )
        .join("")}</ul>`
    : emptyState("No target apps configured.");
  return card("Target apps", body);
}

/** Exported for the tests and for anyone who wants the labels in the same order. */
export const STATUS_ORDER: ReadonlyArray<{ status: RunStatus; label: string }> = COUNT_ORDER.map((s) => ({
  status: s,
  label: STATUS_LABELS[s],
}));
