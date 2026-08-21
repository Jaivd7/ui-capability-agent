import { Router } from "express";
import { safeRouter } from "../shared/express-safety.js";
import {
  checkHumanAction,
  HumanActionError,
  performHumanAction,
  targetsIrreversibleStep,
} from "./action-policy.js";
import { renderConsole } from "./console-view.js";
import { decodeFramePath, decodePick, describePageTargets } from "./page-targets.js";
import type { InterventionRegistry, PendingIntervention } from "./intervention-registry.js";

/**
 * The operator console's routes, mounted per run at `/runs/:runId/escalation`.
 *
 * One router shared by the dashboard and by the CLIs' standalone console, so
 * the surface a human drives during a `npm run replay -- --escalate` is
 * byte-for-byte the one they drive from the dashboard, and the policy in
 * `action-policy.ts` cannot be enforced in one and skipped in the other.
 */
export function escalationRouter(registry: InterventionRegistry): Router {
  const router = safeRouter(Router({ mergeParams: true }));

  const resolvePending = (
    req: { params: Record<string, string> },
    res: { status: (n: number) => { send: (b: string) => unknown } },
  ): PendingIntervention | undefined => {
    const runId = req.params.runId ?? "";
    const pending = registry.get(runId);
    if (!pending) {
      // 410 rather than 404: the run most likely existed and has already been
      // resolved, which is what a stale tab hitting Approve twice looks like.
      // Saying "gone" stops the second click executing anything.
      res.status(410).send("This intervention has already been resolved. You can close this window.");
      return undefined;
    }
    return pending;
  };

  const basePath = (runId: string) => `/runs/${runId}/escalation`;

  /**
   * True when this submission came from a console for a *different*
   * intervention on the same run — a tab left open on an earlier one.
   *
   * Checked only when the field is present. A browser always sends it, so every
   * real stale tab is caught; a scripted caller driving the same HTTP surface
   * (which is how the engine tests act as the operator) simply omits it and is
   * treated as deliberate. Refusing is the honest answer: the question that
   * console was asking has already been answered, and the one on screen now is
   * a different question.
   */
  const staleSubmission = (
    pending: PendingIntervention,
    body: { interventionId?: unknown },
    res: { status: (n: number) => { send: (b: string) => unknown } },
  ): boolean => {
    const submitted = body.interventionId;
    if (typeof submitted !== "string" || submitted === pending.interventionId) return false;
    res
      .status(409)
      .send(
        "This console was showing an earlier intervention for this run, which has already been resolved. " +
          "Reload to see the one that is waiting now.",
      );
    return true;
  };

  router.get("/", async (req, res) => {
    const pending = resolvePending(req, res);
    if (!pending) return;
    const notice = typeof req.query.notice === "string" ? req.query.notice : undefined;
    // Read fresh on every render, never cached: the operator's last action may
    // have navigated, and a picker listing the previous page's controls would
    // be worse than no picker at all. A failure here degrades the console to
    // its raw selector field rather than taking it down — the run is paused
    // and a human is waiting, which is the worst possible moment to 500.
    const targets = await describePageTargets(pending.page).catch(() => []);
    res.send(
      renderConsole(pending.context, pending.actions, {
        basePath: basePath(pending.runId),
        interventionId: pending.interventionId,
        waitingMs: Date.now() - new Date(pending.raisedAt).getTime(),
        currentUrl: pending.page.url(),
        targets,
        ...(notice ? { notice: { tone: "error" as const, message: notice } } : {}),
      }),
    );
  });

  router.get("/screenshot", async (req, res) => {
    const pending = resolvePending(req, res);
    if (!pending) return;
    const buf = await pending.page.screenshot().catch(() => null);
    if (!buf) {
      res.status(503).send("screenshot unavailable");
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.send(buf);
  });

  router.get("/status", (req, res) => {
    const pending = resolvePending(req, res);
    if (!pending) return;
    res.json({ runId: pending.runId, currentUrl: pending.page.url(), actions: pending.actions });
  });

  router.post("/action", async (req, res) => {
    const pending = resolvePending(req, res);
    if (!pending) return;
    const raw = (req.body ?? {}) as { type?: string; target?: string; value?: string; pick?: string; frame?: string; interventionId?: string };
    if (staleSubmission(pending, raw, res)) return;
    // A picked target carries its own selector and frame; the raw selector
    // field carries only a selector, in the main document. Either way what
    // reaches the policy below is the same shape, so the picker is an input
    // method and not a second code path with its own rules.
    const picked = decodePick(raw.pick);
    // A pick carries its own frame; the raw field carries one only if the
    // operator chose it from the frames this render discovered.
    const frame = picked ? picked.frame : decodeFramePath(raw.frame);
    const body = {
      ...raw,
      ...(picked ? { target: picked.selector } : {}),
      frame,
    };

    // Policy first, always. This is the check the console used to skip
    // entirely, which made a paused run a way to drive an authenticated
    // session anywhere the allowlist forbids.
    const decision = checkHumanAction(body, { currentUrl: pending.page.url() }, pending.policy);
    if (!decision.allowed) {
      pending.record({
        timestamp: new Date().toISOString(),
        type: (body.type as "click") ?? "click",
        detail: `refused: ${decision.reason}`,
        ...(body.target ? { target: body.target } : {}),
        blocked: true,
        blockReason: decision.code,
      });
      return res.redirect(303, `${basePath(pending.runId)}?notice=${encodeURIComponent(decision.reason)}`);
    }

    try {
      const { action } = await performHumanAction(pending.page, body, decision.kind, pending.policy);
      const irreversible = targetsIrreversibleStep(body.target ?? "", pending.policy.artifact);
      pending.record({ ...action, ...(irreversible ? { irreversibleTarget: true } : {}) });
      // 303 so refreshing the console cannot repeat the action.
      return res.redirect(303, basePath(pending.runId));
    } catch (err) {
      const message = err instanceof HumanActionError ? err.message : err instanceof Error ? err.message : String(err);
      pending.record({
        timestamp: new Date().toISOString(),
        type: decision.kind,
        detail: `failed: ${message}`,
        ...(body.target ? { target: body.target } : {}),
        blocked: true,
        blockReason: err instanceof HumanActionError ? err.code : "action_failed",
      });
      return res.redirect(303, `${basePath(pending.runId)}?notice=${encodeURIComponent(message)}`);
    }
  });

  router.post("/approve", async (req, res) => {
    const pending = resolvePending(req, res);
    if (!pending) return;
    if (staleSubmission(pending, (req.body ?? {}) as { interventionId?: string }, res)) return;
    if (!pending.executeApprovedStep) {
      return res.status(400).send("No pending step to approve.");
    }
    const refusal = await pending.preResumeCheck?.(pending);
    if (refusal) {
      pending.record({ timestamp: new Date().toISOString(), type: "abort", detail: refusal, blocked: true });
      pending.resolve("aborted");
      return res.redirect(303, `/runs/${pending.runId}`);
    }
    try {
      // Runs the artifact's *own* recorded step through the same executeStep
      // every other step goes through — not a hand-typed selector. That is
      // what makes approval an authorization rather than a re-implementation.
      await pending.executeApprovedStep();
      pending.record({
        timestamp: new Date().toISOString(),
        type: "approve_step",
        detail: pending.context.pendingAction?.description ?? "(pending step)",
      });
      pending.resolve("resumed");
      return res.redirect(303, `/runs/${pending.runId}`);
    } catch (err) {
      return res.status(500).send(`Approved step failed to execute: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  router.post("/reject", (req, res) => {
    const pending = resolvePending(req, res);
    if (!pending) return;
    if (staleSubmission(pending, (req.body ?? {}) as { interventionId?: string }, res)) return;
    pending.record({ timestamp: new Date().toISOString(), type: "reject", detail: "operator rejected the pending action" });
    pending.resolve("aborted");
    res.redirect(303, `/runs/${pending.runId}`);
  });

  router.post("/resume", async (req, res) => {
    const pending = resolvePending(req, res);
    if (!pending) return;
    if (staleSubmission(pending, (req.body ?? {}) as { interventionId?: string }, res)) return;
    const refusal = await pending.preResumeCheck?.(pending);
    if (refusal) {
      pending.record({ timestamp: new Date().toISOString(), type: "abort", detail: refusal, blocked: true });
      pending.resolve("aborted");
      return res.redirect(303, `/runs/${pending.runId}`);
    }
    pending.record({ timestamp: new Date().toISOString(), type: "resume", detail: "operator signaled resume" });
    pending.resolve("resumed");
    return res.redirect(303, `/runs/${pending.runId}`);
  });

  router.post("/abort", (req, res) => {
    const pending = resolvePending(req, res);
    if (!pending) return;
    if (staleSubmission(pending, (req.body ?? {}) as { interventionId?: string }, res)) return;
    pending.record({ timestamp: new Date().toISOString(), type: "abort", detail: "operator signaled abort" });
    pending.resolve("aborted");
    res.redirect(303, `/runs/${pending.runId}`);
  });

  return router;
}
