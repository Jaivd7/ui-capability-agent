import type { RunSummary } from "../../types.js";
import { escapeHtml, escapeUrl } from "../layout.js";
import { appBadge, durationCell, emptyState, statusChip, table, timestampCell } from "../components.js";

/** Run history: every replay and discovery run this server knows about. */
export function runsPage(runs: RunSummary[]): string {
  const header = `<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold tracking-tight text-slate-900">Runs</h1>
      <p class="mt-1 text-sm text-slate-500">Every replay and discovery run, newest first. Each row links to the same page you watch a run on live.</p>
    </div>
    <span class="text-xs text-slate-400">${escapeHtml(String(runs.length))} ${
      runs.length === 1 ? "run" : "runs"
    }</span>
  </div>`;

  if (runs.length === 0) {
    return `${header}${emptyState("No runs recorded yet. Invoke a capability to create one.")}`;
  }

  const rows = runs.map((run) => [
    {
      html: `<a class="font-mono text-[12px] text-slate-800 underline underline-offset-2 hover:text-slate-950" href="/runs/${escapeUrl(
        run.runId,
      )}">${escapeHtml(run.runId)}</a>`,
    },
    {
      html: `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
        run.kind === "discovery"
          ? "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20"
          : "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-400/25"
      }">${escapeHtml(run.kind)}</span>`,
    },
    {
      html: `<span class="text-slate-800">${escapeHtml(run.capabilityId)}</span>${
        run.capabilityVersion !== undefined
          ? `<span class="ml-1 font-mono text-[11px] text-slate-400">v${escapeHtml(
              String(run.capabilityVersion),
            )}</span>`
          : ""
      }`,
    },
    { html: appBadge(run.app) },
    { html: `<span class="text-slate-600">${escapeHtml(run.role)}</span>` },
    { html: statusChip(run.status, run.escalated) },
    { html: timestampCell(run.startedAt) },
    { html: durationCell(run.durationMs) },
  ]);

  return `${header}<div class="rounded-xl bg-white shadow-sm ring-1 ring-inset ring-slate-200">${table(
    ["Run", "Kind", "Capability", "App", "Role", "Status", "Started", "Duration"],
    rows,
  )}</div>`;
}
