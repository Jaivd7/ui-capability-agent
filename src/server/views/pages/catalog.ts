import type { CapabilityArtifact, CheckpointCondition, LocatorCandidate, Step } from "../../../artifact/schema.js";
import type { CatalogEntry, RunStatus, RunSummary } from "../../types.js";
import { escapeHtml, escapeUrl } from "../layout.js";
import { icon } from "../icons.js";
import { CONTROL, TYPE } from "../theme.js";
import {
  cheatSheet,
  code,
  emptyState,
  infoNote,
  irreversibleBadge,
  roleBadge,
  shortHash,
  statRow,
  statTile,
  statusChip,
  timeAgo,
  typedFieldChip,
  type CheatSheetData,
} from "../components.js";

/**
 * The catalog: what an agent can call, grouped by the app it belongs to. Also
 * the console's landing page, since it is where the work starts.
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

export interface DemoLink {
  label: string;
  description: string;
  href: string;
}

export interface CatalogPageOptions {
  /** The single in-flight run, if any. The runner is single-flight. */
  active?: RunSummary;
  counts?: Record<RunStatus, number>;
  demoLinks?: DemoLink[];
  /** Known-good sign-on and member values, keyed by app id. */
  cheatSheets?: Record<string, CheatSheetData>;
}

export function catalogPage(entries: CatalogEntry[], opts: CatalogPageOptions = {}): string {
  const head = `${pageHeader(entries.length)}
    ${runnerStrip(opts.active)}
    ${opts.counts ? `<div class="mt-5">${statRow(COUNT_ORDER.map((s) => statTile(s, opts.counts![s] ?? 0)))}</div>` : ""}
    ${demoStrip(opts.demoLinks ?? [])}`;

  if (entries.length === 0) {
    return `${head}<div class="mt-8">${emptyState(
      "No capabilities recorded yet. Run discovery to record one, then it will appear here.",
    )}</div>`;
  }

  const sections = groupByApp(entries)
    .map((group) => {
      const sheet = opts.cheatSheets?.[group.app];
      return `<section class="mt-10">
        <div class="mb-3 flex flex-wrap items-baseline gap-3 border-b border-rule pb-2">
          <h2 class="font-serif text-lg font-semibold tracking-tight text-ink">${escapeHtml(
            group.appDisplayName,
          )}</h2>
          <span class="font-mono text-xs text-stone-400">${escapeHtml(group.app)}</span>
          <span class="${TYPE.meta}">${escapeHtml(group.baseUrl)}</span>
          <span class="ml-auto ${TYPE.meta}">${group.entries.length} ${
            group.entries.length === 1 ? "capability" : "capabilities"
          }</span>
        </div>
        ${sheet ? `<div class="mb-4">${cheatSheet(sheet)}</div>` : ""}
        <div class="grid grid-cols-1 gap-4">${group.entries.map(capabilityCard).join("")}</div>
      </section>`;
    })
    .join("");

  return `${head}${sections}`;
}

function pageHeader(count: number): string {
  return `<div class="mb-6">
    <h1 class="${TYPE.pageTitle}">Capabilities</h1>
    <p class="mt-1.5 max-w-2xl ${TYPE.body}">${
      count === 0
        ? "Recorded capability artifacts, grouped by target app."
        : `${count} recorded ${
            count === 1 ? "capability" : "capabilities"
          }, grouped by target app. Each one replays deterministically with no model in the loop.`
    }</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Header strips
// ---------------------------------------------------------------------------

const SINGLE_FLIGHT =
  "The runner is single-flight: one browser session, one run at a time. That is why Invoke disables itself while something else is going.";

/**
 * Runner state, at the top of the page you invoke from.
 *
 * It reads as a status line rather than a card because it is true of the whole
 * console rather than of anything on the page under it, and because for most of
 * a session it says "idle" and should cost almost nothing to skip over.
 */
function runnerStrip(active: RunSummary | undefined): string {
  if (!active) {
    return `<div data-runner-state="idle" class="flex flex-wrap items-center gap-2.5 rounded-lg border border-rule bg-surface px-4 py-2.5">
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-600" aria-hidden="true"></span>
      <p class="text-sm font-medium text-ink">Runner idle</p>
      <p class="${TYPE.meta}">Nothing in flight. Any capability can be invoked now.</p>
      ${infoNote(SINGLE_FLIGHT)}
    </div>`;
  }

  const href = `/runs/${escapeUrl(active.runId)}`;

  if (active.status === "escalation_pending") {
    return `<div data-runner-state="paused" class="flex flex-wrap items-center gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5">
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden="true"></span>
      <p class="text-sm font-semibold text-amber-900">Paused &mdash; awaiting you</p>
      <p class="text-xs text-amber-900">${escapeHtml(
        active.capabilityId,
      )} stopped and handed the browser session over. Nothing else can run until you resolve it.</p>
      <a href="${href}/escalation" class="ml-auto inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700">
        Take control ${icon("arrowRight", { class: "h-3.5 w-3.5" })}
      </a>
    </div>`;
  }

  return `<div data-runner-state="running" class="flex flex-wrap items-center gap-2.5 rounded-lg border border-blue-200 bg-surface px-4 py-2.5">
    <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden="true"></span>
    <p class="text-sm font-medium text-ink">Running ${escapeHtml(active.capabilityId)}</p>
    ${statusChip(active.status, active.escalated)}
    ${infoNote(SINGLE_FLIGHT)}
    <a href="${href}" class="ml-auto ${CONTROL.link} text-sm">Watch it &rarr;</a>
  </div>`;
}

/**
 * One link per branch of the result contract, so a reviewer is one click from
 * the interesting behaviour instead of guessing which member id triggers it.
 * A strip rather than a grid of cards: these matter enormously on the first
 * visit and never again, so they should not outrank the catalog itself.
 */
function demoStrip(links: DemoLink[]): string {
  if (links.length === 0) return "";
  const items = links
    .map(
      (link) => `<a href="${escapeHtml(link.href)}" title="${escapeHtml(link.description)}"
        class="group inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:border-accent/40 hover:text-accent">
        ${escapeHtml(link.label)}
        <span class="text-stone-300 transition-colors group-hover:text-accent">${icon("arrowRight", {
          class: "h-3 w-3",
        })}</span>
      </a>`,
    )
    .join("");
  return `<div class="mt-5 flex flex-wrap items-center gap-2">
    <span class="${TYPE.label}">Try</span>
    ${items}
    ${infoNote("Each opens a prefilled invoke form — nothing runs until you submit.")}
  </div>`;
}

const COUNT_ORDER: RunStatus[] = [
  "succeeded",
  "business_outcome",
  "failed",
  "crashed",
  "running",
  "escalation_pending",
];

// ---------------------------------------------------------------------------

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
        .map((p) => typedFieldChip(p.required ? p.name : `${p.name}?`, p.type, { sensitive: p.sensitive }))
        .join(" ")
    : `<span class="${TYPE.meta}">none</span>`;

  const outputs = entry.outputs.length
    ? entry.outputs.map((o) => typedFieldChip(o.name, o.type, { sensitive: o.sensitive })).join(" ")
    : `<span class="${TYPE.meta}">none</span>`;

  const businessCodes = entry.knownOutcomes.filter((o) => o.classification === "business");
  const codes = businessCodes.length
    ? businessCodes
        .map(
          (o) =>
            `<span class="inline-flex items-center rounded-md bg-paper px-2 py-1 font-mono text-[11px] text-stone-600 ring-1 ring-inset ring-rule" title="${escapeHtml(
              o.message ?? o.description,
            )}">${escapeHtml(o.code ?? o.id)}</span>`,
        )
        .join(" ")
    : `<span class="${TYPE.meta}">none recorded</span>`;

  const lastRun = entry.lastRun
    ? `<a href="/runs/${escapeUrl(entry.lastRun.runId)}" class="inline-flex items-center gap-2 hover:underline">${statusChip(
        entry.lastRun.status,
      )}<span class="${TYPE.meta}">${escapeHtml(
        entry.lastRun.finishedAt ? timeAgo(entry.lastRun.finishedAt) : "in flight",
      )}</span></a>`
    : `<span class="${TYPE.meta}">never run</span>`;

  return `<article class="rounded-lg border border-rule bg-surface transition-colors hover:border-stone-300">
    <div class="flex flex-wrap items-start gap-4 px-5 py-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-[15px] font-semibold text-ink">${escapeHtml(entry.name)}</h3>
          <span class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-muted">v${escapeHtml(
            String(entry.version),
          )}</span>
          ${roleBadge(entry.requiredRole)}
          ${irreversibleBadge(entry.irreversible)}
        </div>
        <p class="mt-1 ${TYPE.body}">${escapeHtml(entry.description)}</p>
        <p class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-400">
          <span class="font-mono">${escapeHtml(entry.id)}</span>
          <span title="content hash of the semantically meaningful artifact content">hash ${escapeHtml(
            shortHash(entry.contentHash),
          )}</span>
          <span>schema ${escapeHtml(entry.schemaVersion)}</span>
        </p>
      </div>
      <div class="flex shrink-0 flex-col items-end gap-2">
        <a href="${invokeHref}" data-runner-lock-link class="${CONTROL.primary}">
          Invoke ${icon("arrowRight", { class: "h-3.5 w-3.5" })}
        </a>
        ${lastRun}
      </div>
    </div>

    <div class="grid grid-cols-1 gap-4 border-t border-rule px-5 py-4 sm:grid-cols-3">
      ${contractBlock("Inputs", inputs)}
      ${contractBlock("Outputs", outputs)}
      ${contractBlock("Business outcomes", codes)}
    </div>

    ${detailsBlock(entry)}
  </article>`;
}

function contractBlock(label: string, body: string): string {
  return `<div>
    <h4 class="mb-1.5 ${TYPE.label}">${escapeHtml(label)}</h4>
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
    return `<div class="border-t border-rule px-5 py-3 ${TYPE.meta}">
      Recorded step recipe available on the capability detail view.
    </div>`;
  }

  const steps = artifact.steps
    .map(
      (step, i) => `<li class="flex gap-3 py-2">
        <span class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[11px] font-semibold tabular-nums text-stone-600">${
          i + 1
        }</span>
        <div class="min-w-0">
          <p class="text-sm text-stone-700">${escapeHtml(step.description)}${
            step.irreversible ? ` ${irreversibleBadge()}` : ""
          }${
            step.retryable
              ? ` <span class="inline-flex items-center rounded bg-paper px-1.5 py-0.5 text-[10px] text-muted ring-1 ring-inset ring-rule">retryable</span>`
              : ""
          }</p>
          <p class="mt-0.5 font-mono text-[11px] text-stone-400">${escapeHtml(step.type)} &middot; ${escapeHtml(
            locatorSummary(step),
          )}</p>
        </div>
      </li>`,
    )
    .join("");

  const checkpoints = artifact.checkpoints
    .map(
      (c) => `<li class="flex gap-2 py-1.5 text-sm text-stone-700">
        <span class="mt-0.5 text-emerald-600">${icon("check", { class: "h-3.5 w-3.5" })}</span>
        <div><span>${escapeHtml(c.description)}</span>
        <span class="ml-1 font-mono text-[11px] text-stone-400">${escapeHtml(checkpointSummary(c))}</span></div>
      </li>`,
    )
    .join("");

  const outcomes = artifact.knownOutcomes.length
    ? artifact.knownOutcomes
        .map((o) => {
          const tag =
            o.classification === "business"
              ? `<span class="inline-flex items-center rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600">${escapeHtml(
                  o.outcome.code,
                )}</span>`
              : `<span class="inline-flex items-center rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">recover: ${escapeHtml(
                  o.recovery.action,
                )}</span>`;
          return `<li class="flex flex-wrap items-center gap-2 py-1.5 text-sm text-stone-700">${tag}<span class="font-mono text-[11px] text-muted">${escapeHtml(
            o.id,
          )}</span><span>${escapeHtml(o.description)}</span><span class="font-mono text-[11px] text-stone-400">${escapeHtml(
            o.checkAfterStepId ? `after ${o.checkAfterStepId}` : "checked after every step",
          )}</span></li>`;
        })
        .join("")
    : `<li class="py-1.5 text-sm text-stone-400">None recorded.</li>`;

  return `<details class="border-t border-rule">
    <summary class="flex items-center gap-2 px-5 py-2.5 text-xs font-medium text-muted hover:bg-paper">
      <span class="chev inline-flex transition-transform" aria-hidden="true">${icon("chevronRight", {
        class: "h-3.5 w-3.5",
      })}</span>
      How it does it &mdash; ${escapeHtml(String(artifact.steps.length))} recorded steps,
      ${escapeHtml(String(artifact.checkpoints.length))} checkpoints
      <span class="ml-2 font-normal text-stone-400">(UI knowledge; a caller never needs this)</span>
    </summary>
    <div class="grid grid-cols-1 gap-6 border-t border-rule bg-paper px-5 py-4 lg:grid-cols-2">
      <div>
        <h4 class="mb-1 ${TYPE.label}">Recorded steps</h4>
        <ol class="divide-y divide-rule">${steps}</ol>
      </div>
      <div class="space-y-5">
        <div>
          <h4 class="mb-1 ${TYPE.label}">Checkpoints</h4>
          <ul class="divide-y divide-rule">${checkpoints}</ul>
        </div>
        <div>
          <h4 class="mb-1 ${TYPE.label}">Known outcomes</h4>
          <ul class="divide-y divide-rule">${outcomes}</ul>
        </div>
        <div class="text-[11px] text-stone-400">
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
