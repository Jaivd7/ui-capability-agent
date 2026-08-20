import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isKnownApp, isKnownRole, listRoles } from "../../apps/index.js";
import type { CapabilityArtifact, Step } from "../../artifact/schema.js";
import type { EscalationHandler, HumanIntervention, InterventionContext } from "../../escalation/types.js";
import { loadGuardrailsConfig } from "../../guardrails/config.js";
import { evaluateGuardrails } from "../../guardrails/policy.js";
import { redactFields, redactValue } from "../../guardrails/redact.js";
import { createRunLogger, type LogEvent, type RunLogger } from "../../logging/logger.js";
import { ParamValidationError, validateInvocation } from "../../replay/coerce.js";
import { runReplay, type ReplayOptions } from "../../replay/engine.js";
import type { ReplayResult } from "../../replay/result.js";
import {
  RunnerBusyError,
  statusFromResult,
  type Catalog,
  type EscalationSummary,
  type InvokeAccepted,
  type InvokeRequest,
  type LiveView,
  type ParamValue,
  type RunExecutor,
  type RunRecord,
  type RunRegistry,
} from "../types.js";
import type { BrowserPool, RunSession } from "./browser-pool.js";

/**
 * The write path: turn an HTTP invoke into a background replay, and make the
 * poll contract *total* — every accepted invoke ends up as a terminal record
 * with evidence on disk, whatever went wrong.
 *
 * This mirrors `src/replay/cli.ts` step for step (session bootstrap, guardrail
 * hook, evidence write, redaction-on-persist). Where it diverges it is because
 * a CLI can answer a problem by printing to stderr and calling `process.exit`,
 * and a server has to answer it as *state a caller can poll*.
 */

/** The capability id isn't in the catalog. Distinct from a bad *param*: the API maps this to 404, not 400. */
export class CapabilityNotFoundError extends Error {
  constructor(readonly capabilityId: string) {
    super(`No capability "${capabilityId}".`);
    this.name = "CapabilityNotFoundError";
  }
}

/** Exactly `runReplay`'s shape. Injectable so the executor's control flow is testable without a browser. */
export type ReplayFn = (opts: ReplayOptions) => Promise<ReplayResult>;

export interface RunExecutorDeps {
  catalog: Catalog;
  runs: RunRegistry;
  pool: BrowserPool;
  /**
   * Builds the escalation handler for a run, or returns undefined to run
   * unattended. A factory rather than a handler because the console needs the
   * run's identity and its evidence directory to write the operator's
   * screenshots and actions alongside the rest of the run's evidence.
   */
  escalate?: (ctx: {
    runId: string;
    evidenceDir: string;
    page: import("playwright").Page;
    logger: RunLogger;
    app: string;
    artifact: CapabilityArtifact;
  }) => EscalationHandler | undefined;
  /**
   * Where the run's page is published so the dashboard can screenshot it while
   * it works. Optional: a server composed without one simply has no live view,
   * and every other path is unaffected.
   */
  liveView?: LiveView;
  /** Defaults to the real engine; overridden in tests. */
  replay?: ReplayFn;
  /** Defaults to `<cwd>/evidence`. Overridden in tests so they don't write into the repo. */
  evidenceRoot?: string;
}

const DEFAULT_EVIDENCE_SUBDIR = "replay-run";

export function createRunExecutor(deps: RunExecutorDeps): RunExecutor {
  const replay: ReplayFn = deps.replay ?? runReplay;
  const evidenceRoot = deps.evidenceRoot ?? join(process.cwd(), "evidence");

  /**
   * The single in-flight run's background task, for `drain`. Deliberately not
   * the single-flight lock — that lives in the registry (`runs.active()`), so
   * that the 409 body can name the run that's holding it.
   */
  let inFlight: Promise<void> | undefined;

  async function invoke(req: InvokeRequest): Promise<InvokeAccepted> {
    // 1. Resolve. A 404 must not cost a browser context or a directory.
    const entry = deps.catalog.get(req.capabilityId);
    if (!entry) throw new CapabilityNotFoundError(req.capabilityId);
    const artifact = entry.artifact;
    const app = artifact.target.app;

    // 2. Coerce/validate. ParamValidationError carries every bad field, and is
    //    left to propagate: the API layer owns the decision that this is a 400.
    const { params, warnings } = validateInvocation(artifact, req.params);

    // The role is not a declared param, but a typo'd one is the same class of
    // caller mistake and deserves the same fast, field-shaped rejection rather
    // than a PERMISSION_DENIED ten seconds into the flow. Only checked when the
    // app is known: an artifact naming an app with no adapter is a *server*
    // misconfiguration, and rule 4 below says that becomes a failed run with
    // evidence, not a 400.
    const role = req.role ?? entry.requiredRole ?? (isKnownApp(app) ? listRoles(app)[0] : undefined) ?? "";
    if (isKnownApp(app) && !isKnownRole(app, role)) {
      throw new ParamValidationError([
        { name: "role", problem: `is not a role of app "${app}". Known roles: ${listRoles(app).join(", ")}` },
      ]);
    }

    // 3. Single-flight. One browser, one target, one operator watching: two
    //    concurrent runs would interleave in the evidence and race on the
    //    target's own state. A run parked in an escalation holds this lock for
    //    as long as the human takes — intended, and the reason the error
    //    carries the active run: a caller that gets a 409 can go look at why.
    const active = deps.runs.active();
    if (active) throw new RunnerBusyError(active);

    // 4. Allocate the id and publish the record BEFORE anything that can fail
    //    slowly (browser launch, login, `${param}` materialization). This is
    //    what makes the poll contract total: the caller is handed a runId, and
    //    a runId that isn't in the registry yet — or never arrives because
    //    bootstrap threw — is a hole in it. A target that's down becomes a
    //    `failed` run with a real JSONL log, not a 500 with nothing on disk.
    //
    //    Everything from here to `runs.create` is synchronous on purpose: no
    //    `await` may split the `active()` check from the `create()` that closes
    //    the lock, or two invokes could both pass the check.
    const runId = `${artifact.id}-${Date.now()}`;
    const evidenceDirName = req.evidenceDir ?? DEFAULT_EVIDENCE_SUBDIR;
    const evidenceOutDir = join(evidenceRoot, app, evidenceDirName);
    // `createRunLogger` mkdirs and is otherwise inert, so the directory and the
    // log path exist before the record does — the record's `logPath` points at
    // something real from the first poll, even if the run dies during bootstrap.
    const baseLogger = createRunLogger(runId, evidenceOutDir);

    const startedAt = new Date().toISOString();
    const record: RunRecord = {
      runId,
      kind: "replay",
      capabilityId: artifact.id,
      capabilityVersion: artifact.version,
      app,
      role,
      status: "running",
      escalated: false,
      startedAt,
      baseUrl: artifact.target.baseUrl,
      evidenceDir: evidenceDirName,
      logPath: baseLogger.filePath,
      updatedAt: startedAt,
      params: redactFields(params, sensitiveInputNames(artifact)),
      progress: { stepsTotal: artifact.steps.length, stepsCompleted: 0 },
    };
    deps.runs.create(record);

    // 5. Accept now, run later. The engine's own timescale is tens of seconds
    //    and includes human-paced escalations; an HTTP request cannot wait on
    //    that. `execute` is written so it never rejects (see rule 9), so this
    //    dangling promise cannot become an unhandled rejection.
    inFlight = execute({ runId, artifact, params, role, evidenceOutDir, baseLogger, escalateEnabled: req.escalate ?? true })
      .finally(() => {
        inFlight = undefined;
      });

    return {
      runId,
      capabilityId: artifact.id,
      status: "running",
      statusUrl: `/api/runs/${runId}/status`,
      runUrl: `/runs/${runId}`,
      warnings,
    };
  }

  interface ExecuteCtx {
    runId: string;
    artifact: CapabilityArtifact;
    params: Record<string, ParamValue>;
    role: string;
    evidenceOutDir: string;
    baseLogger: RunLogger;
    escalateEnabled: boolean;
  }

  async function execute(ctx: ExecuteCtx): Promise<void> {
    const { runId, artifact, evidenceOutDir } = ctx;
    const stepsById = new Map<string, Step>(artifact.steps.map((s) => [s.id, s]));

    // Tracked off the log stream rather than by threading a progress callback
    // through the engine: the engine already emits exactly these facts, and a
    // second reporting channel would be a second thing to keep in sync.
    let sawRunStart = false;
    let stepsCompleted = 0;
    let lastStep: Step | undefined;

    const logger = observeLog(ctx.baseLogger, (event) => {
      if (event.type === "run_start") sawRunStart = true;
      if (event.type !== "step_result") return;
      const step = typeof event["stepId"] === "string" ? stepsById.get(event["stepId"]) : undefined;
      if (step) lastStep = step;
      if (event["ok"] === true) stepsCompleted += 1;
      deps.runs.update(runId, {
        progress: {
          stepsTotal: artifact.steps.length,
          stepsCompleted,
          ...(lastStep ? { currentStepId: lastStep.id, currentStepDescription: lastStep.description } : {}),
        },
        updatedAt: new Date().toISOString(),
      });
    });

    let session: RunSession | undefined;
    let result: ReplayResult;

    try {
      // A run that reaches the browser at all is the common case; a run that
      // doesn't (target down, credentials wrong, Chromium won't launch) still
      // has to land as a `failed` record, which is why this is inside the try
      // rather than before it.
      session = await deps.pool.acquire({
        app: artifact.target.app,
        role: ctx.role,
        baseUrl: artifact.target.baseUrl,
      });
      // Published as soon as there is something to look at, which is before the
      // first step runs: the login and the opening navigation are exactly the
      // part of a run a reviewer most wants to watch, and they are also the
      // part that takes longest to reach a recognisable page.
      deps.liveView?.register(runId, session.page);

      const guardrailsConfig = loadGuardrailsConfig(artifact.target.app);
      const escalate = ctx.escalateEnabled
        ? wrapEscalation(runId, evidenceOutDir, session.page, logger, artifact.target.app, artifact)
        : undefined;

      result = await replay({
        runId,
        artifact,
        params: ctx.params,
        page: session.page,
        logger,
        sessionRole: ctx.role,
        guardrail: (step, guardCtx) => evaluateGuardrails(step, guardCtx, guardrailsConfig),
        ...(escalate ? { escalate } : {}),
      });
    } catch (err) {
      // 9. `runReplay` throws — not returns — for `materializeArtifact`'s
      //    TemplateError, `validateParams`, and an unknown `getRecoveryAction`;
      //    `pool.acquire` throws for a failed login. All of them are the run's
      //    outcome, not the process's problem, so they are converted here into
      //    the same three-way result the engine would have returned. Nothing
      //    below this point may throw past the caller.
      const reason = err instanceof Error ? err.message : String(err);
      result = {
        status: "hard_failure",
        stepId: lastStep?.id ?? "run_bootstrap",
        stepDescription: lastStep?.description ?? "Session bootstrap and run setup",
        reason,
      };
      // The engine writes `run_start`/`run_end` itself, but only once it is
      // running. A throw from before or inside its own preamble would otherwise
      // leave an empty JSONL — a run with no evidence, which is exactly the
      // hole rule 4 exists to close.
      if (!sawRunStart) {
        logger.log({
          type: "run_start",
          kind: "replay",
          runId,
          capabilityId: artifact.id,
          capabilityVersion: artifact.version,
          app: artifact.target.app,
          baseUrl: artifact.target.baseUrl,
          role: ctx.role,
          params: redactFields(ctx.params, sensitiveInputNames(artifact)),
        });
      }
      logger.log({ type: "run_end", status: "hard_failure", reason });
    }

    try {
      // 7. The persisted copy is redacted per `outputs[].sensitive`; the copy in
      //    the registry is not. That asymmetry is deliberate and already exists
      //    in `replay/cli.ts` (real values to the caller, masked values to
      //    disk): evidence lands in a repo and outlives the run, whereas an
      //    operator staring at the dashboard just asked for that balance and is
      //    entitled to see it. Redacting the record would make the dashboard
      //    strictly less useful than the CLI for no safety gain.
      safeWrite(
        logger,
        join(evidenceOutDir, `${runId}.result.json`),
        JSON.stringify(redactResultForEvidence(result, artifact), null, 2),
      );

      // 8. Failure evidence, captured before the context is released — the page
      //    is the only place this information exists, and `release()` destroys
      //    it. Independent of escalation, which takes its own screenshot at the
      //    moment it pauses; the unattended path is the default one and needs
      //    its own.
      if (result.status === "hard_failure" && session) {
        const page = session.page;
        await page.screenshot({ path: join(evidenceOutDir, `${runId}.failure.png`) }).catch(() => undefined);
        const html = await page.content().catch(() => null);
        if (html) safeWrite(logger, join(evidenceOutDir, `${runId}.failure.dom.html`), html);
      }

      const finishedAt = new Date().toISOString();
      const intervention: HumanIntervention | undefined =
        "humanIntervention" in result ? result.humanIntervention : undefined;
      deps.runs.update(runId, {
        status: statusFromResult(result),
        result,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(deps.runs.get(runId)?.startedAt ?? finishedAt),
        updatedAt: finishedAt,
        ...(intervention ? { escalated: true, humanIntervention: intervention } : {}),
        ...(result.status === "hard_failure" ? { error: result.reason } : {}),
      });
    } catch (err) {
      // Bookkeeping itself failed (a full disk, a registry bug). Record what we
      // can and still never reject.
      deps.runs.update(runId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      });
    } finally {
      // 10. Unconditional. A context that outlives its run is a leaked login
      //     session against the target, not just leaked memory.
      //
      //     Unpublished *before* the close, not after: a screenshot request
      //     that resolves the page a moment before it is destroyed fails
      //     harmlessly, but leaving a closed page registered would make every
      //     later request pay a timeout to discover the same thing.
      deps.liveView?.release(runId);
      await session?.release();
    }
  }

  /**
   * Wraps the injected handler so the *registry* knows the run is parked.
   * Without this a paused run reads as `running` forever while holding the
   * single-flight lock, and the 409 a caller gets would give them no way to
   * discover that a human is the thing they're waiting on.
   */
  function wrapEscalation(
    runId: string,
    evidenceOutDir: string,
    page: import("playwright").Page,
    logger: RunLogger,
    app: string,
    artifact: CapabilityArtifact,
  ): EscalationHandler | undefined {
    const handler = deps.escalate?.({ runId, evidenceDir: evidenceOutDir, page, logger, app, artifact });
    if (!handler) return undefined;
    return async (ctx: InterventionContext, executeApprovedStep?: () => Promise<void>) => {
      const raisedAt = new Date().toISOString();
      const summary: EscalationSummary = {
        kind: ctx.kind,
        reason: ctx.reason,
        raisedAt,
        consoleUrl: `/runs/${runId}/escalation`,
        ...(ctx.pendingAction ? { pendingAction: ctx.pendingAction } : {}),
      };
      deps.runs.update(runId, {
        status: "escalation_pending",
        escalated: true,
        escalationPending: summary,
        updatedAt: raisedAt,
      });
      try {
        return await handler(ctx, executeApprovedStep);
      } finally {
        // Back to `running`: the engine resumes the same session either way,
        // and the terminal status is set by the result. `escalationPending` is
        // left in place on purpose — it is the record of what happened, and
        // `status` is the authority on whether anyone is still waiting.
        deps.runs.update(runId, { status: "running", updatedAt: new Date().toISOString() });
      }
    };
  }

  return {
    invoke,
    /** 11. Resolves when the in-flight run finishes, or when the budget runs out. */
    async drain(timeoutMs: number): Promise<void> {
      const running = inFlight;
      if (!running) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          // Don't let the drain timer be the reason the process stays alive.
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sensitiveInputNames(artifact: CapabilityArtifact): ReadonlySet<string> {
  return new Set(artifact.inputParams.filter((p) => p.sensitive).map((p) => p.name));
}

/** Masks any output flagged sensitive in the artifact's contract before the result is persisted. */
function redactResultForEvidence(result: ReplayResult, artifact: CapabilityArtifact): ReplayResult {
  if (result.status !== "success") return result;
  const sensitiveNames = new Set(artifact.outputs.filter((o) => o.sensitive).map((o) => o.name));
  if (sensitiveNames.size === 0) return result;
  const outputs = Object.fromEntries(
    Object.entries(result.outputs).map(([k, v]) => [k, redactValue(v, sensitiveNames.has(k))]),
  );
  return { ...result, outputs: outputs as Record<string, string | number> };
}

/** Tees the engine's log stream so progress can be tracked without changing the engine. */
function observeLog(base: RunLogger, onEvent: (event: LogEvent) => void): RunLogger {
  return {
    filePath: base.filePath,
    log(event: LogEvent) {
      base.log(event);
      // An observer bug must not take down the run it is observing.
      try {
        onEvent(event);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * A failed evidence write must not rewrite a successful run as a failure —
 * the automation did succeed, and reporting otherwise would be a lie about the
 * target's state. It is logged instead, so the gap in the evidence is itself
 * evidenced.
 */
function safeWrite(logger: RunLogger, path: string, contents: string): void {
  try {
    writeFileSync(path, contents);
  } catch (err) {
    logger.log({ type: "evidence_write_failed", path, error: err instanceof Error ? err.message : String(err) });
  }
}
