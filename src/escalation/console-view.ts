import type { HumanAction, InterventionContext } from "./types.js";

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
  /** How long this run has been waiting, so an operator can see they are on a clock. */
  waitingMs: number;
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
    Current URL: ${escape(ctx.currentUrl)}<br/>
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
  <fieldset>
    <legend>Manual action</legend>
    <form method="post" action="${basePath}/action">
      <select name="type">
        <option value="click">click</option>
        <option value="fill">fill</option>
        <option value="select">select</option>
        <option value="navigate">navigate</option>
      </select>
      <input name="target" placeholder="CSS selector (click/fill/select)" size="28" />
      <input name="value" placeholder="value / URL (fill/select/navigate)" size="24" />
      <button type="submit">Perform Action</button>
    </form>
  </fieldset>
  <fieldset>
    <legend>When done</legend>
    <form class="inline" method="post" action="${basePath}/resume"><button class="safe" type="submit">Resume Automation</button></form>
    <form class="inline" method="post" action="${basePath}/abort"><button class="danger" type="submit">Abort Run</button></form>
  </fieldset>`
  }

  <h3>Actions so far</h3>
  <ul class="log">
    ${actions.map((a) => `<li>[${escape(a.timestamp)}] ${escape(a.type)}: ${escape(a.detail)}</li>`).join("") || "<li>(none yet)</li>"}
  </ul>
</body></html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

