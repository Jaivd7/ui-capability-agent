import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Page } from "playwright";
import type { RunLogger } from "../logging/logger.js";
import type { EscalationHandler, EscalationOutcome, HumanAction, InterventionContext } from "./types.js";

export interface RaiseInterventionOptions {
  page: Page;
  context: InterventionContext;
  logger: RunLogger;
  evidenceDir: string;
  /** irreversible_confirmation only: runs the actual pending step when the operator clicks Approve. */
  executeApprovedStep?: () => Promise<void>;
}

export interface InterventionResult {
  outcome: EscalationOutcome;
  screenshotPath: string;
}

/**
 * Pauses automation, exposes the *same* live Playwright page to a bare
 * HTTP console a human (or, in this project's tests, a script hitting the
 * same endpoints a human's browser would) operates, and doesn't resolve
 * until the operator sends a terminal signal (resume/abort). "Same
 * session, not a fresh one" is not a description here — the console's
 * every action handler closes over the identical `page` reference the
 * automation was just driving, so there is only ever one browser context
 * for the whole run, control just changes who's issuing commands to it.
 *
 * A full real-time co-browsing console (pixel-level click-through-
 * screenshot control) is explicitly out of scope per the brief — this is
 * the "bare/mock operator surface" it sanctions instead: the operator sees
 * a screenshot and context, and acts through a small fixed vocabulary of
 * commands (click/fill/select/navigate by CSS selector, or approve/reject
 * for a pending irreversible step) rather than driving the page pixel by
 * pixel. What's real is the session identity and the control-transfer
 * mechanism, not the fidelity of the operator's input method.
 */
export async function raiseIntervention(opts: RaiseInterventionOptions): Promise<InterventionResult> {
  const { page, context, logger, evidenceDir } = opts;
  const raisedAt = new Date().toISOString();
  const actions: HumanAction[] = [];

  mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = join(evidenceDir, `${context.runId}.escalation.png`);
  await page.screenshot({ path: screenshotPath }).catch(() => undefined);

  logger.log({
    type: "escalation_raised",
    runId: context.runId,
    kind: context.kind,
    reason: context.reason,
    currentUrl: context.currentUrl,
    currentStepId: context.currentStepId,
    screenshotPath,
  });

  const app = express();
  app.use(express.urlencoded({ extended: true }));

  app.get("/", (_req, res) => {
    res.send(renderConsole(context, actions));
  });

  app.get("/screenshot", async (_req, res) => {
    const buf = await page.screenshot().catch(() => null);
    if (!buf) {
      res.status(503).send("screenshot unavailable");
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.send(buf);
  });

  app.get("/status", (_req, res) => {
    res.json({ currentUrl: page.url(), actions });
  });

  return new Promise<InterventionResult>((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      const consoleUrl = `http://localhost:${port}/`;
      logger.log({ type: "escalation_console_started", runId: context.runId, consoleUrl });
      console.log(`\n>>> ESCALATION: automation paused. Operator console: ${consoleUrl}\n`);

      function recordAction(type: HumanAction["type"], detail: string): void {
        const action: HumanAction = { timestamp: new Date().toISOString(), type, detail };
        actions.push(action);
        logger.log({ type: "human_action", runId: context.runId, actionType: type, detail });
      }

      function finish(decision: "resumed" | "aborted"): void {
        logger.log({ type: "escalation_resolved", runId: context.runId, decision, actionCount: actions.length });
        server.close();
        resolve({ outcome: { decision, actions }, screenshotPath });
      }

      app.post("/action", async (req, res) => {
        const { type, target, value } = req.body as { type?: string; target?: string; value?: string };
        try {
          switch (type) {
            case "click":
              if (!target) throw new Error("target (CSS selector) required");
              await page.click(target, { timeout: 5000 });
              recordAction("click", `click "${target}"`);
              break;
            case "fill":
              if (!target) throw new Error("target (CSS selector) required");
              await page.fill(target, value ?? "", { timeout: 5000 });
              recordAction("fill", `fill "${target}" = "${value ?? ""}"`);
              break;
            case "select":
              if (!target) throw new Error("target (CSS selector) required");
              await page.selectOption(target, value ?? "", { timeout: 5000 });
              recordAction("select", `select "${target}" = "${value ?? ""}"`);
              break;
            case "navigate":
              if (!value) throw new Error("value (URL/path) required");
              await page.goto(new URL(value, page.url()).toString(), { timeout: 10000 });
              recordAction("navigate", `navigate to "${value}"`);
              break;
            default:
              throw new Error(`unknown action type "${type}"`);
          }
          res.redirect("/");
        } catch (err) {
          res.status(400).send(`Action failed: ${err instanceof Error ? err.message : String(err)}. <a href="/">Back</a>`);
        }
      });

      app.post("/approve", async (_req, res) => {
        if (!opts.executeApprovedStep) {
          res.status(400).send("No pending step to approve. <a href=\"/\">Back</a>");
          return;
        }
        try {
          await opts.executeApprovedStep();
          recordAction("approve_step", context.pendingAction?.description ?? "(pending step)");
          finish("resumed");
          res.send("Approved and executed. You may close this window.");
        } catch (err) {
          res.status(500).send(`Approved step failed to execute: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      app.post("/reject", (_req, res) => {
        recordAction("reject", "operator rejected the pending action");
        finish("aborted");
        res.send("Rejected. You may close this window.");
      });

      app.post("/resume", (_req, res) => {
        recordAction("resume", "operator signaled resume");
        finish("resumed");
        res.send("Resuming automation. You may close this window.");
      });

      app.post("/abort", (_req, res) => {
        recordAction("abort", "operator signaled abort");
        finish("aborted");
        res.send("Aborted. You may close this window.");
      });
    });
  });
}

function renderConsole(ctx: InterventionContext, actions: HumanAction[]): string {
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
  <p class="meta">
    Current URL: ${escape(ctx.currentUrl)}<br/>
    ${ctx.currentStepId ? `Step: ${escape(ctx.currentStepId)} — ${escape(ctx.currentStepDescription ?? "")}<br/>` : ""}
    ${ctx.goal ? `Goal: ${escape(ctx.goal)}<br/>` : ""}
  </p>
  <img src="/screenshot" alt="current page state" />

  ${
    isConfirmation
      ? `
  <fieldset>
    <legend>Pending irreversible action</legend>
    <p>${escape(ctx.pendingAction?.description ?? "")}</p>
    <p class="meta">${escape(ctx.pendingAction?.locatorSummary ?? "")}</p>
    <form class="inline" method="post" action="/approve"><button class="danger" type="submit">Approve &amp; Execute</button></form>
    <form class="inline" method="post" action="/reject"><button class="safe" type="submit">Reject</button></form>
  </fieldset>`
      : `
  <fieldset>
    <legend>Manual action</legend>
    <form method="post" action="/action">
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
    <form class="inline" method="post" action="/resume"><button class="safe" type="submit">Resume Automation</button></form>
    <form class="inline" method="post" action="/abort"><button class="danger" type="submit">Abort Run</button></form>
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

/**
 * Adapts `raiseIntervention` to the `EscalationHandler` shape discovery and
 * replay both accept, closing over the one `page`/`logger`/`evidenceDir`
 * for a run so every call site (guardrail-blocked step, stuck discovery,
 * unrecovered hard failure) just needs the context, not the plumbing.
 */
export function createEscalationHandler(page: Page, logger: RunLogger, evidenceDir: string): EscalationHandler {
  return async (ctx, executeApprovedStep) => {
    const { outcome } = await raiseIntervention({
      page,
      context: ctx,
      logger,
      evidenceDir,
      ...(executeApprovedStep !== undefined ? { executeApprovedStep } : {}),
    });
    return outcome;
  };
}
