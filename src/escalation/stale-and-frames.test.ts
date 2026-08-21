import { describe, expect, it, vi } from "vitest";
import { decodeFramePath } from "./page-targets.js";
import { createInterventionRegistry } from "./intervention-registry.js";
import type { EscalationOutcome, InterventionContext } from "./types.js";

describe("decodeFramePath", () => {
  it("accepts a frame path from the raw selector form", () => {
    expect(decodeFramePath(JSON.stringify([{ strategy: "name", value: "content" }]))).toEqual([
      { strategy: "name", value: "content" },
    ]);
  });

  it("treats the main document as the default", () => {
    expect(decodeFramePath("")).toEqual([]);
    expect(decodeFramePath(undefined)).toEqual([]);
  });

  it("validates as strictly as a picked target does", () => {
    expect(decodeFramePath("not json")).toEqual([]);
    expect(decodeFramePath(JSON.stringify([{ strategy: "evaluate", value: "x" }]))).toEqual([]);
    expect(decodeFramePath(JSON.stringify([{ strategy: "index", value: -1 }]))).toEqual([]);
    expect(decodeFramePath(JSON.stringify([{ strategy: "name", value: "" }]))).toEqual([]);
  });

  it("accepts an index frame, which is the last-resort addressing mode", () => {
    expect(decodeFramePath(JSON.stringify([{ strategy: "index", value: 0 }]))).toEqual([
      { strategy: "index", value: 0 },
    ]);
  });
});

/**
 * A replay can escalate twice — an irreversible confirmation, then a hard
 * failure later in the same flow. Both consoles live at the same URL, so the
 * first one's tab is still open with a live Resume button.
 */
describe("intervention identity", () => {
  const base = (runId: string) =>
    ({
      runId,
      context: { runId, capabilityId: "c", kind: "replay_hard_failure", reason: "r", currentUrl: "u" } as InterventionContext,
      raisedAt: new Date().toISOString(),
      page: {} as never,
      logger: { filePath: "x", log: vi.fn() },
      actions: [],
      screenshotPath: "s.png",
      policy: { guardrails: {} as never, app: "meridian-core", sensitiveValues: [] },
    }) as never;

  it("gives each intervention a distinct id, even on the same run", () => {
    const registry = createInterventionRegistry();
    const first = registry.register(base("run-1"), () => {});
    first.resolve("resumed");
    const second = registry.register(base("run-1"), () => {});
    expect(second.interventionId).not.toBe(first.interventionId);
  });

  it("a resolved intervention cannot settle its successor", () => {
    const registry = createInterventionRegistry();
    const settledFirst: EscalationOutcome[] = [];
    const settledSecond: EscalationOutcome[] = [];

    const first = registry.register(base("run-1"), (o) => settledFirst.push(o));
    first.resolve("resumed");
    const second = registry.register(base("run-1"), (o) => settledSecond.push(o));

    // The stale console's own handle, submitted again after its successor rose.
    first.resolve("aborted");

    expect(settledFirst).toHaveLength(1);
    expect(settledFirst[0]!.decision).toBe("resumed");
    expect(settledSecond).toHaveLength(0);
    expect(registry.get("run-1")?.interventionId).toBe(second.interventionId);
  });

  it("still settles the current intervention exactly once", () => {
    const registry = createInterventionRegistry();
    const settled: EscalationOutcome[] = [];
    const entry = registry.register(base("run-2"), (o) => settled.push(o));
    entry.resolve("resumed");
    entry.resolve("aborted");
    expect(settled).toHaveLength(1);
    expect(registry.get("run-2")).toBeUndefined();
  });
});
