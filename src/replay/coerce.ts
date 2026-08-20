import type { CapabilityArtifact, ParamType } from "../artifact/schema.js";
import type { ParamValue } from "../artifact/template.js";

/**
 * Turns caller-supplied values into the types a capability declares.
 *
 * Lifted out of the replay CLI so the HTTP layer uses the *same* coercion
 * table rather than a second one that could drift. The move fixed a real bug
 * in passing: `coerceOne` called `process.exit(1)` on a bad value, which is
 * fine in a CLI and fatal in a server. `process.exit` belonged to the CLI all
 * along — it is the caller's job to decide what a validation failure means.
 *
 * Errors are collected rather than thrown on the first bad field: a form that
 * reports one broken input at a time is miserable to use, and an agent gets a
 * better repair signal from the complete list.
 */

export interface FieldProblem {
  name: string;
  problem: string;
}

export class ParamValidationError extends Error {
  constructor(readonly fields: FieldProblem[]) {
    super(`Invalid parameters: ${fields.map((f) => `${f.name} (${f.problem})`).join("; ")}`);
    this.name = "ParamValidationError";
  }
}

export interface CoerceResult {
  params: Record<string, ParamValue>;
  /** Non-fatal notes — e.g. a supplied value the capability doesn't declare. */
  warnings: string[];
}

/**
 * Coerces one value using the artifact's declared type rather than guessing
 * from the text. The rule this replaced ("looks numeric -> Number()") turned
 * `memberId=0042` into 42 for a param declared `string` — harmless while
 * params only reached `fill`, and not harmless once they reach locators, URLs
 * and assertions.
 *
 * Accepts a non-string when a caller sends real JSON: if it already matches
 * the declared type it is taken as-is, otherwise it is stringified and run
 * through the identical path, so a dashboard form (strings only) and a
 * programmatic caller cannot diverge.
 */
export function coerceOne(name: string, value: unknown, type: ParamType): ParamValue {
  if (typeof value === "number" && (type === "number" || type === "currency")) {
    if (!Number.isFinite(value)) throw new ParamValidationError([{ name, problem: `must be a ${type}` }]);
    return value;
  }
  if (typeof value === "boolean" && type === "boolean") return value;

  const text = typeof value === "string" ? value : String(value ?? "");

  switch (type) {
    case "string":
    case "date":
      // Left verbatim on purpose: leading zeros, formatting and locale are all
      // meaningful to the app, and the artifact declared this as text.
      return text;
    case "boolean": {
      const lowered = text.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(lowered)) return true;
      if (["false", "0", "no", "off", ""].includes(lowered)) return false;
      throw new ParamValidationError([{ name, problem: `must be a boolean, got "${text}"` }]);
    }
    case "number":
    case "currency": {
      const cleaned = text.replace(/[$,\s]/g, "");
      // Number("") is 0, not NaN — check emptiness before parsing.
      const parsed = cleaned === "" ? Number.NaN : Number(cleaned);
      if (!Number.isFinite(parsed)) {
        throw new ParamValidationError([{ name, problem: `must be a ${type}, got "${text}"` }]);
      }
      return parsed;
    }
  }
}

/** Coerces every supplied value, collecting all problems before throwing. */
export function coerceParams(
  artifact: CapabilityArtifact,
  raw: Record<string, unknown>,
): CoerceResult {
  const declared = new Map(artifact.inputParams.map((p) => [p.name, p]));
  const params: Record<string, ParamValue> = {};
  const warnings: string[] = [];
  const problems: FieldProblem[] = [];

  for (const [name, value] of Object.entries(raw)) {
    const param = declared.get(name);
    if (!param) {
      warnings.push(`"${name}" is not declared by this capability; passing through as a string.`);
      params[name] = String(value ?? "");
      continue;
    }
    try {
      params[name] = coerceOne(name, value, param.type);
    } catch (err) {
      if (err instanceof ParamValidationError) problems.push(...err.fields);
      else problems.push({ name, problem: err instanceof Error ? err.message : String(err) });
    }
  }

  if (problems.length > 0) throw new ParamValidationError(problems);
  return { params, warnings };
}

/**
 * Coercion plus the checks a caller-facing invocation needs: every required
 * param present, and no blank value standing in for one. The engine's own
 * `validateParams` checks presence only, and by then a rejection is a thrown
 * error mid-run rather than a field-level message.
 */
export function validateInvocation(
  artifact: CapabilityArtifact,
  raw: Record<string, unknown>,
): CoerceResult {
  const problems: FieldProblem[] = [];
  for (const param of artifact.inputParams) {
    if (!param.required) continue;
    const value = raw[param.name];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
      problems.push({ name: param.name, problem: "is required" });
    }
  }
  if (problems.length > 0) throw new ParamValidationError(problems);
  return coerceParams(artifact, raw);
}
