import { createHash } from "node:crypto";
import type { CapabilityArtifact } from "./schema.js";

/**
 * Fingerprints the semantically meaningful *shape* of a capability: its
 * steps, checkpoints, known outcomes, and declared call contract, plus the
 * vendor/app identity it targets. Deliberately excludes instance-specific
 * fields (id, name, description, version, createdAt, discovery provenance,
 * baseUrl, tenant) so that, in the multi-tenant design (see REPORT.md §4),
 * two tenants running the same underlying app *should* hash identically if
 * their UI genuinely matches — divergence in this hash is the drift signal.
 */
export function computeContentHash(
  artifact: Pick<
    CapabilityArtifact,
    "steps" | "checkpoints" | "knownOutcomes" | "inputParams" | "outputs" | "target"
  >,
): string {
  const shape = {
    app: artifact.target.app,
    entryRoute: artifact.target.entryRoute,
    inputParams: artifact.inputParams,
    outputs: artifact.outputs,
    steps: artifact.steps,
    checkpoints: artifact.checkpoints,
    knownOutcomes: artifact.knownOutcomes,
  };
  return createHash("sha256").update(stableStringify(shape)).digest("hex");
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
