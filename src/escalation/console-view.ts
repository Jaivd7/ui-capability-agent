import type { HumanAction, InterventionContext } from "./types.js";
import { encodePick, type PageTarget } from "./page-targets.js";

/**
 * The operator console's HTML.
 *
 * Deliberately a bare surface: a screenshot plus a fixed vocabulary of
 * commands, not pixel-level co-browsing, which the brief explicitly places out
 * of scope. What is real here is the session identity and the control-transfer
 * mechanism, not the fidelity of the operator's input method.
 *
 * Every form action is built from `basePath` rather than being an absolute
 * literal, because the console is no longer a server of its own — it is
 * mounted per run on the dashboard, at `/runs/<id>/escalation`.
 */
export interface ConsoleViewOptions {
  basePath: string;
  /**
   * What the live page currently offers, enumerated per render.
   *
   * The console used to ask the operator to type a CSS selector, which on a
   * target with no ids or test IDs meant they had to already know the markup
   * of a page they can only see as a screenshot. Passing the page's own
   * controls in turns that into picking from a list. Absent (or empty) falls
   * back to the raw selector field, which is still there for anything the
   * enumeration cannot reach.
   */
  targets?: PageTarget[];
  /** How long this run has been waiting, so an operator can see they are on a clock. */
  waitingMs: number;
  /**
   * Where the page is *now*, if it has moved since the run paused.
   *
   * `ctx.currentUrl` is frozen at the moment the intervention was raised. That
   * was accurate when the operator could not easily move the page; now that
   * clicking and navigating are one dropdown away, a header labelled "Current
   * URL" showing a stale one is actively misleading.
   */
  currentUrl?: string;
  /** Rendered when the last action was refused by policy. */
  notice?: { tone: "error" | "warn"; message: string };
}

export function renderConsole(
  ctx: InterventionContext,
  actions: HumanAction[],
  opts: ConsoleViewOptions,
): string {
  const basePath = opts.basePath;
  const isConfirmation = ctx.kind === "irreversible_confirmation";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Operator Console</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 760px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; }
  .banner { background: #fff3cd; border: 1px solid #ffcc00; padding: 12px 16px; border-radius: 6px; margin-bottom: 16px; }
  .meta { color: #555; font-size: 13px; }
  img { max-width: 100%; border: 1px solid #ccc; border-radius: 4px; margin: 12px 0; }
  button { padding: 8px 14px; margin-right: 8px; border-radius: 4px; border: 1px solid #888; cursor: pointer; }
  .danger { background: #ffe0e0; }
  .safe { background: #e0ffe0; }
  form.inline { display: inline; }
  fieldset { margin: 16px 0; }
  input, select { padding: 4px; margin: 2px; }
  ul.log { font-size: 12px; color: #444; }
  form.row { margin: 6px 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  form.row label { display: flex; gap: 6px; align-items: center; }
  select { max-width: 380px; }
  details { margin: 16px 0; }
  summary { cursor: pointer; font-size: 13px; color: #555; }
</style></head>
<body>
  <div class="banner">
    <strong>Automation paused — intervention requested</strong><br/>
    Run: ${escape(ctx.runId)} (${escape(ctx.capabilityId)})<br/>
    Reason: ${escape(ctx.reason)}
  </div>
  ${
    opts.notice
      ? `<div class="banner" style="background:${opts.notice.tone === "error" ? "#ffe0e0" : "#fff3cd"};border-color:${
          opts.notice.tone === "error" ? "#d33" : "#ffcc00"
        }"><strong>Refused:</strong> ${escape(opts.notice.message)}</div>`
      : ""
  }
  <p class="meta">
    Waiting for ${Math.round(opts.waitingMs / 1000)}s. This session can time out while you decide.<br/>
    Current URL: ${escape(opts.currentUrl ?? ctx.currentUrl)}<br/>
    ${ctx.currentStepId ? `Step: ${escape(ctx.currentStepId)} — ${escape(ctx.currentStepDescription ?? "")}<br/>` : ""}
    ${ctx.goal ? `Goal: ${escape(ctx.goal)}<br/>` : ""}
  </p>
  <img src="${basePath}/screenshot?t=${Date.now()}" alt="current page state" />

  ${
    isConfirmation
      ? `
  <fieldset>
    <legend>Pending irreversible action</legend>
    <p>${escape(ctx.pendingAction?.description ?? "")}</p>
    <p class="meta">${escape(ctx.pendingAction?.locatorSummary ?? "")}</p>
    <form class="inline" method="post" action="${basePath}/approve"><button class="danger" type="submit">Approve &amp; Execute</button></form>
    <form class="inline" method="post" action="${basePath}/reject"><button class="safe" type="submit">Reject</button></form>
  </fieldset>`
      : `
  ${manualActionPanel(basePath, opts.targets ?? [])}
  <fieldset>
    <legend>When you are done</legend>
    <form class="inline" method="post" action="${basePath}/resume"><button class="safe" type="submit">Hand back to automation</button></form>
    <form class="inline" method="post" action="${basePath}/abort"><button class="danger" type="submit">Abort run</button></form>
    <p class="meta">Handing back re-checks the capability's own checkpoints from wherever you leave the page.
    It does not re-run steps, so a capability whose outputs were never extracted still reports a failure — with what you did recorded against it.</p>
  </fieldset>`
  }

  <h3>Actions so far</h3>
  <ul class="log">
    ${actions.map((a) => `<li>[${escape(a.timestamp)}] ${escape(a.type)}: ${escape(a.detail)}</li>`).join("") || "<li>(none yet)</li>"}
  </ul>
</body></html>`;
}

/**
 * The manual-action panel: one small form per verb, each showing only the
 * inputs that verb needs.
 *
 * The single generic form this replaces asked for a CSS selector, an action
 * type and a value all at once, and left it to the operator to work out which
 * two of the three applied. Worse, it asked a human staring at a screenshot to
 * author a selector against markup with no ids, no test IDs and no labels.
 *
 * Every option below is read off the live page at render time, so this works
 * on a page and an application this code has never seen — nothing about any
 * target is written down here.
 */
function manualActionPanel(basePath: string, targets: PageTarget[]): string {
  const clickable = targets.filter((t) => t.kind === "click");
  const fillable = targets.filter((t) => t.kind === "fill");
  const selectable = targets.filter((t) => t.kind === "select");

  return `
  <fieldset>
    <legend>Do something on this page</legend>
    ${
      targets.length === 0
        ? `<p class="meta">No controls could be read off this page &mdash; it may still be loading, or its
           controls may be somewhere the reader cannot reach (a nested frame, a canvas, a shadow root).
           Use the raw selector below.</p>`
        : ""
    }
    ${
      clickable.length
        ? `<form method="post" action="${basePath}/action" class="row">
             <input type="hidden" name="type" value="click" />
             <label>Click <select name="pick">${optionsFor(clickable)}</select></label>
             <button type="submit">Click it</button>
           </form>`
        : absent("Nothing on this page is clickable.")
    }
    ${
      fillable.length
        ? `<form method="post" action="${basePath}/action" class="row">
             <input type="hidden" name="type" value="fill" />
             <label>Type into <select name="pick">${optionsFor(fillable)}</select></label>
             <label>the value <input name="value" size="24" /></label>
             <button type="submit">Fill it</button>
           </form>`
        : absent("No text fields on this page — it is a read-only screen. Click through to a form to fill anything.")
    }
    ${
      selectable.length
        ? selectable.map((target) => selectRow(basePath, target)).join("")
        : absent("No dropdowns on this page.")
    }
  </fieldset>

  <fieldset>
    <legend>Go to another page</legend>
    <form method="post" action="${basePath}/action" class="row">
      <input type="hidden" name="type" value="navigate" />
      <input name="value" size="34" placeholder="/menu" />
      <button type="submit">Go</button>
    </form>
    <p class="meta">Only paths on this application are permitted; anything else is refused and recorded.</p>
  </fieldset>

  <details>
    <summary>Raw selector (for anything not listed above)</summary>
    <form method="post" action="${basePath}/action" class="row">
      <select name="type">
        <option value="click">click</option>
        <option value="fill">fill</option>
        <option value="select">select</option>
        <option value="navigate">navigate</option>
      </select>
      <input name="target" placeholder="CSS selector" size="28" />
      <input name="value" placeholder="value / URL" size="20" />
      <button type="submit">Perform action</button>
    </form>
    <p class="meta">A selector matching more than one element is refused rather than guessed at.</p>
  </details>`;
}

/**
 * A select gets its own row, with the option list the page itself declares.
 *
 * A single "pick a control, then pick an option" pair would need the second
 * dropdown to repopulate from the first, which means client-side scripting.
 * This console has none and does not need any: a page has a handful of selects,
 * and one row each is both simpler to build and less to explain.
 *
 * The values are the option's `value` attribute, never its visible text —
 * on this kind of app a share's label embeds a balance that changes whenever
 * money moves, while its value is stable.
 */
function selectRow(basePath: string, target: PageTarget): string {
  const options = (target.options ?? [])
    .map((o) => `<option value="${escape(o.value)}">${escape(o.label)}</option>`)
    .join("");
  return `<form method="post" action="${basePath}/action" class="row">
    <input type="hidden" name="type" value="select" />
    <input type="hidden" name="pick" value="${escape(encodePick(target))}" />
    <label>Set <strong>${escape(labelOf(target))}</strong> to <select name="value">${options}</select></label>
    <button type="submit">Set it</button>
  </form>`;
}

/**
 * Says a verb is unavailable, rather than omitting it.
 *
 * A panel that silently drops two of its three controls on a read-only screen
 * reads as a broken feature, not as an accurate description of the page — and
 * the read-only member record is exactly where a hard failure tends to pause.
 * Naming the absence costs a line and removes the doubt.
 */
function absent(reason: string): string {
  return `<p class="meta" style="margin:6px 0;">&mdash; ${escape(reason)}</p>`;
}

function optionsFor(targets: PageTarget[]): string {
  return targets
    .map((t) => `<option value="${escape(encodePick(t))}">${escape(labelOf(t))}</option>`)
    .join("");
}

/** The frame is part of the identity as far as a reader is concerned. */
function labelOf(target: PageTarget): string {
  return target.frameLabel ? `${target.label}  (in frame: ${target.frameLabel})` : target.label;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

