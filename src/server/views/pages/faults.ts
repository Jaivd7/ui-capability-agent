import { escapeHtml } from "../layout.js";
import { TYPE } from "../theme.js";
import { card } from "../components.js";
import {
  INJECT_DESCRIPTIONS,
  INJECT_KINDS,
  type FaultSettings,
} from "../../runtime/fault-injection.js";

/**
 * Arming a fault is how a reviewer sees the error taxonomy do its job. Each
 * option is labelled with the HTTP status and what it models, so the choice is
 * "show me a session timeout" rather than "pick a word".
 *
 * "Disarm everything" is its own form carrying its own fixed values. As a
 * second submit button inside the main form it posted the *live* error rate
 * alongside `forcedInject=none`, so disarming left a random failure rate armed
 * and the banner still up — and it depended on the browser sending the clicked
 * button after the select, which is convention rather than guarantee.
 */
export function faultsPage(opts: {
  app: string;
  settings?: FaultSettings;
  error?: string;
  saved?: boolean;
}): string {
  const s = opts.settings;
  const options = ["none", ...INJECT_KINDS]
    .map((kind) => {
      const label =
        kind === "none"
          ? "none — normal operation"
          : `${kind} — ${INJECT_DESCRIPTIONS[kind as (typeof INJECT_KINDS)[number]]}`;
      const selected = (s?.forcedInject ?? "none") === kind ? " selected" : "";
      return `<option value="${escapeHtml(kind)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");

  const body = `
    <p class="mb-4 text-sm text-stone-600">
      These controls drive the target's own <code class="rounded bg-stone-100 px-1">/settings</code> screen, using a
      separate short-lived session. They deliberately do <strong>not</strong> go through the browser context a
      capability runs in: <code class="rounded bg-stone-100 px-1">/settings</code> is left off the guardrail
      allowlist precisely so a replay can never reach it, and the cleanest way to avoid needing an exemption is not
      to use that context.
    </p>
    ${opts.error ? `<div class="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">${escapeHtml(opts.error)}</div>` : ""}
    ${opts.saved ? `<div class="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Settings applied to the target.</div>` : ""}
    <form method="post" action="/faults" class="space-y-4">
      <input type="hidden" name="app" value="${escapeHtml(opts.app)}" />
      <div>
        <label class="block text-sm font-medium text-stone-800" for="forcedInject">Forced fault</label>
        <p class="mb-1 text-xs text-stone-500">Applied to every request until you set it back to none.</p>
        <select id="forcedInject" name="forcedInject" class="w-full max-w-lg rounded-md border border-stone-300 px-2 py-1.5 text-sm">${options}</select>
      </div>
      <div>
        <label class="block text-sm font-medium text-stone-800" for="errorRate">Random failure rate</label>
        <p class="mb-1 text-xs text-stone-500">0 to 1. Applies to posting actions only — useful for showing the recoverable tier retrying.</p>
        <input id="errorRate" name="errorRate" type="number" min="0" max="1" step="0.05"
          value="${escapeHtml(String(s?.errorRate ?? 0))}"
          class="w-32 rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
      </div>
      <div class="pt-2">
        <button type="submit" class="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700">Apply</button>
      </div>
    </form>
    <form method="post" action="/faults" class="mt-3 border-t border-stone-100 pt-3">
      <input type="hidden" name="forcedInject" value="none" />
      <input type="hidden" name="errorRate" value="0" />
      <button type="submit" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-50">Disarm everything</button>
      <span class="ml-2 text-xs text-stone-500">Clears the forced fault <em>and</em> the random failure rate.</span>
    </form>`;

  return `<div class="mb-6">
    <h1 class="${TYPE.pageTitle}">Fault injection</h1>
    <p class="mt-1 max-w-2xl text-sm text-stone-500">
      The target can be told to fail on demand. Arm a fault, invoke a capability, and watch replay classify it as a
      business outcome, recover from it, or stop and report it.
    </p>
  </div>
  ${card("MERIDIAN CORE", body)}`;
}
