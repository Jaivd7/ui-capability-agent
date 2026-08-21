import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Catalog, CatalogEntryDetail, RunRecord } from "../types.js";
import { createRunRegistry } from "./run-registry.js";

/**
 * Fixtures are written to a temp tree rather than read from the committed
 * `evidence/`: these assert on classification rules, and pinning them to
 * evidence that a later demo run can legitimately change makes them fail for
 * reasons that have nothing to do with the code.
 */

let root: string;
let evidence: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run-registry-"));
  evidence = join(root, "evidence");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeLog(app: string, dir: string, runId: string, lines: Array<Record<string, unknown>>): string {
  const outDir = join(evidence, app, dir);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${runId}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return path;
}

function writeSidecar(app: string, dir: string, runId: string, suffix: string, body: unknown): void {
  writeFileSync(join(evidence, app, dir, `${runId}.${suffix}`), JSON.stringify(body), "utf-8");
}

const T0 = "2026-08-20T18:00:00.000Z";
const T1 = "2026-08-20T18:00:09.000Z";

function replayStart(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: T0,
    type: "run_start",
    kind: "replay",
    runId: "cap-a-1787248913794",
    capabilityId: "cap-a",
    capabilityVersion: 5,
    app: "legacy-core-banking",
    baseUrl: "http://localhost:3100",
    role: "teller",
    params: { memberId: "1001" },
    ...extra,
  };
}

function registry(catalog?: Catalog) {
  return createRunRegistry({ evidenceRoot: evidence, ...(catalog ? { catalog } : {}) });
}

describe("createRunRegistry: derivation from disk", () => {
  it("marks an unfinished log as crashed at boot", async () => {
    // A crashed run and a running run are the same bytes. The boot sweep is
    // the one moment where the ambiguity resolves: nothing is running, so an
    // unfinished log belongs to a process that died.
    writeLog("legacy-core-banking", "replay-run", "cap-a-1787248913794", [
      replayStart(),
      { timestamp: T1, type: "step_result", stepId: "step-1", ok: true },
    ]);

    const runs = registry();
    await runs.rebuildFromDisk();

    const record = runs.get("cap-a-1787248913794");
    expect(record?.status).toBe("crashed");
    expect(record?.error).toMatch(/no run_end/);
    expect(runs.active()).toBeUndefined();
  });

  it("reads identity, params and evidence location off the log and the path", async () => {
    writeLog("legacy-core-banking", "replay-run", "cap-a-1787248913794", [
      replayStart(),
      { timestamp: T1, type: "run_end", status: "success", stepsExecuted: 4, humanIntervened: false },
    ]);

    const runs = registry();
    await runs.rebuildFromDisk();
    const record = runs.get("cap-a-1787248913794");

    expect(record).toMatchObject({
      kind: "replay",
      capabilityId: "cap-a",
      capabilityVersion: 5,
      app: "legacy-core-banking",
      evidenceDir: "replay-run",
      role: "teller",
      status: "succeeded",
      escalated: false,
      startedAt: T0,
      finishedAt: T1,
      durationMs: 9000,
      params: { memberId: "1001" },
    });
    expect(record?.progress.stepsCompleted).toBe(4);
  });

  it("falls back to the path and the run id when an older log omits identity", async () => {
    // The committed evidence from earlier phases predates run_start carrying
    // app/role/capabilityId, and history must still render for it.
    writeLog("legacy-core-banking", "discovery-run", "lookup-member-balance-1787247596978", [
      { timestamp: T0, type: "run_start", kind: "discovery", goal: "read the balance" },
      { timestamp: T1, type: "run_end", outcome: "dead_end" },
    ]);

    const runs = registry();
    await runs.rebuildFromDisk();
    const record = runs.get("lookup-member-balance-1787247596978");

    expect(record?.capabilityId).toBe("lookup-member-balance");
    expect(record?.app).toBe("legacy-core-banking");
    expect(record?.kind).toBe("discovery");
    expect(record?.status).toBe("failed");
    expect(record?.discoveryOutcome).toBe("dead_end");
  });

  it("finds run_end even when it is not the last line", async () => {
    // Discovery scores the recording *after* the loop returns, so `run_end` is
    // second-to-last. Reading the final line as the outcome reported every
    // completed discovery run in the committed evidence as crashed.
    writeLog("legacy-core-banking", "discovery-run", "cap-a-1787247596978", [
      { timestamp: T0, type: "run_start", kind: "discovery", capabilityId: "cap-a", role: "teller" },
      { timestamp: T1, type: "run_end", outcome: "success", status: "success", stepCount: 4 },
      { timestamp: T1, type: "recording_score", capabilityId: "cap-a", score: 87, grade: "B" },
    ]);

    const runs = registry();
    await runs.rebuildFromDisk();
    const record = runs.get("cap-a-1787247596978");

    expect(record?.status).toBe("succeeded");
    expect(record?.finishedAt).toBe(T1);
    expect(record?.progress.stepsCompleted).toBe(4);
  });

  it("attaches the persisted result rather than reconstructing one from the ends", async () => {
    // Only the first and last lines are read, so a reconstructed success would
    // claim zero outputs. result.json is the authoritative, already-redacted copy.
    writeLog("legacy-core-banking", "replay-run", "cap-a-1787248913794", [
      replayStart(),
      { timestamp: T1, type: "run_end", status: "success", stepsExecuted: 4, humanIntervened: false },
    ]);
    writeSidecar("legacy-core-banking", "replay-run", "cap-a-1787248913794", "result.json", {
      status: "success",
      outputs: { savingsBalance: "1250.00" },
      checkpointsPassed: ["Balance visible"],
      stepsExecuted: 4,
    });

    const runs = registry();
    await runs.rebuildFromDisk();

    expect(runs.get("cap-a-1787248913794")?.result).toMatchObject({
      status: "success",
      outputs: { savingsBalance: "1250.00" },
    });
  });

  it("keeps escalated separate from the outcome", async () => {
    writeLog("legacy-core-banking", "escalation-run", "cap-a-1787250585299", [
      replayStart({ runId: "cap-a-1787250585299" }),
      { timestamp: T1, type: "run_end", status: "success", stepsExecuted: 4, humanIntervened: true },
    ]);

    const runs = registry();
    await runs.rebuildFromDisk();
    const record = runs.get("cap-a-1787250585299");

    expect(record?.status).toBe("succeeded");
    expect(record?.escalated).toBe(true);
  });

  it("ignores probe logs, which are not runs", async () => {
    writeLog("legacy-core-banking", "discovery-run", "cap-a-1787248913794", [replayStart()]);
    writeFileSync(
      join(evidence, "legacy-core-banking", "discovery-run", "cap-a-1787248913794.probe.jsonl"),
      JSON.stringify({ timestamp: T0, type: "probe" }) + "\n",
      "utf-8",
    );

    const runs = registry();
    await runs.rebuildFromDisk();

    expect(runs.list()).toHaveLength(1);
  });

  it("takes stepsTotal from the catalog, which is the only place it exists", async () => {
    writeLog("legacy-core-banking", "replay-run", "cap-a-1787248913794", [
      replayStart(),
      { timestamp: T1, type: "run_end", status: "success", stepsExecuted: 4 },
    ]);
    const catalog: Catalog = {
      list: () => [],
      get: () => ({ artifact: { steps: [{}, {}, {}, {}] } }) as unknown as CatalogEntryDetail,
      refresh: () => undefined,
    };

    const runs = registry(catalog);
    await runs.rebuildFromDisk();

    expect(runs.get("cap-a-1787248913794")?.progress.stepsTotal).toBe(4);
  });
});

describe("createRunRegistry: live records", () => {
  function liveRecord(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      runId: "cap-a-1787248913794",
      kind: "replay",
      capabilityId: "cap-a",
      app: "legacy-core-banking",
      role: "teller",
      status: "running",
      escalated: false,
      startedAt: T0,
      baseUrl: "http://localhost:3100",
      evidenceDir: "replay-run",
      logPath: join(evidence, "legacy-core-banking", "replay-run", "cap-a-1787248913794.jsonl"),
      updatedAt: T0,
      params: { memberId: "1001" },
      progress: { stepsCompleted: 1 },
      ...overrides,
    };
  }

  it("lets a live record win over the disk-derived twin of the same run", async () => {
    // The disk twin of an in-flight run necessarily looks crashed; the live
    // map is the only holder of the fact that a process is still writing it.
    writeLog("legacy-core-banking", "replay-run", "cap-a-1787248913794", [
      replayStart(),
      { timestamp: T1, type: "step_result", stepId: "step-1", ok: true },
    ]);

    const runs = registry();
    await runs.rebuildFromDisk();
    expect(runs.get("cap-a-1787248913794")?.status).toBe("crashed");

    runs.create(liveRecord());

    expect(runs.get("cap-a-1787248913794")?.status).toBe("running");
    expect(runs.list()).toHaveLength(1);
    expect(runs.active()?.runId).toBe("cap-a-1787248913794");
  });

  it("returns no active run once the live one reaches a terminal status", () => {
    const runs = registry();
    runs.create(liveRecord());
    runs.update("cap-a-1787248913794", { status: "succeeded", finishedAt: T1 });

    expect(runs.active()).toBeUndefined();
    expect(runs.get("cap-a-1787248913794")?.status).toBe("succeeded");
    expect(runs.get("cap-a-1787248913794")?.updatedAt).not.toBe(T0);
  });

  it("promotes a disk-derived run into the live map when it is updated", async () => {
    writeLog("legacy-core-banking", "replay-run", "cap-a-1787248913794", [
      replayStart(),
      { timestamp: T1, type: "run_end", status: "success", stepsExecuted: 4 },
    ]);
    const runs = registry();
    await runs.rebuildFromDisk();

    runs.update("cap-a-1787248913794", { error: "annotated" });

    expect(runs.get("cap-a-1787248913794")).toMatchObject({ status: "succeeded", error: "annotated" });
  });

  it("refuses to update a run it has never seen", () => {
    expect(() => registry().update("nope", { status: "failed" })).toThrow(/unknown run/);
  });
});

describe("createRunRegistry: list and events", () => {
  async function seeded() {
    writeLog("legacy-core-banking", "replay-run", "cap-a-1787248913794", [
      replayStart(),
      { timestamp: T1, type: "run_end", status: "success", stepsExecuted: 4 },
    ]);
    writeLog("legacy-core-banking", "replay-run", "cap-b-1787248923292", [
      replayStart({ runId: "cap-b-1787248923292", capabilityId: "cap-b", timestamp: "2026-08-20T18:05:00.000Z" }),
      { timestamp: "2026-08-20T18:05:10.000Z", type: "run_end", status: "hard_failure", stepId: "step-2", reason: "boom" },
    ]);
    writeLog("meridian-core", "discovery-run", "cap-c-1787248999999", [
      { timestamp: "2026-08-20T18:10:00.000Z", type: "run_start", kind: "discovery", capabilityId: "cap-c", role: "teller" },
      { timestamp: "2026-08-20T18:10:30.000Z", type: "run_end", outcome: "escalated_completed", status: "hard_failure", humanIntervened: true },
    ]);

    const runs = registry();
    await runs.rebuildFromDisk();
    return runs;
  }

  it("sorts newest first", async () => {
    const runs = await seeded();
    expect(runs.list().map((r) => r.runId)).toEqual([
      "cap-c-1787248999999",
      "cap-b-1787248923292",
      "cap-a-1787248913794",
    ]);
  });

  it("filters on every query field and honours the limit", async () => {
    const runs = await seeded();

    expect(runs.list({ app: "meridian-core" }).map((r) => r.runId)).toEqual(["cap-c-1787248999999"]);
    expect(runs.list({ capabilityId: "cap-b" }).map((r) => r.runId)).toEqual(["cap-b-1787248923292"]);
    expect(runs.list({ kind: "discovery" }).map((r) => r.runId)).toEqual(["cap-c-1787248999999"]);
    // Two failures now: cap-b is a replay hard failure, and cap-c is the
    // escalated discovery -- resumed by a human, but no artifact was built,
    // so it did not succeed.
    expect(runs.list({ status: "failed" }).map((r) => r.runId)).toEqual([
      "cap-c-1787248999999",
      "cap-b-1787248923292",
    ]);
    expect(runs.list({ escalated: true }).map((r) => r.runId)).toEqual(["cap-c-1787248999999"]);
    expect(runs.list({ limit: 2 })).toHaveLength(2);
  });

  it("surfaces a hard failure's reason as the row's error", async () => {
    const runs = await seeded();
    expect(runs.get("cap-b-1787248923292")?.error).toBe("boom");
  });

  it("reads events on demand, skipping malformed lines and honouring since", async () => {
    const path = writeLog("legacy-core-banking", "replay-run", "cap-a-1787248913794", [
      replayStart(),
      { timestamp: T1, type: "step_result", stepId: "step-1", ok: true },
    ]);
    // A half-written line is what a live tail routinely sees; it must not take
    // the timeline down.
    writeFileSync(path, `${'{"timestamp":"' + T0 + '","type":"run_start"}'}\n{"broken\n{"timestamp":"${T1}","type":"run_end","status":"success"}\n`, "utf-8");

    const runs = registry();
    await runs.rebuildFromDisk();

    const all = await runs.events("cap-a-1787248913794");
    expect(all.map((e) => e.type)).toEqual(["run_start", "run_end"]);
    // Indices are line ordinals, so the malformed line still consumes one and
    // a poller's `since` stays stable across re-reads.
    expect(all.map((e) => e.index)).toEqual([0, 2]);
    expect(await runs.events("cap-a-1787248913794", 1)).toHaveLength(1);
    expect(await runs.events("no-such-run")).toEqual([]);
  });
});

describe("createRunRegistry: mtime cache", () => {
  it("does not re-read a log whose mtime and size are unchanged", async () => {
    // Written so both versions are byte-identical in length: the only signal
    // the cache could use is mtime, and it's pinned. If the second list()
    // reported "succeeded", the cache would not exist.
    const dir = join(evidence, "legacy-core-banking", "replay-run");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "cap-a-1787248913794.jsonl");
    const pinned = new Date("2026-08-20T18:30:00.000Z");

    const unfinished = { timestamp: T1, type: "step_result", stepId: "step-1", ok: true };
    const finished = { timestamp: T1, type: "run_end", status: "success", stepsExecuted: 4 };
    const width = Math.max(lineLength(unfinished), lineLength(finished));

    const write = (last: Record<string, unknown>) => {
      writeFileSync(path, `${JSON.stringify(replayStart())}\n${padLine(last, width)}\n`, "utf-8");
      utimesSync(path, pinned, pinned);
    };

    write(unfinished);
    const runs = registry();
    expect(runs.list()[0]?.status).toBe("crashed");

    write(finished);
    expect(runs.list()[0]?.status).toBe("crashed");

    // A real edit moves the mtime, and then the record refreshes.
    const later = new Date("2026-08-20T18:40:00.000Z");
    utimesSync(path, later, later);
    expect(runs.list()[0]?.status).toBe("succeeded");
  });

  it("re-derives everything on rebuildFromDisk, since a restart voids the cache", async () => {
    const path = writeLog("legacy-core-banking", "replay-run", "cap-a-1787248913794", [replayStart()]);
    const runs = registry();
    expect(runs.list()[0]?.status).toBe("crashed");

    const pinned = new Date("2026-08-20T18:30:00.000Z");
    utimesSync(path, pinned, pinned);
    writeFileSync(
      path,
      `${JSON.stringify(replayStart())}\n${JSON.stringify({ timestamp: T1, type: "run_end", status: "success" })}\n`,
      "utf-8",
    );
    utimesSync(path, pinned, pinned);

    await runs.rebuildFromDisk();

    expect(runs.list()[0]?.status).toBe("succeeded");
  });
});

function lineLength(obj: Record<string, unknown>): number {
  return JSON.stringify({ ...obj, pad: "" }).length;
}

function padLine(obj: Record<string, unknown>, width: number): string {
  return JSON.stringify({ ...obj, pad: "x".repeat(Math.max(0, width - lineLength(obj))) });
}
