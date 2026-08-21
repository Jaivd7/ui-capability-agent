import type { HumanAction, InterventionContext, InterventionKind } from "./types.js";
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
   * Identifies *this* intervention, submitted with every form.
   *
   * A run can escalate more than once and both consoles live at the same URL,
   * so a tab left open on the first one could otherwise resolve the second.
   * Carrying the id turns that into a refusal the operator can read.
   */
  interventionId?: string;
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
  /** Outputs the operator has already read off the page this intervention. */
  captured?: Record<string, string | number>;
}

export function renderConsole(
  ctx: InterventionContext,
  actions: HumanAction[],
  opts: ConsoleViewOptions,
): string {
  const basePath = opts.basePath;
  const stamp = opts.interventionId
    ? `<input type="hidden" name="interventionId" value="${escape(opts.interventionId)}" />`
    : "";
  const isConfirmation = ctx.kind === "irreversible_confirmation";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Operator Console</title>
<style>
  /*
   * Hand-written CSS, not the dashboard's Tailwind.
   *
   * This document is served standalone to a CLI escalation as well as being
   * framed by the run page, so it cannot depend on the console's stylesheet
   * being present. The tokens below are the Ledger palette copied by value —
   * duplication, but the alternative is a build dependency between the
   * escalation package and the dashboard's view layer for the sake of six
   * colours, on the one surface that has to work when everything else is on
   * fire. Keep in step with views/theme.ts by hand.
   */
  :root {
    --paper: #FAFAF9; --surface: #FFFFFF; --rule: #E7E5E4;
    --ink: #1C1917; --muted: #78716C; --accent: #0F4C5C;
  }
  * { box-sizing: border-box; }
  body {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
    max-width: 760px; margin: 0 auto; padding: 20px 16px 32px;
    color: var(--ink); background: var(--paper); font-size: 14px; line-height: 1.5;
  }
  .banner {
    background: #FFFBEB; border: 1px solid #FCD34D; padding: 12px 14px;
    border-radius: 8px; margin-bottom: 16px; color: #78350F;
  }
  .meta { color: var(--muted); font-size: 12px; }
  img { max-width: 100%; border: 1px solid var(--rule); border-radius: 8px; margin: 12px 0; background: var(--surface); }
  button {
    padding: 7px 13px; margin-right: 8px; border-radius: 6px; font: inherit; font-weight: 500;
    font-size: 13px; border: 1px solid var(--rule); background: var(--surface);
    color: var(--ink); cursor: pointer; transition: background .12s, border-color .12s;
  }
  button:hover { border-color: #A8A29E; }
  .danger { background: #FEF2F2; border-color: #FCA5A5; color: #991B1B; }
  .danger:hover { background: #FEE2E2; border-color: #F87171; }
  .safe { background: var(--accent); border-color: var(--accent); color: #fff; }
  .safe:hover { background: #0B3A46; border-color: #0B3A46; }
  form.inline { display: inline; }
  fieldset { margin: 16px 0; border: 1px solid var(--rule); border-radius: 8px; padding: 12px 14px; background: var(--surface); }
  legend { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 0 4px; }
  input, select {
    padding: 6px 8px; margin: 2px; font: inherit; font-size: 13px;
    border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink);
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  ul.log { font-size: 12px; color: var(--muted); padding-left: 18px; }
  form.row { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  form.row label { display: flex; gap: 6px; align-items: center; }
  select { max-width: 380px; }
  details { margin: 16px 0; }
  summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  code, .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace; font-size: 12px; }

  /*
   * The guidance block. The console used to show only the engine's raw failure
   * string, which says what broke but never why a *human* was called or what
   * handing back will do — so an operator's first question had no answer on the
   * page. Each kind gets those three answers explicitly; the raw string stays,
   * demoted to the technical line a debugger still needs.
   */
  .why { border: 1px solid var(--rule); border-left: 3px solid var(--accent); background: var(--surface);
         border-radius: 8px; padding: 12px 14px; margin: 16px 0; }
  .why h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
            color: var(--muted); margin: 0 0 8px; }
  .why dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
  .why dt { font-weight: 600; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .why dd { margin: 0; font-size: 13px; }
  .why .raw { margin: 10px 0 0; padding-top: 8px; border-top: 1px dashed var(--rule); }

  /*
   * One row per verb, always all four, present whether or not this page can
   * take them. The panel this replaces showed an enabled Click control and put
   * fill/select into muted prose about their own absence, with navigate in a
   * separate box that never named itself as an action — so the console read as
   * "this thing clicks". Naming every verb, and saying in plain words what each
   * one does to the page, is the difference between a vocabulary and a button.
   */
  .verb { padding: 10px 0; border-top: 1px solid var(--rule); }
  .verb:first-of-type { border-top: 0; padding-top: 2px; }
  .verb-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .verb-name { font-weight: 600; font-size: 13px; }
  .verb-what { color: var(--muted); font-size: 12px; }
  .verb-off { margin: 0; color: var(--muted); font-size: 12px; font-style: italic; }
  .captured { margin: 0 0 6px; color: #065F46; font-size: 12px; }
</style></head>
<body>
  <div class="banner">
    <strong>Automation paused — intervention requested</strong><br/>
    Run: ${escape(ctx.runId)} (${escape(ctx.capabilityId)})
  </div>
  ${
    opts.notice
      ? `<div class="banner" style="background:${opts.notice.tone === "error" ? "#ffe0e0" : "#fff3cd"};border-color:${
          opts.notice.tone === "error" ? "#d33" : "#ffcc00"
        }"><strong>Refused:</strong> ${escape(opts.notice.message)}</div>`
      : ""
  }
  ${guidancePanel(ctx)}
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
    <form class="inline" method="post" action="${basePath}/approve">${stamp}<button class="danger" type="submit">Approve &amp; Execute</button></form>
    <form class="inline" method="post" action="${basePath}/reject">${stamp}<button class="safe" type="submit">Reject</button></form>
  </fieldset>`
      : `
  ${missingOutputsPanel(basePath, ctx, opts.targets ?? [], opts.captured ?? {}, stamp)}
  ${manualActionPanel(basePath, opts.targets ?? [], stamp)}
  <fieldset>
    <legend>When you are done</legend>
    <form class="inline" method="post" action="${basePath}/resume">${stamp}<button class="safe" type="submit">Hand back to automation</button></form>
    <form class="inline" method="post" action="${basePath}/abort">${stamp}<button class="danger" type="submit">Abort run</button></form>
    <p class="meta">${escape(handBackNote(ctx.kind))}</p>
  </fieldset>`
  }

  <h3>Actions so far</h3>
  <ul class="log">
    ${actions.map((a) => `<li>[${escape(a.timestamp)}] ${escape(a.type)}: ${escape(a.detail)}</li>`).join("") || "<li>(none yet)</li>"}
  </ul>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Why you are here
// ---------------------------------------------------------------------------

interface Guidance {
  /** What stopped the run, and — the part that was missing — *who* decided to stop it. */
  what: string;
  /** What this operator is actually being asked to contribute. */
  askedFor: string;
}

/**
 * Plain-language guidance, chosen by intervention kind.
 *
 * The distinction worth drawing explicitly is *who* raised the escalation,
 * because only one of the three is the model asking for help. Replay runs with
 * no model in the loop at all, and an irreversible confirmation is the
 * guardrail policy refusing to act unattended — neither is a model deciding it
 * is stuck. An operator who assumes "the AI got confused" will go looking for
 * the wrong thing on two of these three screens.
 */
function guidanceFor(kind: InterventionKind): Guidance {
  switch (kind) {
    case "discovery_stuck":
      return {
        what:
          "The model was exploring this application to record a new capability and could not reach the goal below. " +
          "This is the one escalation the model itself raises.",
        askedFor:
          "Drive the page to where the model was trying to get, or abort so the goal can be rewritten. " +
          "What you do here is recorded as part of the run.",
      };
    case "replay_hard_failure":
      return {
        what:
          "A recorded step stopped working against the live page. No model is involved in replay — this is the " +
          "recording and the application disagreeing, usually because the page moved or the data changed.",
        askedFor:
          "Get the page into the state the capability expects, then hand back. A human can normally tell in seconds " +
          "whether the recording is stale or the page is simply in an unexpected state.",
      };
    case "irreversible_confirmation":
      return {
        what:
          "Policy stopped this step, not the model. It is marked irreversible, and the guardrail will not let it " +
          "run unattended without a person authorizing it.",
        askedFor:
          "Decide whether this action should happen. Approving runs the step exactly as recorded — you are " +
          "authorizing it, not re-typing it.",
      };
  }
}

/** What "Hand back to automation" will actually do, which differs by kind and is easy to guess wrong. */
function handBackNote(kind: InterventionKind): string {
  if (kind === "discovery_stuck") {
    return (
      "Handing back ends the run as completed-with-help. Nothing is re-verified, so hand back only if the goal " +
      "was actually reached; otherwise abort, which records the same actions against an honest failure."
    );
  }
  return (
    "Handing back re-checks the capability's own checkpoints from wherever you leave the page. It does not re-run " +
    "steps, so anything still listed above as outstanding has to be read off the page first — otherwise the run " +
    "reports a failure, with what you did recorded against it."
  );
}

function guidancePanel(ctx: InterventionContext): string {
  const g = guidanceFor(ctx.kind);
  const outstanding = ctx.missingOutputs ?? [];
  // Named up front rather than left to the panel below, because on a failed
  // extract this *is* the recovery — "get the page into the right state" is
  // advice for a different failure, and following it alone ends in the same
  // missing-outputs refusal.
  const askedFor =
    outstanding.length > 0
      ? `${g.askedFor} This run has not captured ${outstanding.map((o) => o.name).join(", ")}, ` +
        `which it has to before it can succeed — read ${outstanding.length === 1 ? "it" : "them"} off the page below.`
      : g.askedFor;
  return `
  <div class="why">
    <h2>Why you are seeing this</h2>
    <dl>
      <dt>What happened</dt><dd>${escape(g.what)}</dd>
      <dt>What you can do</dt><dd>${escape(askedFor)}</dd>
    </dl>
    <p class="meta raw"><strong>Reported by the engine:</strong> <span class="mono">${escape(ctx.reason)}</span></p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Supplying the outputs the run never captured
// ---------------------------------------------------------------------------

/**
 * The outputs this capability promised and has not delivered, each offering the
 * page's own readable values.
 *
 * This is the panel that makes handing back able to succeed. Before it, the
 * console's fine print told the operator that a capability whose outputs were
 * never extracted would still report a failure — accurate, and a dead end,
 * since nothing on the page let them do anything about it. The commonest
 * replay failure is an extract step whose locator drifted, so the commonest
 * rescue was the one that could not work.
 *
 * The operator picks a value, not a selector, and never types the value itself:
 * the dropdown shows the text as it appears on the page, so what they are
 * confirming is "this is the right cell". What lands in `outputs` was read by
 * the same code a recorded extract uses.
 */
function missingOutputsPanel(
  basePath: string,
  ctx: InterventionContext,
  targets: PageTarget[],
  captured: Record<string, string | number>,
  stamp: string,
): string {
  const missing = ctx.missingOutputs ?? [];
  if (missing.length === 0) return "";
  const readable = targets.filter((t) => t.kind === "text");

  const rows = missing
    .map((output) => {
      const already = captured[output.name];
      if (already !== undefined) {
        return `<div class="verb">
          <div class="verb-head">
            <span class="verb-name">${escape(output.name)}</span>
            <span class="verb-what">${escape(output.type)}</span>
          </div>
          <p class="captured">&#10003; captured as <span class="mono">${escape(String(already))}</span>
          &mdash; pick again below to replace it.</p>
          ${readable.length ? pickForm(basePath, output.name, readable, stamp, "Replace") : ""}
        </div>`;
      }
      return `<div class="verb">
        <div class="verb-head">
          <span class="verb-name">${escape(output.name)}</span>
          <span class="verb-what">${escape(output.type)}${
            output.description ? ` &mdash; ${escape(output.description)}` : ""
          }</span>
        </div>
        ${
          readable.length
            ? pickForm(basePath, output.name, readable, stamp, "Capture it")
            : absent("No readable values could be found on this page. Navigate to the screen that shows this value.")
        }
      </div>`;
    })
    .join("");

  return `<fieldset>
    <legend>Outputs this run still owes</legend>
    <p class="meta" style="margin:0 0 8px;">Handing back checks the capability's declared outputs, so these have to be
    read before this run can succeed. Pick the value as it appears on the page &mdash; the console reads it the same
    way the recorded step would have, and you never type it yourself.</p>
    ${rows}
  </fieldset>`;
}

function pickForm(basePath: string, outputName: string, readable: PageTarget[], stamp: string, verb: string): string {
  return `<form method="post" action="${basePath}/extract" class="row">
    ${stamp}<input type="hidden" name="outputName" value="${escape(outputName)}" />
    <label>Read from <select name="pick">${optionsFor(readable)}</select></label>
    <button type="submit">${escape(verb)}</button>
  </form>`;
}

// ---------------------------------------------------------------------------
// What a human can do to the page
// ---------------------------------------------------------------------------

/**
 * The manual-action panel: every verb the console has, one row each, in one
 * place.
 *
 * Three things were wrong with the panel this replaces. It rendered `navigate`
 * in a *separate* fieldset that never used the word — so on a read-only screen,
 * where fill and select are both unavailable, the console appeared to offer
 * exactly one verb. The unavailable verbs were reported as muted sentences
 * about their own absence rather than as named-but-disabled members of a set.
 * And nothing anywhere said what the verbs *mean*, which leaves "click" and
 * "go to" looking like two words for the same thing when they are the two
 * genuinely different ways to move: through the page, or around it.
 *
 * Every option below is still read off the live page at render time, so this
 * works on a page and an application this code has never seen — nothing about
 * any target is written down here.
 */
function manualActionPanel(basePath: string, targets: PageTarget[], stamp: string): string {
  const clickable = targets.filter((t) => t.kind === "click");
  const fillable = targets.filter((t) => t.kind === "fill");
  const selectable = targets.filter((t) => t.kind === "select");

  return `
  <fieldset>
    <legend>What you can do to this page</legend>
    ${
      targets.length === 0
        ? `<p class="meta">No controls could be read off this page &mdash; it may still be loading, or its
           controls may be somewhere the reader cannot reach (a nested frame, a canvas, a shadow root).
           Use the raw selector below.</p>`
        : ""
    }
    ${verb(
      "Click",
      "press a link or button that is already on this page",
      clickable.length
        ? `<form method="post" action="${basePath}/action" class="row">
             ${stamp}<input type="hidden" name="type" value="click" />
             <label>Which one <select name="pick">${optionsFor(clickable)}</select></label>
             <button type="submit">Click it</button>
           </form>`
        : absent("Nothing on this page is clickable."),
    )}
    ${verb(
      "Fill",
      "type a value into a text field on this page",
      fillable.length
        ? `<form method="post" action="${basePath}/action" class="row">
             ${stamp}<input type="hidden" name="type" value="fill" />
             <label>Type into <select name="pick">${optionsFor(fillable)}</select></label>
             <label>the value <input name="value" size="24" /></label>
             <button type="submit">Fill it</button>
           </form>`
        : absent("No text fields on this page — it is a read-only screen. Click through to a form to fill anything."),
    )}
    ${verb(
      "Select",
      "choose one of the options a dropdown on this page offers",
      selectable.length
        ? selectable.map((target) => selectRow(basePath, target, stamp)).join("")
        : absent("No dropdowns on this page."),
    )}
    ${verb(
      "Go to",
      "jump straight to another page of this application, without clicking your way there",
      `<form method="post" action="${basePath}/action" class="row">
         ${stamp}<input type="hidden" name="type" value="navigate" />
         <input name="value" size="34" placeholder="/menu" />
         <button type="submit">Go</button>
       </form>
       <p class="meta" style="margin:6px 0 0;">Only paths on this application are permitted; anything else is refused and recorded.</p>`,
    )}
  </fieldset>

  <details>
    <summary>Raw selector (for anything not listed above)</summary>
    <form method="post" action="${basePath}/action" class="row">
      ${stamp}<select name="type">
        <option value="click">click</option>
        <option value="fill">fill</option>
        <option value="select">select</option>
        <option value="navigate">navigate</option>
      </select>
      <input name="target" placeholder="CSS selector" size="28" />
      <input name="value" placeholder="value / URL" size="20" />
      ${frameChooser(targets)}
      <button type="submit">Perform action</button>
    </form>
    <p class="meta">A selector matching more than one element is refused rather than guessed at.</p>
  </details>`;
}

/** One verb: its name, what it does to the page, and either its control or why it is unavailable here. */
function verb(name: string, what: string, body: string): string {
  return `<div class="verb">
    <div class="verb-head"><span class="verb-name">${escape(name)}</span><span class="verb-what">${escape(what)}</span></div>
    ${body}
  </div>`;
}

/**
 * Which document a raw selector applies to.
 *
 * The escape hatch used to post a selector and nothing else, so it always
 * resolved against the main document — while `page-targets.ts` claimed a
 * control too deep for the picker was "still reachable through the raw selector
 * escape hatch, which is exactly what that escape hatch is for". It was not:
 * CSS cannot cross a frame boundary, so on the nested framesets this project
 * exists for, the picker missed the control and the fallback could not address
 * it either. Two mechanisms blind to the same case.
 *
 * The frames offered are the ones the picker already discovered on this render,
 * so this adds a way to *aim* at a known frame rather than a way to name an
 * arbitrary one. It is rendered only when the page actually has frames.
 */
function frameChooser(targets: PageTarget[]): string {
  const byLabel = new Map<string, PageTarget["frame"]>();
  for (const t of targets) {
    if (t.frameLabel && t.frame.length > 0 && !byLabel.has(t.frameLabel)) byLabel.set(t.frameLabel, t.frame);
  }
  if (byLabel.size === 0) return "";
  const options = [...byLabel.entries()]
    .map(([label, frame]) => `<option value="${escape(JSON.stringify(frame))}">${escape(label)}</option>`)
    .join("");
  return `<label>in <select name="frame"><option value="">the main document</option>${options}</select></label>`;
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
function selectRow(basePath: string, target: PageTarget, stamp: string): string {
  const options = (target.options ?? [])
    .map((o) => `<option value="${escape(o.value)}">${escape(o.label)}</option>`)
    .join("");
  return `<form method="post" action="${basePath}/action" class="row" style="margin:4px 0;">
    ${stamp}<input type="hidden" name="type" value="select" />
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
  return `<p class="verb-off">${escape(reason)}</p>`;
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
