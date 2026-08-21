import type { RunSummary } from "../../types.js";
import { escapeHtml, escapeUrl } from "../layout.js";
import { TYPE } from "../theme.js";
import { appBadge, durationCell, emptyState, statusChip, table, timestampCell } from "../components.js";

/** Run history: every replay and discovery run this server knows about. */
export function runsPage(runs: RunSummary[]): string {
  const header = `<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="${TYPE.pageTitle}">Runs</h1>
      <p class="mt-1 text-sm text-stone-500">Every replay and discovery run, newest first. Each row links to the same page you watch a run on live.</p>
    </div>
    <span class="text-xs text-stone-400">${escapeHtml(String(runs.length))} ${
      runs.length === 1 ? "run" : "runs"
    }</span>
  </div>`;

  if (runs.length === 0) {
    return `${header}${emptyState("No runs recorded yet. Invoke a capability to create one.")}`;
  }

  /**
   * Five columns, not eight.
   *
   * Kind belongs to the run id, version belongs to the capability, role belongs
   * to the app, and a duration only means anything next to the time it started.
   * Each of those was its own column of 11px text, which made the table wide
   * enough to need horizontal scroll and no easier to read for it. Pairing them
   * costs nothing — every value is still on the row.
   */
  const rows = runs.map((run) => [
    {
      html: `<a class="font-mono text-[12px] text-stone-800 underline underline-offset-2 hover:text-accent" href="/runs/${escapeUrl(
        run.runId,
      )}">${escapeHtml(run.runId)}</a>
      <div class="mt-0.5"><span class="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
        run.kind === "discovery"
          ? "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20"
          : "bg-stone-100 text-stone-600 ring-1 ring-inset ring-stone-400/25"
      }">${escapeHtml(run.kind)}</span></div>`,
    },
    {
      html: `<span class="text-stone-800">${escapeHtml(run.capabilityId)}</span>${
        run.capabilityVersion !== undefined
          ? `<span class="ml-1 font-mono text-[11px] text-stone-400">v${escapeHtml(
              String(run.capabilityVersion),
            )}</span>`
          : ""
      }`,
    },
    { html: `${appBadge(run.app)} <span class="${TYPE.meta}">${escapeHtml(run.role)}</span>` },
    { html: statusChip(run.status, run.escalated) },
    {
      html: `${timestampCell(run.startedAt)} <span class="text-stone-300">&middot;</span> ${durationCell(
        run.durationMs,
      )}`,
    },
  ]);

  return `${header}<div class="rounded-lg border border-rule bg-surface">${table(
    ["Run", "Capability", "App / role", "Status", "Started / took"],
    rows,
  )}</div>`;
}
