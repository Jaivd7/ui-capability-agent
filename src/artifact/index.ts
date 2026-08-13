import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

export * from "./schema.js";
export { computeContentHash } from "./hash.js";

export type ParseArtifactResult =
  | { success: true; artifact: CapabilityArtifact }
  | { success: false; errors: string[] };

/**
 * Validates raw JSON (from disk, from the discovery loop, from a network
 * call) against the artifact schema before it is trusted anywhere else in
 * the system. The replay engine and guardrail layer should never receive an
 * artifact that hasn't passed through this.
 */
export function parseArtifact(data: unknown): ParseArtifactResult {
  const result = CapabilityArtifactSchema.safeParse(data);
  if (result.success) {
    return { success: true, artifact: result.data };
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
  return { success: false, errors };
}
