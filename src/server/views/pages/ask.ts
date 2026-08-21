import { escapeHtml } from "../layout.js";
import { icon } from "../icons.js";
import { CONTROL, SURFACE, TYPE } from "../theme.js";

/**
 * The ask box: the console's front door, sitting above the catalog it routes
 * into.
 *
 * It is a *pointer*, and the copy says so in as many words. A request resolves
 * to one capability and opens that capability's own invoke form with the stated
 * values filled in — the same form, the same typed validation, the same Invoke
 * button. Nothing here executes, and nothing here is a second way to reach the
 * target.
 *
 * It is composed above `catalogPage` rather than replacing it, for the reason
 * layout.ts gives for having killed the old Overview: an index page for a
 * four-page console is a hop. Landing on a box that can only forward you would
 * repeat that mistake, so the full catalog stays on the same screen, one scroll
 * down, and every capability remains one click away whether or not anyone types
 * a word into this. If the model is unavailable the box degrades to a disabled
 * field and an explanation — never to a blocked page.
 */

export interface AskPanelOptions {
  /** False when ANTHROPIC_API_KEY is not set: routing is the one thing here that needs it. */
  modelConfigured: boolean;
  /** Echoed back so a refused or unroutable request stays visible in the field. */
  request?: string;
  /** Rendered when the last request could not be routed. */
  note?: string;
  /** Sample requests, derived from what is actually in the catalog. */
  examples?: string[];
}

export function askPanel(opts: AskPanelOptions): string {
  const disabled = !opts.modelConfigured;

  return `<section class="${SURFACE.cardEmphasis} mb-10 px-6 py-5">
    <div class="flex items-baseline justify-between gap-4">
      <h1 class="${TYPE.pageTitle}">What do you need to do?</h1>
      <span class="${TYPE.label}">Ask</span>
    </div>
    <p class="mt-1.5 ${TYPE.body}">
      Describe it in a sentence. This finds the capability you mean and opens its form with whatever you
      named already filled in &mdash; <span class="font-medium text-ink">nothing runs until you press Invoke</span>.
    </p>

    ${opts.note ? notice(opts.note) : ""}

    <form method="post" action="/ask" class="mt-4 flex flex-wrap items-center gap-2.5">
      <label class="sr-only" for="ask-input">What do you need to do?</label>
      <input
        id="ask-input"
        name="request"
        class="${CONTROL.input} min-w-0 flex-1"
        placeholder="read member 101555's contact details"
        value="${escapeHtml(opts.request ?? "")}"
        autocomplete="off"
        ${disabled ? "disabled" : "autofocus"}
      />
      <button type="submit" class="${disabled ? CONTROL.primaryDisabled : CONTROL.primary}" ${
        disabled ? "disabled" : ""
      }>
        ${icon("target", { class: "h-4 w-4" })} Find it
      </button>
    </form>

    ${disabled ? unavailable() : examples(opts.examples ?? [])}
  </section>`;
}

/**
 * The one thing on this page that needs a key, and the page still works without
 * it. Worth stating plainly: a reviewer without a key should not be left
 * wondering whether the console is broken.
 */
function unavailable(): string {
  return `<div class="mt-3.5 rounded-md border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
    <span class="font-semibold">ANTHROPIC_API_KEY is not set,</span> so requests cannot be routed.
    This box is the only thing that needs it &mdash; every capability below is fully usable by hand,
    and so are Discovery's recorded artifacts, Runs and Faults.
  </div>`;
}

function notice(message: string): string {
  return `<div class="mt-3.5 flex gap-2 rounded-md border border-rule bg-paper px-3.5 py-2.5 text-xs text-stone-700">
    <span class="mt-px shrink-0 text-muted" aria-hidden="true">${icon("info", { class: "h-3.5 w-3.5" })}</span>
    <p class="flex-1">${escapeHtml(message)}</p>
  </div>`;
}

/**
 * Examples are passed in from the catalog rather than written here, so a
 * console with different capabilities recorded suggests different things.
 */
function examples(list: string[]): string {
  if (list.length === 0) return "";
  return `<p class="mt-3.5 ${TYPE.meta}">
    Try: ${list
      .map(
        (e) =>
          `<span class="mx-0.5 inline-block rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-600">${escapeHtml(
            e,
          )}</span>`,
      )
      .join("")}
  </p>`;
}
