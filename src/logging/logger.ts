import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Structured, append-only JSONL run log — one line per event, human-tailable
 * and machine-parseable. Shared by discovery and replay so both produce the
 * same evidence shape (see /evidence/). Every event is timestamped; callers
 * are responsible for redacting sensitive values before logging them (see
 * src/guardrails/redact.ts) — the logger itself doesn't know which fields
 * are sensitive.
 */
export interface LogEvent {
  type: string;
  [key: string]: unknown;
}

export interface RunLogger {
  readonly filePath: string;
  log(event: LogEvent): void;
}

export function createRunLogger(runId: string, outDir: string): RunLogger {
  mkdirSync(outDir, { recursive: true });
  const filePath = join(outDir, `${runId}.jsonl`);

  return {
    filePath,
    log(event: LogEvent) {
      const line = { timestamp: new Date().toISOString(), ...event };
      appendFileSync(filePath, JSON.stringify(line) + "\n", "utf-8");
      const { type, ...rest } = line;
      console.log(`[${line.timestamp}] ${type}`, summarize(rest));
    },
  };
}

function summarize(rest: Record<string, unknown>): string {
  const { timestamp: _t, ...fields } = rest;
  const parts = Object.entries(fields)
    .filter(([k]) => k !== "timestamp")
    .map(([k, v]) => `${k}=${truncate(stringifyField(v))}`);
  return parts.join(" ");
}

/** JSON.stringify(undefined) returns the *value* undefined, not a string — guard against that and any other non-string result. */
function stringifyField(v: unknown): string {
  if (typeof v === "string") return v;
  const json = JSON.stringify(v);
  return json === undefined ? String(v) : json;
}

function truncate(s: string, max = 140): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
