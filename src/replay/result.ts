/**
 * The replay result contract — the direct implementation of the brief's
 * three-way split (§3.3): an expected business outcome, a hard failure with
 * debuggable detail, or success with outputs. There is no fourth "it sort of
 * worked" state, and "recoverable" deliberately does not appear here as a
 * caller-visible status — a recoverable condition either resolves silently
 * (replay continues and the caller only ever sees success/business/hard_failure)
 * or exhausts its retries and becomes a hard failure. Recoverability is a
 * replay-engine implementation detail, not something the caller needs a
 * fourth branch to handle. See docs/artifact-schema.md's error-taxonomy
 * section for the schema-level half of this design.
 */

export interface ReplaySuccess {
  status: "success";
  outputs: Record<string, string | number>;
  checkpointsPassed: string[];
  stepsExecuted: number;
}

export interface ReplayBusinessOutcome {
  status: "business_outcome";
  code: string;
  message: string;
  /** The knownOutcome id that fired, for cross-referencing the artifact. */
  outcomeId: string;
}

/**
 * Debuggable detail is mandatory, not optional — "what step, what was
 * expected, what was observed" is exactly what the brief asks a hard
 * failure to surface (§3.3), so the type makes it impossible to construct
 * a hard failure without it.
 */
export interface ReplayHardFailure {
  status: "hard_failure";
  stepId: string;
  stepDescription: string;
  reason: string;
  expected?: string;
  observed?: string;
}

export type ReplayResult = ReplaySuccess | ReplayBusinessOutcome | ReplayHardFailure;
