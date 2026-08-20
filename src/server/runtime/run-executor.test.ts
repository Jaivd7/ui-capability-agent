import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseArtifact } from "../../artifact/test-fixtures.js";
import type { CapabilityArtifact } from "../../artifact/schema.js";
import { ParamValidationError } from "../../replay/coerce.js";
import type { ReplayResult } from "../../replay/result.js";
import {
  RunnerBusyError,
  type Catalog,
  type CatalogEntryDetail,
  type RunQuery,
  type RunRecord,
  type RunRegistry,
  type RunSummary,
} from "../types.js";
import type { BrowserPool, RunSession } from "./browser-pool.js";
import { CapabilityNotFoundError, createRunExecutor, type ReplayFn } from "./run-executor.js";

/**
 * The executor is tested against a stubbed pool and a stubbed engine, because
 * what's under test here is entirely control flow and bookkeeping: when the
 * runId becomes visible, what holds the single-flight lock, and which failures
 * become records rather than rejections. Driving a real browser would test
 * Playwright and the engine, both of which have their own tests, and would hide
 * the ordering rules behind a ten-second run.
 */

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function detailFor(artifact: CapabilityArtifact): CatalogEntryDetail {
  return {
    id: artifact.id,
    name: artifact.name,
    description: artifact.description,
    version: artifact.version,
    schemaVersion: artifact.schemaVersion,
    contentHash: artifact.contentHash,
    app: artifact.target.app,
    appDisplayName: artifact.target.app,
    baseUrl: artifact.target.baseUrl,
    requiredRole: "teller",
    irreversible: false,
    inputParams: artifact.inputParams,
    outputs: artifact.outputs,
    knownOutcomes: [],
    artifact,
  };
}

function stubCatalog(artifact: CapabilityArtifact): Catalog {
  const detail = detailFor(artifact);
  return {
    list: () => [detail],
    get: (id) => (id === artifact.id ? detail : undefined),
    refresh: () => undefined,
  };
}

/** The real registry's contract, minus the disk: enough to exercise the lock and the patches. */
function stubRegistry(): RunRegistry & { records: Map<string, RunRecord> } {
  const records = new Map<string, RunRecord>();
  return {
    records,
    rebuildFromDisk: async () => undefined,
    list: (query?: RunQuery) => {
      const all = [...records.values()];
      return (query?.status ? all.filter((r) => r.status === query.status) : all) as RunSummary[];
    },
    get: (runId) => records.get(runId),
    events: async () => [],
    create: (record) => {
      records.set(record.runId, { ...record });
    },
    update: (runId, patch) => {
      const existing = records.get(runId);
      if (existing) records.set(runId, { ...existing, ...patch });
    },
    active: () =>
      [...records.values()].find((r) => r.status === "running" || r.status === "escalation_pending"),
  };
}

interface StubPool extends BrowserPool {
  acquired: number;
  released: number;
}

function stubPool(overrides: { failAcquire?: Error } = {}): StubPool {
  const pool: StubPool = {
    acquired: 0,
    released: 0,
    async acquire() {
      if (overrides.failAcquire) throw overrides.failAcquire;
      pool.acquired += 1;
      const page = {
        screenshot: async () => Buffer.from(""),
        content: async () => "<html>failure</html>",
      };
      const session = {
        context: {} as RunSession["context"],
        page: page as unknown as RunSession["page"],
        dialogEvents: [],
        release: async () => {
          pool.released += 1;
        },
      };
      return session;
    },
    async shutdown() {
      /* nothing to close */
    },
  };
  return pool;
}

/** A promise a test resolves by hand, so "while a run is in flight" is a real state and not a sleep. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SUCCESS: ReplayResult = {
  status: "success",
  outputs: { savingsBalance: 1234.56 },
  checkpointsPassed: ["Savings balance panel is visible"],
  stepsExecuted: 3,
};

// ---------------------------------------------------------------------------

describe("createRunExecutor", () => {
  let evidenceRoot: string;
  let artifact: CapabilityArtifact;

  beforeEach(() => {
    evidenceRoot = mkdtempSync(join(tmpdir(), "run-executor-"));
    artifact = baseArtifact();
    // The logger echoes every event to stdout; useful in production, noise here.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  function makeExecutor(replay: ReplayFn, pool: StubPool = stubPool()) {
    const runs = stubRegistry();
    const executor = createRunExecutor({
      catalog: stubCatalog(artifact),
      runs,
      pool,
      replay,
      evidenceRoot,
    });
    return { executor, runs, pool };
  }

  it("rejects an unknown capability before it costs a browser context", async () => {
    const pool = stubPool();
    const { executor } = makeExecutor(async () => SUCCESS, pool);

    await expect(executor.invoke({ capabilityId: "no-such-capability", params: {} })).rejects.toThrow(
      CapabilityNotFoundError,
    );
    expect(pool.acquired).toBe(0);
  });

  it("reports every bad param at once rather than the first", async () => {
    artifact.inputParams = [
      { name: "amount", type: "currency", required: true, sensitive: false },
      { name: "fee", type: "currency", required: true, sensitive: false },
    ];
    const { executor, runs } = makeExecutor(async () => SUCCESS);

    // An agent repairing this call needs the complete list, not one round trip
    // per field.
    const err = await executor
      .invoke({ capabilityId: artifact.id, params: { amount: "abc", fee: "xyz" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ParamValidationError);
    expect((err as ParamValidationError).fields.map((f) => f.name).sort()).toEqual(["amount", "fee"]);
    // A rejected invoke must not leave a phantom run behind.
    expect(runs.records.size).toBe(0);
  });

  it("reports every missing required param at once", async () => {
    // Note: `validateInvocation` checks presence for all params and throws
    // before it coerces any, so a missing field and an uncoercible one arrive
    // in separate responses. Each pass is complete on its own terms, which is
    // what the field-list contract actually promises.
    artifact.inputParams = [
      { name: "memberId", type: "string", required: true, sensitive: false },
      { name: "amount", type: "currency", required: true, sensitive: false },
    ];
    const { executor } = makeExecutor(async () => SUCCESS);

    const err = await executor
      .invoke({ capabilityId: artifact.id, params: { memberId: "   " } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ParamValidationError);
    // A blank string counts as missing: whitespace standing in for a required
    // value is a caller mistake, not a value.
    expect((err as ParamValidationError).fields.map((f) => f.name).sort()).toEqual(["amount", "memberId"]);
  });

  it("refuses a second run and names the one holding the lock", async () => {
    const gate = deferred<ReplayResult>();
    const { executor, runs } = makeExecutor(() => gate.promise);

    const first = await executor.invoke({ capabilityId: artifact.id, params: { memberId: "1001" } });

    const err = await executor
      .invoke({ capabilityId: artifact.id, params: { memberId: "1002" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunnerBusyError);
    // The point of carrying the run: a caller that gets a 409 can go look at
    // what's blocking them instead of just retrying blindly.
    expect((err as RunnerBusyError).activeRun.runId).toBe(first.runId);
    expect(runs.records.size).toBe(1);

    gate.resolve(SUCCESS);
    await executor.drain(1000);
  });

  it("registers the runId before the run finishes, so the first poll always resolves", async () => {
    const gate = deferred<ReplayResult>();
    const { executor, runs } = makeExecutor(() => gate.promise);

    const accepted = await executor.invoke({ capabilityId: artifact.id, params: { memberId: "1001" } });

    // This is rule 4: the id handed to the caller is already a real, pollable
    // record while the browser work is still in front of it.
    const record = runs.get(accepted.runId);
    expect(record).toBeDefined();
    expect(record?.status).toBe("running");
    expect(record?.logPath).toContain(`${accepted.runId}.jsonl`);
    expect(record?.result).toBeUndefined();

    gate.resolve(SUCCESS);
    await executor.drain(1000);
    expect(runs.get(accepted.runId)?.status).toBe("succeeded");
  });

  it("carries a successful run to `succeeded`, keeping the record unredacted and the evidence redacted", async () => {
    const { executor, runs, pool } = makeExecutor(async () => SUCCESS);

    const accepted = await executor.invoke({ capabilityId: artifact.id, params: { memberId: "1001" } });
    await executor.drain(1000);

    const record = runs.get(accepted.runId);
    expect(record?.status).toBe("succeeded");
    expect(record?.finishedAt).toBeDefined();
    // savingsBalance is declared sensitive. The operator who just asked for it
    // sees the real number...
    expect(record?.result).toEqual(SUCCESS);

    // ...and the file that outlives the run does not.
    const persisted = JSON.parse(
      readFileSync(join(evidenceRoot, artifact.target.app, "replay-run", `${accepted.runId}.result.json`), "utf-8"),
    ) as { outputs: Record<string, unknown> };
    expect(persisted.outputs["savingsBalance"]).toBe("[REDACTED]");

    expect(pool.released).toBe(1);
  });

  it("turns a throw from the engine into a failed record, not an unhandled rejection", async () => {
    // `runReplay` genuinely throws (rather than returning a hard_failure) for
    // an unresolved `${param}`, a missing required param, and an unknown
    // recovery action. None of those may escape as a process-level rejection.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const { executor, runs, pool } = makeExecutor(async () => {
      throw new Error("Unresolved template placeholder ${memberId}");
    });

    const accepted = await executor.invoke({ capabilityId: artifact.id, params: { memberId: "1001" } });
    await executor.drain(1000);
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", unhandled);

    const record = runs.get(accepted.runId);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("Unresolved template placeholder");
    expect(record?.result?.status).toBe("hard_failure");
    expect(unhandled).not.toHaveBeenCalled();

    // Failure evidence is captured off the live page before the context goes.
    const dom = readFileSync(
      join(evidenceRoot, artifact.target.app, "replay-run", `${accepted.runId}.failure.dom.html`),
      "utf-8",
    );
    expect(dom).toContain("failure");
    expect(pool.released).toBe(1);
  });

  it("turns a failed session bootstrap into a failed run with a real log, not a 500", async () => {
    // The target being down, or credentials being wrong, must not evaporate
    // into an HTTP error with nothing on disk to explain it.
    const pool = stubPool({ failAcquire: new Error("net::ERR_CONNECTION_REFUSED") });
    const { executor, runs } = makeExecutor(async () => SUCCESS, pool);

    const accepted = await executor.invoke({ capabilityId: artifact.id, params: { memberId: "1001" } });
    await executor.drain(1000);

    const record = runs.get(accepted.runId);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("ERR_CONNECTION_REFUSED");

    // The engine never ran, so it never wrote its own run_start/run_end. The
    // executor writes them, so the run is still evidenced.
    const log = readFileSync(record!.logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(log.map((e) => e.type)).toEqual(expect.arrayContaining(["run_start", "run_end"]));
  });

  it("releases the lock once a run reaches a terminal status", async () => {
    const { executor, runs } = makeExecutor(async () => SUCCESS);

    await executor.invoke({ capabilityId: artifact.id, params: { memberId: "1001" } });
    await executor.drain(1000);
    expect(runs.active()).toBeUndefined();

    // The next caller is not blocked by the previous run's record.
    await expect(
      executor.invoke({ capabilityId: artifact.id, params: { memberId: "1002" } }),
    ).resolves.toMatchObject({ status: "running" });
    await executor.drain(1000);
  });

  it("drain gives up after its budget rather than hanging shutdown", async () => {
    const gate = deferred<ReplayResult>();
    const { executor } = makeExecutor(() => gate.promise);

    await executor.invoke({ capabilityId: artifact.id, params: { memberId: "1001" } });
    const started = Date.now();
    await executor.drain(30);
    expect(Date.now() - started).toBeLessThan(1000);

    gate.resolve(SUCCESS);
    await executor.drain(1000);
  });
});
