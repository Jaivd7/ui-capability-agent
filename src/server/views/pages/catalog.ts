import type { CapabilityArtifact, CheckpointCondition, LocatorCandidate, Step } from "../../../artifact/schema.js";
import type { CatalogEntry } from "../../types.js";
import { escapeHtml, escapeUrl } from "../layout.js";
import {
  code,
  emptyState,
  irreversibleBadge,
  roleBadge,
  shortHash,
  statusChip,
  timeAgo,
  typedFieldChip,
} from "../components.js";

/**
 * The catalog: what an agent can call, grouped by the app it belongs to.
 *
 * The card is deliberately split in two. Above the fold is the *call contract*
 * — name, typed inputs, typed outputs, the business-outcome codes you may get
 * back, the role you need. That is everything a caller needs and it contains no
 * UI knowledge at all, which is the premise of the whole system.
 *
 * Below the fold, in a collapsed `<details>`, is the UI knowledge: the recorded
 * step recipe and its locators. It's there for a human deciding whether to trust
 * this thing to run unattended, and for debugging when it drifts. Folding it
 * away is the point — a caller should be able to read this page and never learn
 * that the app has an iframe.
 */

export function catalogPage(entries: CatalogEntry[]): string {
  if (entries.length === 0) {
    return `${pageHeader(0)}${emptyState(
      "No capabilities recorded yet. Run discovery to record one, then it will appear here.",
    )}`;
  }

  const groups = groupByApp(entries);
  const sections = groups
    .map(
      (group) => `<section class="mb-10">
        <div class="mb-3 flex flex-wrap items-baseline gap-3 border-b border-slate-200 pb-2">
          <h2 class="text-base font-semibold tracking-tight text-slate-900">${escapeHtml(
            group.appDisplayName,
          )}</h2>
          <span class="font-mono text-xs text-slate-400">${escapeHtml(group.app)}</span>
          <span class="text-xs text-slate-400">${escapeHtml(group.baseUrl)}</span>
          <span class="ml-auto text-xs text-slate-500">${group.entries.length} ${
            group.entries.length === 1 ? "capability" : "capabilities"
          }</span>
        </div>
        <div class="grid grid-cols-1 gap-4">${group.entries.map(capabilityCard).join("")}</div>
      </section>`,
    )
    .join("");

  return `${pageHeader(entries.length)}${sections}`;
}

function pageHeader(count: number): string {
  return `<div class="mb-6">
    <h1 class="text-xl font-semibold tracking-tight text-slate-900">Capabilities</h1>
    <p class="mt-1 max-w-2xl text-sm text-slate-500">${
      count === 0
        ? "Recorded capability artifacts, grouped by target app."
        : `${count} recorded ${
            count === 1 ? "capability" : "capabilities"
          }, grouped by target app. Each one replays deterministically with no model in the loop.`
    }</p>
  </div>`;
}

interface AppGroup {
  app: string;
  appDisplayName: string;
  baseUrl: string;
  entries: CatalogEntry[];
}

function groupByApp(entries: CatalogEntry[]): AppGroup[] {
  const groups = new Map<string, AppGroup>();
  for (const entry of entries) {
    let group = groups.get(entry.app);
    if (!group) {
      group = { app: entry.app, appDisplayName: entry.appDisplayName, baseUrl: entry.baseUrl, entries: [] };
      groups.set(entry.app, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()].sort((a, b) => a.appDisplayName.localeCompare(b.appDisplayName));
}

function capabilityCard(entry: CatalogEntry): string {
  const invokeHref = `/capabilities/${escapeUrl(entry.id)}/invoke`;

  const inputs = entry.inputParams.length
    ? entry.inputParams
        .map((p) =>
          typedFieldChip(p.required ? p.name : `${p.name}?`, p.type, { sensitive: p.sensitive }),
        )
        .join(" ")
    : `<span class="text-xs text-slate-400">none</span>`;

  const outputs = entry.outputs.length
    ? entry.outputs.map((o) => typedFieldChip(o.name, o.type, { sensitive: o.sensitive })).join(" ")
    : `<span class="text-xs text-slate-400">none</span>`;

  const businessCodes = entry.knownOutcomes.filter((o) => o.classification === "business");
  const codes = businessCodes.length
    ? businessCodes
        .map(
          (o) =>
            `<span class="inline-flex items-center rounded-md bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600 ring-1 ring-inset ring-slate-200" title="${escapeHtml(
              o.message ?? o.description,
            )}">${escapeHtml(o.code ?? o.id)}</span>`,
        )
        .join(" ")
    : `<span class="text-xs text-slate-400">none recorded</span>`;

  const lastRun = entry.lastRun
    ? `<a href="/runs/${escapeUrl(entry.lastRun.runId)}" class="inline-flex items-center gap-2 hover:underline">${statusChip(
        entry.lastRun.status,
      )}<span class="text-xs text-slate-400">${escapeHtml(
        entry.lastRun.finishedAt ? timeAgo(entry.lastRun.finishedAt) : "in flight",
      )}</span></a>`
    : `<span class="text-xs text-slate-400">never run</span>`;

  return `<article class="rounded-xl bg-white shadow-sm ring-1 ring-inset ring-slate-200">
    <div class="flex flex-wrap items-start gap-4 px-5 py-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-semibold text-slate-900">${escapeHtml(entry.name)}</h3>
          <span class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">v${escapeHtml(
            String(entry.version),
          )}</span>
          ${roleBadge(entry.requiredRole)}
          ${irreversibleBadge(entry.irreversible)}
        </div>
        <p class="mt-1 text-sm text-slate-600">${escapeHtml(entry.description)}</p>
        <p class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
          <span class="font-mono">${escapeHtml(entry.id)}</span>
          <span title="content hash of the semantically meaningful artifact content">hash ${escapeHtml(
            shortHash(entry.contentHash),
          )}</span>
          <span>schema ${escapeHtml(entry.schemaVersion)}</span>
        </p>
      </div>
      <div class="flex shrink-0 flex-col items-end gap-2">
        <a href="${invokeHref}" data-runner-lock-link
           class="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-700">
          Invoke <span aria-hidden="true">&rarr;</span>
        </a>
        ${lastRun}
      </div>
    </div>

    <div class="grid grid-cols-1 gap-4 border-t border-slate-100 px-5 py-4 sm:grid-cols-3">
      ${contractBlock("Inputs", inputs)}
      ${contractBlock("Outputs", outputs)}
      ${contractBlock("Business outcomes", codes)}
    </div>

    ${detailsBlock(entry)}
  </article>`;
}

function contractBlock(label: string, body: string): string {
  return `<div>
    <h4 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">${escapeHtml(
      label,
    )}</h4>
    <div class="flex flex-wrap gap-1.5">${body}</div>
  </div>`;
}

/**
 * `catalogPage` is typed against `CatalogEntry`, which deliberately carries no
 * steps or locators. When the caller passes `CatalogEntryDetail` values (which
 * extend it) the artifact is present and the recipe renders; otherwise the
 * fold degrades to a pointer at the detail route. See the note in the report.
 */
function detailsBlock(entry: CatalogEntry): string {
  const artifact = artifactOf(entry);
  if (!artifact) {
    return `<div class="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
      Recorded step recipe available on the capability detail view.
    </div>`;
  }

  const steps = artifact.steps
    .map(
      (step, i) => `<li class="flex gap-3 py-2">
        <span class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold tabular-nums text-slate-600">${
          i + 1
        }</span>
        <div class="min-w-0">
          <p class="text-sm text-slate-700">${escapeHtml(step.description)}${
            step.irreversible ? ` ${irreversibleBadge()}` : ""
          }${
            step.retryable
              ? ` <span class="inline-flex items-center rounded bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500 ring-1 ring-inset ring-slate-200">retryable</span>`
              : ""
          }</p>
          <p class="mt-0.5 font-mono text-[11px] text-slate-400">${escapeHtml(step.type)} &middot; ${escapeHtml(
            locatorSummary(step),
          )}</p>
        </div>
      </li>`,
    )
    .join("");

  const checkpoints = artifact.checkpoints
    .map(
      (c) => `<li class="flex gap-2 py-1.5 text-sm text-slate-700">
        <span class="text-emerald-600" aria-hidden="true">&#10003;</span>
        <div><span>${escapeHtml(c.description)}</span>
        <span class="ml-1 font-mono text-[11px] text-slate-400">${escapeHtml(
          checkpointSummary(c),
        )}</span></div>
      </li>`,
    )
    .join("");

  const outcomes = artifact.knownOutcomes.length
    ? artifact.knownOutcomes
        .map((o) => {
          const tag =
            o.classification === "business"
              ? `<span class="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">${escapeHtml(
                  o.outcome.code,
                )}</span>`
              : `<span class="inline-flex items-center rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">recover: ${escapeHtml(
                  o.recovery.action,
                )}</span>`;
          return `<li class="flex flex-wrap items-center gap-2 py-1.5 text-sm text-slate-700">${tag}<span class="font-mono text-[11px] text-slate-500">${escapeHtml(
            o.id,
          )}</span><span>${escapeHtml(o.description)}</span><span class="font-mono text-[11px] text-slate-400">${escapeHtml(
            o.checkAfterStepId ? `after ${o.checkAfterStepId}` : "checked after every step",
          )}</span></li>`;
        })
        .join("")
    : `<li class="py-1.5 text-sm text-slate-400">None recorded.</li>`;

  return `<details class="border-t border-slate-100">
    <summary class="flex items-center gap-2 px-5 py-2.5 text-xs font-medium text-slate-500 hover:bg-slate-50">
      <span class="chev inline-block transition-transform" aria-hidden="true">&#9656;</span>
      How it does it &mdash; ${escapeHtml(String(artifact.steps.length))} recorded steps,
      ${escapeHtml(String(artifact.checkpoints.length))} checkpoints
      <span class="ml-2 font-normal text-slate-400">(UI knowledge; a caller never needs this)</span>
    </summary>
    <div class="grid grid-cols-1 gap-6 border-t border-slate-100 bg-slate-50/50 px-5 py-4 lg:grid-cols-2">
      <div>
        <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Recorded steps</h4>
        <ol class="divide-y divide-slate-200/70">${steps}</ol>
      </div>
      <div class="space-y-5">
        <div>
          <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Checkpoints</h4>
          <ul class="divide-y divide-slate-200/70">${checkpoints}</ul>
        </div>
        <div>
          <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Known outcomes</h4>
          <ul class="divide-y divide-slate-200/70">${outcomes}</ul>
        </div>
        <div class="text-[11px] text-slate-400">
          Entry route ${code(artifact.target.entryRoute)} &middot; recorded by
          ${escapeHtml(artifact.discovery.model)} on ${escapeHtml(artifact.discovery.discoveredAt)}
        </div>
      </div>
    </div>
  </details>`;
}

function artifactOf(entry: CatalogEntry): CapabilityArtifact | undefined {
  const candidate = (entry as CatalogEntry & { artifact?: unknown }).artifact;
  if (!candidate || typeof candidate !== "object") return undefined;
  const artifact = candidate as CapabilityArtifact;
  return Array.isArray(artifact.steps) && Array.isArray(artifact.checkpoints) ? artifact : undefined;
}

// ---------------------------------------------------------------------------
// One-line locator summaries
// ---------------------------------------------------------------------------

/**
 * Deliberately re-implemented here rather than imported from
 * `src/shared/locator.ts`: that module imports Playwright, and the view layer
 * has no business pulling a browser driver into a function that returns a
 * string. The output format is kept close to `describeCandidate` on purpose.
 */
export function describeLocatorCandidate(c: LocatorCandidate): string {
  switch (c.strategy) {
    case "role":
      return `role(${c.role}${c.name ? `, name="${c.name}"` : ""})`;
    case "label":
      return `label("${c.text}")`;
    case "text":
      return `text("${c.text}")`;
    case "placeholder":
      return `placeholder("${c.text}")`;
    case "testId":
      return `testId("${c.testId}")`;
    case "css":
      return `css("${c.selector}")`;
    case "xpath":
      return `xpath("${c.expression}")`;
  }
}

function chainSummary(chain: LocatorCandidate[], frame: Array<{ strategy: string; value: string | number }>): string {
  const first = chain[0];
  const head = first ? describeLocatorCandidate(first) : "no locator";
  const fallbacks = chain.length > 1 ? ` +${chain.length - 1} fallback${chain.length > 2 ? "s" : ""}` : "";
  const frames = frame.length ? `${frame.map((f) => `${f.strategy}=${f.value}`).join(" › ")} › ` : "";
  return `${frames}${head}${fallbacks}`;
}

function locatorSummary(step: Step): string {
  if (step.type === "navigate") return `→ ${step.urlTemplate}`;
  const base = chainSummary(step.locator, step.frame);
  if (step.type === "fill" || step.type === "select") {
    const value =
      step.value.kind === "param"
        ? `\${${step.value.param}}`
        : step.value.kind === "template"
          ? step.value.template
          : `"${step.value.value}"`;
    return `${base} ← ${value}`;
  }
  if (step.type === "extract") return `${base} → ${step.outputName} (${step.read.from})`;
  if (step.type === "waitFor") {
    return `${base} ${step.assertion}${step.expected ? ` "${step.expected}"` : ""}`;
  }
  return base;
}

function checkpointSummary(c: CheckpointCondition): string {
  return `${chainSummary(c.locator, c.frame)} ${c.assertion}${c.expected ? ` "${c.expected}"` : ""}`;
}
