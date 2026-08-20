import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isKnownRole, listRoles, resolveTargetFor } from "../../apps/index.js";
import { buildArtifact } from "../../discovery/build-artifact.js";
import { CAPABILITY_PRESETS, type CapabilityPreset } from "../../discovery/capability-presets.js";
import { runDiscovery } from "../../discovery/loop.js";
import { scoreRecording } from "../../discovery/score-recording.js";
import { redactTranscriptText } from "../../guardrails/redact.js";
import { createRunLogger, type LogEvent, type RunLogger } from "../../logging/logger.js";
import { ParamValidationError } from "../../replay/coerce.js";
import { RunnerBusyError, type InvokeAccepted, type RunRecord } from "../types.js";
import type { RunnerCore } from "./run-executor.js";

/**
 * Re-recording a capability from the dashboard.
 *
 * This is `src/discovery/cli.ts` with the CLI's two answers to "something went
 * wrong" — print to stderr, `process.exit` — replaced by the server's one
 * answer: it becomes a terminal run record with evidence on disk that a caller
 * can poll. That is the same translation `run-executor.ts` performs for replay,
 * and it shares that module's single-flight lock, browser pool and live view
 * rather than owning its own, because "the runner" is one thing: two runs
 * against one authenticated session would interleave their evidence and race
 * on the target's state whichever kind they are.
 *
 * **One deliberate difference from the CLI.** The differential probe is not
 * run here. It replays the freshly compiled artifact with a second argument
 * set, which against this shared, stateful target means a second real
 * transaction for any mutating capability — and the dashboard's whole purpose
 * is being driven live in front of someone. The quality report is generated
 * with `probeSkipped`, so the missing check is *reported as missing* rather
 * than silently counted as passed. `npm run discover` remains the path that
 * runs it.
 */

export class PresetNotFoundError extends Error {
  constructor(readonly capabilityId: string) {
    super(
      `No discovery preset for "${capabilityId}". A capability can only be re-recorded if it has a preset in src/discovery/.`,
    );
    this.name = "PresetNotFoundError";
  }
}

export interface DiscoverRequest {
  capabilityId: string;
  role?: string;
  escalate?: boolean;
}

export interface DiscoveryRunnerDeps extends RunnerCore {
  evidenceRoot?: string;
  capabilitiesRoot?: string;
}

const EVIDENCE_SUBDIR = "discovery-run";

export function createDiscoveryRunner(deps: DiscoveryRunnerDeps) {
  const evidenceRoot = deps.evidenceRoot ?? join(process.cwd(), "evidence");
  const capabilitiesRoot = deps.capabilitiesRoot ?? join(process.cwd(), "capabilities");

  async function discover(req: DiscoverRequest): Promise<InvokeAccepted> {
    const preset = CAPABILITY_PRESETS[req.capabilityId];
    if (!preset) throw new PresetNotFoundError(req.capabilityId);

    // Defaults to the role the capability declares it needs: defaulting a
    // supervisor-gated capability to a teller session just fails at the host.
    const role = req.role || preset.preconditions.requiredRole || listRoles(preset.app)[0] || "";
    if (!isKnownRole(preset.app, role)) {
      throw new ParamValidationError([
        { name: "role", problem: `is not a role of app "${preset.app}". Known roles: ${listRoles(preset.app).join(", ")}` },
      ]);
    }

    const active = deps.runs.active();
    if (active) throw new RunnerBusyError(active);

    // Same ordering rule as replay: the id is allocated and the record
    // published before anything slow enough to fail (browser launch, login),
    // so an accepted call always has a pollable run behind it.
    const runId = `${preset.id}-${Date.now()}`;
    const evidenceOutDir = join(evidenceRoot, preset.app, EVIDENCE_SUBDIR);
    mkdirSync(evidenceOutDir, { recursive: true });
    const logger = createRunLogger(runId, evidenceOutDir);
    const startedAt = new Date().toISOString();

    deps.runs.create({
      runId,
      kind: "discovery",
      capabilityId: preset.id,
      app: preset.app,
      role,
      status: "running",
      escalated: false,
      startedAt,
      baseUrl: resolveTargetFor(preset.app).baseUrl,
      evidenceDir: EVIDENCE_SUBDIR,
      logPath: logger.filePath,
      updatedAt: startedAt,
      // The example arguments the model is told to use. Not caller-supplied —
      // a re-recording is not an invocation.
      params: Object.fromEntries(preset.params.map((p) => [p.name, p.exampleValue])),
      // Unknowable in advance: how many steps a recording takes is the thing
      // being discovered. `stepsTotal` is deliberately absent rather than
      // guessed, and the views already render that case.
      progress: { stepsCompleted: 0 },
    } satisfies RunRecord);

    deps.track(execute({ runId, preset, role, evidenceOutDir, logger, escalate: req.escalate ?? true }));

    return {
      runId,
      capabilityId: preset.id,
      status: "running",
      statusUrl: `/api/runs/${runId}/status`,
      runUrl: `/runs/${runId}`,
      warnings: [],
    };
  }

  interface Ctx {
    runId: string;
    preset: CapabilityPreset;
    role: string;
    evidenceOutDir: string;
    logger: RunLogger;
    escalate: boolean;
  }

  /** Never rejects: every failure becomes a terminal record, exactly as in replay. */
  async function execute(ctx: Ctx): Promise<void> {
    const { runId, preset, evidenceOutDir } = ctx;
    let session: Awaited<ReturnType<RunnerCore["pool"]["acquire"]>> | undefined;

    // Progress off the log stream, like replay — but counting model *turns*,
    // since that is what a discovery run spends and what its budget is in.
    let turns = 0;
    const logger = observe(ctx.logger, (event) => {
      if (event.type !== "model_decision") return;
      turns += 1;
      deps.runs.update(runId, {
        progress: {
          stepsCompleted: turns,
          ...(typeof event["tool"] === "string" ? { currentStepId: event["tool"] as string } : {}),
          ...(typeof event["reasoning"] === "string"
            ? { currentStepDescription: (event["reasoning"] as string).slice(0, 200) }
            : {}),
        },
        updatedAt: new Date().toISOString(),
      });
    });

    try {
      const target = resolveTargetFor(preset.app);
      session = await deps.pool.acquire({ app: preset.app, role: ctx.role, baseUrl: target.baseUrl });
      deps.liveView?.register(runId, session.page);

      const escalate = ctx.escalate
        ? deps.escalate?.({
            runId,
            evidenceDir: evidenceOutDir,
            page: session.page,
            logger,
            app: preset.app,
          })
        : undefined;

      const result = await runDiscovery({
        runId,
        capabilityId: preset.id,
        target,
        sessionRole: ctx.role,
        goal: preset.goal,
        params: preset.params,
        page: session.page,
        dialogEvents: session.dialogEvents,
        logger,
        ...(escalate ? { escalate } : {}),
      });

      // Written before the outcome is branched on: a failed run's transcript is
      // the most useful thing it produced.
      const sensitive = Object.values(result.extractedValues)
        .filter((r) => r.sensitive)
        .flatMap((r) => [r.value, r.raw.trim()])
        .filter((v) => String(v) !== "");
      write(
        logger,
        join(evidenceOutDir, `${runId}.transcript.json`),
        redactTranscriptText(JSON.stringify(result.transcript, null, 2), sensitive),
      );

      if (result.outcome !== "success") {
        await captureFailure(session.page, evidenceOutDir, runId, logger);
        finish(runId, "failed", {
          discoveryOutcome: result.outcome,
          error: result.reason,
          ...(result.humanIntervention ? { escalated: true, humanIntervention: result.humanIntervention } : {}),
        });
        return;
      }

      const artifactPath = join(capabilitiesRoot, preset.app, `${preset.id}.json`);
      const { artifact, compileFindings } = buildArtifact({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        // A re-recording is a new revision of the same capability, so the
        // previous one on disk decides the number.
        version: nextVersion(artifactPath),
        target,
        preconditions: preset.preconditions,
        params: preset.params,
        discoveryResult: result,
        knownOutcomes: preset.knownOutcomes,
        ...(preset.irreversibleStepLabels ? { irreversibleStepLabels: preset.irreversibleStepLabels } : {}),
      });

      const score = scoreRecording(artifact, {
        extractedValues: result.extractedValues,
        compileFindings,
        probeSkipped: true,
      });

      mkdirSync(join(capabilitiesRoot, preset.app), { recursive: true });
      const serialized = JSON.stringify(artifact, null, 2);
      write(logger, artifactPath, serialized);
      write(logger, join(evidenceOutDir, `${runId}.artifact.json`), serialized);
      // Findings only, never the offending values — this file is committed.
      write(
        logger,
        join(evidenceOutDir, `${runId}.quality.json`),
        JSON.stringify({ capabilityId: artifact.id, ...score }, null, 2),
      );
      logger.log({
        type: "recording_score",
        capabilityId: artifact.id,
        score: score.score,
        grade: score.grade,
        errors: score.findings.filter((f) => f.severity === "error").length,
        warnings: score.findings.filter((f) => f.severity === "warn").length,
      });

      // The catalog is mtime-cached, so the new revision appears without a
      // restart the next time any page reads it.
      deps.catalog.refresh();
      finish(runId, "succeeded", {
        discoveryOutcome: result.outcome,
        ...(result.humanIntervention ? { escalated: true, humanIntervention: result.humanIntervention } : {}),
      });
    } catch (err) {
      // A missing API key, a target that is down, a compiler that refused the
      // recording. All of them are this run's outcome, not the process's.
      const reason = err instanceof Error ? err.message : String(err);
      logger.log({ type: "run_end", outcome: "failed", reason });
      if (session) await captureFailure(session.page, evidenceOutDir, runId, logger);
      finish(runId, "failed", { error: reason });
    } finally {
      deps.liveView?.release(runId);
      await session?.release();
    }
  }

  function finish(runId: string, status: "succeeded" | "failed", patch: Partial<RunRecord>): void {
    const finishedAt = new Date().toISOString();
    const startedAt = deps.runs.get(runId)?.startedAt ?? finishedAt;
    deps.runs.update(runId, {
      status,
      finishedAt,
      updatedAt: finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      ...patch,
    });
  }

  return { discover };
}

// ---------------------------------------------------------------------------

async function captureFailure(
  page: import("playwright").Page,
  dir: string,
  runId: string,
  logger: RunLogger,
): Promise<void> {
  await page.screenshot({ path: join(dir, `${runId}.failure.png`) }).catch(() => undefined);
  const html = await page.content().catch(() => null);
  if (html) write(logger, join(dir, `${runId}.failure.dom.html`), html);
}

function nextVersion(artifactPath: string): number {
  if (!existsSync(artifactPath)) return 1;
  try {
    const existing = JSON.parse(readFileSync(artifactPath, "utf-8")) as { version?: unknown };
    return typeof existing.version === "number" && existing.version > 0 ? existing.version + 1 : 1;
  } catch {
    return 1;
  }
}

/** A failed evidence write is logged, never allowed to rewrite the run's outcome. */
function write(logger: RunLogger, path: string, contents: string): void {
  try {
    writeFileSync(path, contents);
  } catch (err) {
    logger.log({ type: "evidence_write_failed", path, error: err instanceof Error ? err.message : String(err) });
  }
}

function observe(base: RunLogger, onEvent: (event: LogEvent) => void): RunLogger {
  return {
    filePath: base.filePath,
    log(event: LogEvent) {
      base.log(event);
      try {
        onEvent(event);
      } catch {
        /* an observer bug must not take down the run it observes */
      }
    },
  };
}
