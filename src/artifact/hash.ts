import { createHash } from "node:crypto";
import type { CapabilityArtifact } from "./schema.js";

/**
 * Fingerprints the semantically meaningful *shape* of a capability: the steps,
 * checkpoints, known outcomes and declared call contract, the preconditions
 * for running it, and the vendor/app identity it targets.
 *
 * Deliberately excludes instance-specific fields (id, name, description,
 * version, createdAt, discovery provenance, baseUrl, tenant) so that, in the
 * multi-tenant design (REPORT.md §4), two tenants running the same underlying
 * app *should* hash identically if their UI genuinely matches — divergence is
 * the drift signal.
 *
 * For that signal to be worth anything it has to be sensitive to exactly the
 * things that change behaviour and nothing else, which the first version got
 * wrong in both directions:
 *
 *  - **`preconditions` was excluded.** But `startRoute` decides where the flow
 *    begins and `requiredRole` is the difference between a capability a
 *    readonly session can run and one it can't. Two artifacts differing only
 *    in `requiredRole` hashed identically — a security-relevant edit invisible
 *    to the very mechanism meant to detect edits.
 *  - **Human-facing prose was included.** Every locator's `reason` and every
 *    `description` fed the hash, so a re-recording that worded a reason
 *    differently produced a byte-identical automaton with a different
 *    fingerprint. False-positive drift is the fastest way to teach people to
 *    ignore a drift signal, and these fields exist for *review* (they're what
 *    the recording scorer grades) rather than for execution.
 */
export function computeContentHash(
  artifact: Pick<
    CapabilityArtifact,
    "steps" | "checkpoints" | "knownOutcomes" | "inputParams" | "outputs" | "target" | "preconditions"
  >,
): string {
  const shape = {
    app: artifact.target.app,
    entryRoute: artifact.target.entryRoute,
    preconditions: artifact.preconditions,
    inputParams: artifact.inputParams,
    outputs: artifact.outputs,
    steps: artifact.steps,
    checkpoints: artifact.checkpoints,
    knownOutcomes: artifact.knownOutcomes,
  };
  return createHash("sha256").update(stableStringify(normalizeForHash(shape))).digest("hex");
}

/**
 * Strips the review-facing prose. `reason` appears only on locator candidates
 * and `description` only on steps, checkpoints, outcomes, params and outputs —
 * all of them commentary. `outcome.message` is deliberately *not* stripped:
 * that one is the caller-facing contract, so changing it does change what a
 * consumer sees.
 */
const REVIEW_ONLY_FIELDS = new Set(["reason", "description"]);

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !REVIEW_ONLY_FIELDS.has(k))
        .map(([k, v]) => [k, normalizeForHash(v)]),
    );
  }
  return value;
}

/** JSON.stringify with sorted keys, so field reordering never changes the hash. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}
