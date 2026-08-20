import type { RunSummary } from "../../types.js";
import { escapeHtml, escapeUrl } from "../layout.js";
import { appBadge, card, emptyState, roleBadge, statusChip, table, timestampCell } from "../components.js";

/**
 * The Discovery tab: re-record a capability with the model in the loop.
 *
 * Every other page in this dashboard shows the *product* of discovery — an
 * artifact, or a replay of one. This is the only place the thing that produces
 * them is visible, which matters because "an LLM discovers the flow once, then
 * never runs again" is the central claim of the system and the rest of the
 * console is evidence of the second half only.
 */

export interface DiscoveryPreset {
  id: string;
  app: string;
  name: string;
  goal: string;
  role: string;
  params: Array<{ name: string; exampleValue: string }>;
  /** Absent when this capability has never been recorded on this machine. */
  currentVersion?: number;
  hasArtifact: boolean;
}

export interface DiscoveryPageOptions {
  presets: DiscoveryPreset[];
  recent: RunSummary[];
  busyWith?: RunSummary;
  /** False when ANTHROPIC_API_KEY is not set: discovery is the one path that needs it. */
  modelConfigured: boolean;
  model: string;
}

export function discoveryPage(opts: DiscoveryPageOptions): string {
  const byApp = new Map<string, DiscoveryPreset[]>();
  for (const preset of opts.presets) {
    byApp.set(preset.app, [...(byApp.get(preset.app) ?? []), preset]);
  }

  return `<div class="mb-6">
    <h1 class="text-xl font-semibold tracking-tight text-slate-900">Discovery</h1>
    <p class="mt-1 max-w-3xl text-sm text-slate-500">
      Re-record a capability from scratch. ${escapeHtml(opts.model)} is given the goal below and a browser, and it
      drives the real application &mdash; observe, decide, act &mdash; until it can prove it reached the goal. The
      successful run is compiled into a typed artifact that replays with no model in the loop, ever again.
    </p>
  </div>
  ${explainer()}
  ${opts.modelConfigured ? "" : missingKey()}
  ${busyBanner(opts.busyWith)}
  ${[...byApp.entries()]
    .map(([app, presets]) => card(app, presetTable(presets, opts), { actions: appBadge(app) }))
    .join("")}
  ${card(
    "Recent discovery runs",
    opts.recent.length
      ? table(
          ["Run", "Capability", "Status", "Started", "Outcome"],
          opts.recent.map((run) => [
            {
              html: `<a class="font-mono text-[12px] text-slate-800 underline underline-offset-2" href="/runs/${escapeUrl(
                run.runId,
              )}">${escapeHtml(run.runId)}</a>`,
            },
            { html: `<span class="text-slate-800">${escapeHtml(run.capabilityId)}</span>` },
            { html: statusChip(run.status, run.escalated) },
            { html: timestampCell(run.startedAt) },
            { html: `<span class="text-xs text-slate-500">${escapeHtml(run.role)}</span>` },
          ]),
        )
      : emptyState("No discovery runs recorded yet."),
    { actions: `<a href="/runs?kind=discovery" class="text-xs font-medium text-slate-600 underline underline-offset-2">All discovery runs</a>` },
  )}`;
}

function explainer(): string {
  const steps: Array<[string, string]> = [
    ["Observe", "The page is read as an accessibility tree plus a digest of its form controls — never a screenshot. The same perception a legacy app with no clean DOM still supports."],
    ["Decide", "The model picks exactly one tool call: click, fill, select, navigate, extract, or finish. Its reasoning is logged next to the call on the run's timeline."],
    ["Act", "The action is checked against the same guardrail policy replay enforces, then executed on the live page. What comes back is the next observation."],
    ["Compile", "On finish, the run is turned into a typed artifact — steps, locators, checkpoints, typed inputs and outputs — and scored. A recording that has page data baked into it is refused."],
  ];
  return card(
    "What you will watch",
    `<ol class="grid grid-cols-1 gap-3 sm:grid-cols-2">${steps
      .map(
        ([title, body], i) => `<li class="rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3">
          <p class="text-sm font-semibold text-slate-900"><span class="mr-1.5 text-slate-400">${i + 1}.</span>${escapeHtml(title)}</p>
          <p class="mt-1 text-xs leading-relaxed text-slate-600">${escapeHtml(body)}</p>
        </li>`,
      )
      .join("")}</ol>
     <p class="mt-3 text-xs text-slate-500">
       The run page streams a live screenshot of the browser beside the model's turn-by-turn reasoning, so the loop is
       watchable as it happens.
     </p>`,
  );
}

function missingKey(): string {
  return `<div class="mb-6 rounded-xl border border-red-300 bg-red-50 px-5 py-4 text-sm text-red-900">
    <p class="font-semibold">ANTHROPIC_API_KEY is not set.</p>
    <p class="mt-1">Discovery is the only path in this system that calls a model; replay never does. Set the key in
    <code class="rounded bg-red-100 px-1">.env</code> and restart the dashboard. Every other tab works without it.</p>
  </div>`;
}

function busyBanner(busy: RunSummary | undefined): string {
  if (!busy) return "";
  return `<div data-runner-banner class="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
    <span aria-hidden="true">&#9888;</span>
    <p class="flex-1">The runner is busy with
      <a class="font-medium underline underline-offset-2" href="/runs/${escapeUrl(busy.runId)}">${escapeHtml(
        busy.capabilityId,
      )}</a>. One run at a time &mdash; discovery and replay share the single browser session.</p>
    ${statusChip(busy.status, busy.escalated)}
  </div>`;
}

function presetTable(presets: DiscoveryPreset[], opts: DiscoveryPageOptions): string {
  const rows = presets.map((preset) => {
    const disabled = opts.busyWith !== undefined || !opts.modelConfigured;
    const classes = disabled
      ? "cursor-not-allowed bg-slate-300 text-slate-500"
      : "bg-slate-900 text-white hover:bg-slate-700";
    return [
      {
        html: `<div class="max-w-xl">
          <p class="text-sm font-medium text-slate-900">${escapeHtml(preset.name)}</p>
          <p class="font-mono text-[11px] text-slate-400">${escapeHtml(preset.id)}</p>
          <details class="mt-1.5">
            <summary class="text-xs text-slate-500 hover:text-slate-800">The goal the model is given</summary>
            <p class="mt-1 rounded bg-slate-50 px-2.5 py-2 text-xs leading-relaxed text-slate-600 ring-1 ring-inset ring-slate-200">${escapeHtml(
              preset.goal,
            )}</p>
            <p class="mt-1.5 text-[11px] text-slate-500">Recorded with ${
              preset.params.length
                ? preset.params
                    .map((p) => `<code class="rounded bg-slate-100 px-1">${escapeHtml(p.name)}=${escapeHtml(p.exampleValue)}</code>`)
                    .join(" ")
                : "no arguments"
            }</p>
          </details>
        </div>`,
      },
      { html: roleBadge(preset.role) },
      {
        html: preset.hasArtifact
          ? `<span class="font-mono text-xs text-slate-600">v${escapeHtml(String(preset.currentVersion ?? 1))}</span>
             <span class="block text-[11px] text-slate-400">&rarr; will save v${escapeHtml(
               String((preset.currentVersion ?? 0) + 1),
             )}</span>`
          : `<span class="text-xs text-slate-500">not recorded</span>
             <span class="block text-[11px] text-slate-400">&rarr; will save v1</span>`,
      },
      {
        html: `<form method="post" action="/discovery/${escapeUrl(preset.id)}/run">
          <button type="submit" data-runner-lock${disabled ? " disabled" : ""}
            class="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium shadow-sm transition-colors ${classes}">
            Re-record
          </button>
        </form>`,
      },
    ];
  });

  return `${table(["Capability", "Records as", "Artifact", ""], rows)}
    <p class="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
      A re-recording overwrites <code class="rounded bg-slate-100 px-1">capabilities/&lt;app&gt;/&lt;id&gt;.json</code>
      as the next version, and costs a few cents of model spend. It skips the differential probe the CLI runs
      (that replays the new artifact with a second argument set, which on a shared target means a second real
      transaction) &mdash; the quality report says so rather than counting the missing check as passed.
    </p>`;
}
