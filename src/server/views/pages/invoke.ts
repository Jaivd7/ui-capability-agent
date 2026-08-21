import type { InputParam } from "../../../artifact/schema.js";
import type { CatalogEntryDetail, RunSummary } from "../../types.js";
import { escapeHtml, escapeUrl } from "../layout.js";
import { CONTROL, TYPE } from "../theme.js";
import {
  appBadge,
  card,
  cheatSheet,
  infoNote,
  irreversibleBadge,
  roleBadge,
  shortHash,
  statusChip,
  typeBadge,
  typedFieldChip,
  type CheatSheetData,
} from "../components.js";

/**
 * The invoke form is *generated from the artifact's declared input params* —
 * there is no hand-written form anywhere in this project.
 *
 * That is the whole argument of the page, and it's why each field carries its
 * declared type as a visible badge: what you are looking at is the capability's
 * call contract, rendered. A `currency` param becomes a numeric control with
 * cent precision, a `date` param becomes a date picker, a `sensitive` param
 * becomes a password field whose value never reaches the log, and all of that
 * falls out of the artifact rather than out of someone's markup.
 */

export interface InvokePageOptions {
  /** Roles the operator may run as, e.g. from the app's user table. */
  roles: string[];
  /** Set when a run is already in flight: the runner is single-flight. */
  busyWith?: RunSummary;
  /** Previously submitted raw values, echoed back on a validation re-render. */
  values?: Record<string, string>;
  /** Per-field validation problems, keyed by param name (or `role`). */
  errors?: Array<{ name: string; problem: string }>;
  /** Known-good sign-on and member values for this capability's target app. */
  demo?: CheatSheetData;
}

export function invokePage(entry: CatalogEntryDetail, opts: InvokePageOptions): string {
  const action = `/capabilities/${escapeUrl(entry.id)}/invoke`;
  const errorsByName = new Map<string, string>();
  for (const e of opts.errors ?? []) if (!errorsByName.has(e.name)) errorsByName.set(e.name, e.problem);

  const busy = opts.busyWith;
  const fields = entry.inputParams.length
    ? entry.inputParams.map((p) => field(p, opts.values, errorsByName.get(p.name))).join("")
    : `<p class="text-sm text-stone-500">This capability takes no input parameters.</p>`;

  const summary =
    (opts.errors?.length ?? 0) > 0
      ? `<div class="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p class="font-semibold">${escapeHtml(String(opts.errors?.length ?? 0))} ${
            (opts.errors?.length ?? 0) === 1 ? "field needs" : "fields need"
          } attention</p>
          <ul class="mt-1 list-disc pl-5">${(opts.errors ?? [])
            .map((e) => `<li><span class="font-mono">${escapeHtml(e.name)}</span>: ${escapeHtml(e.problem)}</li>`)
            .join("")}</ul>
        </div>`
      : "";

  const busyBanner = busy
    ? `<div data-runner-banner class="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span aria-hidden="true">&#9888;</span>
        <p class="flex-1">The runner is busy with
          <a class="font-medium underline underline-offset-2" href="/runs/${escapeUrl(busy.runId)}">${escapeHtml(
            busy.capabilityId,
          )} &middot; ${escapeHtml(busy.runId)}</a>. One run at a time: the browser session is the shared resource.</p>
        ${statusChip(busy.status, busy.escalated)}
      </div>`
    : "";

  const submitDisabled = busy ? " disabled" : "";
  // The poll script swaps these two class sets when the runner frees up, so the
  // pair here has to stay in step with ENABLED/DISABLED in poll-script.ts.
  const submitClasses = busy ? "cursor-not-allowed bg-stone-200 text-stone-400" : "bg-accent text-white hover:bg-accent-hover";

  const form = `<form method="post" action="${action}" class="space-y-6">
    ${summary}
    <div class="space-y-5">${fields}</div>
    <div class="grid grid-cols-1 gap-5 border-t border-stone-100 pt-5 sm:grid-cols-2">
      ${roleField(entry, opts, errorsByName.get("role"))}
      ${escalateField(opts.values)}
    </div>
    <div class="flex items-center gap-3 border-t border-stone-100 pt-5">
      <button type="submit" data-runner-lock${submitDisabled}
        class="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium shadow-sm transition-colors ${submitClasses}">
        Invoke capability
      </button>
      <a href="/capabilities" class="text-sm text-stone-500 hover:text-stone-800">Cancel</a>
      <span class="ml-auto text-xs text-stone-400">POST ${escapeHtml(action)}</span>
    </div>
  </form>`;

  return `<div class="mb-6">
    <a href="/capabilities" class="text-xs text-stone-500 hover:text-stone-800">&larr; Capabilities</a>
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <h1 class="${TYPE.pageTitle}">${escapeHtml(entry.name)}</h1>
      <span class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-500">v${escapeHtml(
        String(entry.version),
      )}</span>
      ${appBadge(entry.app, entry.appDisplayName)}
      ${roleBadge(entry.requiredRole)}
      ${irreversibleBadge(entry.irreversible)}
    </div>
    <p class="mt-1 max-w-2xl text-sm text-stone-500">${escapeHtml(entry.description)}</p>
  </div>
  ${busyBanner}
  ${opts.demo ? `<div class="mb-5">${cheatSheet(opts.demo)}</div>` : ""}
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
    <div class="lg:col-span-2">${card("Arguments", form)}</div>
    <div class="space-y-6">${sidebar(entry)}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const INPUT_CLASSES = CONTROL.input;
const INPUT_ERROR_CLASSES = CONTROL.inputError;

function field(param: InputParam, values: Record<string, string> | undefined, error: string | undefined): string {
  const id = `param-${param.name}`;
  const submitted = values?.[param.name];
  const control = renderControl(param, id, submitted, error !== undefined);

  return `<div>
    <div class="flex flex-wrap items-center gap-2">
      <label for="${escapeHtml(id)}" class="text-sm font-medium text-stone-800">${escapeHtml(param.name)}</label>
      ${typeBadge(param.type)}
      ${
        param.required
          ? `<span class="text-[11px] font-medium text-red-600" title="required">required</span>`
          : `<span class="text-[11px] text-stone-400">optional</span>`
      }
      ${
        param.sensitive
          ? `<span class="text-[11px] text-amber-700" title="masked in logs and evidence">&#128274; sensitive</span>`
          : ""
      }
    </div>
    ${param.description ? `<small class="mt-0.5 block text-xs text-stone-500">${escapeHtml(param.description)}</small>` : ""}
    <div class="mt-1.5">${control}</div>
    ${error !== undefined ? `<p class="mt-1 text-xs font-medium text-red-600">${escapeHtml(error)}</p>` : ""}
  </div>`;
}

function renderControl(
  param: InputParam,
  id: string,
  submitted: string | undefined,
  hasError: boolean,
): string {
  const cls = hasError ? INPUT_ERROR_CLASSES : INPUT_CLASSES;
  const common = `id="${escapeHtml(id)}" name="${escapeHtml(param.name)}"${param.required ? " required" : ""}`;
  const options = declaredOptions(param);

  if (options) {
    const chosen = submitted ?? exampleString(param);
    const blank = param.required ? "" : `<option value=""></option>`;
    return `<select ${common} class="${cls}">${blank}${options
      .map(
        (o) =>
          `<option value="${escapeHtml(o)}"${o === chosen ? " selected" : ""}>${escapeHtml(o)}</option>`,
      )
      .join("")}</select>`;
  }

  if (param.type === "boolean") {
    const checked = submitted !== undefined ? isTruthy(submitted) : param.example === true;
    // A hidden "false" ahead of the checkbox means an unchecked box still posts
    // a value; without it the server can't distinguish "unchecked" from "field
    // never rendered", which matters for optional booleans.
    return `<label class="inline-flex items-center gap-2 text-sm text-stone-700">
      <input type="hidden" name="${escapeHtml(param.name)}" value="false">
      <input type="checkbox" ${common} value="true"${checked ? " checked" : ""}
        class="h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900">
      <span class="text-stone-500">true when checked</span>
    </label>`;
  }

  if (param.sensitive) {
    return `<input type="password" ${common} autocomplete="off" spellcheck="false"
      value="${escapeHtml(submitted ?? "")}" placeholder="••••••••" class="${cls} font-mono">`;
  }

  if (param.type === "date") {
    return `<input type="date" ${common} value="${escapeHtml(submitted ?? exampleString(param))}" class="${cls}">`;
  }

  if (param.type === "number" || param.type === "currency") {
    const placeholder = exampleString(param);
    return `<input type="number" step="0.01" inputmode="decimal" ${common}
      value="${escapeHtml(submitted ?? "")}"${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ""} class="${cls} tabular-nums">`;
  }

  const placeholder = exampleString(param);
  return `<input type="text" ${common} value="${escapeHtml(submitted ?? "")}"${
    placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ""
  } class="${cls}">`;
}

/**
 * `options` is not (yet) part of `InputParamSchema`. Reading it defensively
 * rather than adding the field keeps this package from being the reason the
 * schema changes: if enumerations land later, this renders a `<select>` with no
 * edit here, and until then every param falls through to its typed control.
 */
function declaredOptions(param: InputParam): string[] | undefined {
  const raw = (param as InputParam & { options?: unknown }).options;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      values.push(String(item));
    } else if (item && typeof item === "object" && "value" in item) {
      const v = (item as { value: unknown }).value;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") values.push(String(v));
    }
  }
  return values.length ? values : undefined;
}

function exampleString(param: InputParam): string {
  return param.example === undefined ? "" : String(param.example);
}

function isTruthy(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "on" || v === "1" || v === "yes";
}

function roleField(entry: CatalogEntryDetail, opts: InvokePageOptions, error: string | undefined): string {
  const submitted = opts.values?.["role"];
  const preferred = submitted ?? entry.requiredRole ?? "";
  const roles = [...opts.roles];
  if (preferred && !roles.includes(preferred)) roles.unshift(preferred);

  const options = roles
    .map(
      (r) =>
        `<option value="${escapeHtml(r)}"${r === preferred ? " selected" : ""}>${escapeHtml(r)}${
          r === entry.requiredRole ? " (required by capability)" : ""
        }</option>`,
    )
    .join("");

  return `<div>
    <div class="flex items-center gap-2">
      <label for="role" class="text-sm font-medium text-stone-800">Run as role</label>
      ${typeBadge("role")}
    </div>
    <small class="mt-0.5 block text-xs text-stone-500">${
      entry.requiredRole
        ? `This capability declares <span class="font-mono">${escapeHtml(
            entry.requiredRole,
          )}</span> as its required role. Running as anything else is a good way to see the permission-denied path.`
        : "No role is declared as required for this capability."
    }</small>
    <select id="role" name="role" class="${
      error !== undefined ? INPUT_ERROR_CLASSES : INPUT_CLASSES
    } mt-1.5">${roles.length ? "" : `<option value="">(no roles configured)</option>`}${options}</select>
    ${error !== undefined ? `<p class="mt-1 text-xs font-medium text-red-600">${escapeHtml(error)}</p>` : ""}
  </div>`;
}

/**
 * Checked by default, unlike the CLIs. At a dashboard there is by definition a
 * human present, so the sensible default is "stop and ask me" rather than
 * "fail and write it in a log I might read later".
 */
function escalateField(values: Record<string, string> | undefined): string {
  const submitted = values?.["escalate"];
  const checked = submitted === undefined ? true : isTruthy(submitted);
  return `<div>
    <div class="flex items-center gap-2">
      <span class="text-sm font-medium text-stone-800">Escalation</span>
      ${typeBadge("boolean")}
    </div>
    <small class="mt-0.5 block text-xs text-stone-500">Pause and hand the live browser session to you if the run gets stuck or hits an irreversible step.</small>
    <label class="mt-1.5 inline-flex items-center gap-2 text-sm text-stone-700">
      <input type="hidden" name="escalate" value="false">
      <input type="checkbox" id="escalate" name="escalate" value="true"${checked ? " checked" : ""}
        class="h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900">
      <span>Escalate to me instead of failing</span>
    </label>
  </div>`;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function sidebar(entry: CatalogEntryDetail): string {
  const outputs = entry.outputs.length
    ? `<div class="flex flex-wrap gap-1.5">${entry.outputs
        .map((o) => typedFieldChip(o.name, o.type, { sensitive: o.sensitive }))
        .join(" ")}</div>`
    : `<p class="text-sm text-stone-400">This capability returns no outputs.</p>`;

  const business = entry.knownOutcomes.filter((o) => o.classification === "business");
  const outcomes = business.length
    ? `<ul class="space-y-2">${business
        .map(
          (o) => `<li>
            <span class="inline-flex items-center rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-700">${escapeHtml(
              o.code ?? o.id,
            )}</span>
            <p class="mt-0.5 text-xs text-stone-500">${escapeHtml(o.message ?? o.description)}</p>
          </li>`,
        )
        .join("")}</ul>`
    : `<p class="text-sm text-stone-400">No business outcomes recorded for this capability.</p>`;

  return `${card(
    "Returns on success",
    outputs,
  )}${card(
    "May return instead",
    outcomes,
    {
      actions: infoNote(
        "A business outcome is a legitimate answer, not an error. It comes back with a code and a message and is reported as such.",
      ),
    },
  )}${card(
    "Artifact",
    `<dl class="space-y-2 text-xs">
      <div class="flex justify-between gap-3"><dt class="text-stone-500">id</dt><dd class="font-mono text-stone-700">${escapeHtml(
        entry.id,
      )}</dd></div>
      <div class="flex justify-between gap-3"><dt class="text-stone-500">version</dt><dd class="font-mono text-stone-700">${escapeHtml(
        String(entry.version),
      )}</dd></div>
      <div class="flex justify-between gap-3"><dt class="text-stone-500">schema</dt><dd class="font-mono text-stone-700">${escapeHtml(
        entry.schemaVersion,
      )}</dd></div>
      <div class="flex justify-between gap-3"><dt class="text-stone-500">hash</dt><dd class="font-mono text-stone-700">${escapeHtml(
        shortHash(entry.contentHash),
      )}</dd></div>
      <div class="flex justify-between gap-3"><dt class="text-stone-500">target</dt><dd class="font-mono text-stone-700">${escapeHtml(
        entry.baseUrl,
      )}</dd></div>
      <div class="flex justify-between gap-3"><dt class="text-stone-500">steps</dt><dd class="font-mono text-stone-700">${escapeHtml(
        String(entry.artifact.steps.length),
      )}</dd></div>
    </dl>`,
  )}`;
}
