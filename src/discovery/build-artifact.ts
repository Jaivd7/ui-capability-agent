import type { CapabilityArtifact, InputParam, Step, Target, ValueRef } from "../artifact/schema.js";
import { CURRENT_SCHEMA_VERSION } from "../artifact/schema.js";
import { computeContentHash } from "../artifact/hash.js";
import { parseArtifact } from "../artifact/index.js";
import {
  assertNoLeakedPageData,
  generalizeArtifact,
  type CompileFinding,
  type ExtractedRecord,
} from "./generalize.js";
import type { DiscoveryParam, DiscoveryResult } from "./loop.js";

export interface BuildArtifactOptions {
  id: string;
  name: string;
  description: string;
  version: number;
  target: Target;
  preconditions: CapabilityArtifact["preconditions"];
  params: DiscoveryParam[];
  discoveryResult: DiscoveryResult;
  knownOutcomes?: CapabilityArtifact["knownOutcomes"];
}

export interface BuildArtifactResult {
  artifact: CapabilityArtifact;
  /** Non-fatal things the compiler had to do or noticed. Feeds the recording scorer. */
  compileFindings: CompileFinding[];
}

/**
 * Compiles a successful discovery run into a validated CapabilityArtifact.
 *
 * The discovery loop executes with concrete values (e.g. memberId "1001"
 * literally typed in) for reliability — asking the model to reason in
 * templated placeholders mid-flow would be an unnecessary source of error.
 * Generalizing those concrete values is a mechanical, deterministic compile
 * step instead, and it happens in exactly two forms:
 *
 *  - **`ValueRef`** for what a step *types* (`fill`/`select`), where the value
 *    is the whole field and an exact match is the right rule.
 *  - **`${param}` templates** for everything a step or checkpoint *matches on*
 *    — locator strings, assertion values, urlTemplates, descriptions — where
 *    the param is usually embedded in surrounding text and may appear in a
 *    different surface form than it was typed in (`100` vs `$100.00`). See
 *    src/discovery/generalize.ts.
 *
 * The second form is what makes a capability genuinely reusable. Without it a
 * recording is parameterized in its steps and hardcoded in its verification:
 * every step succeeds for a different member, and then the checkpoint asserts
 * the *recorded* member's name and fails.
 */
export function buildArtifact(opts: BuildArtifactOptions): BuildArtifactResult {
  const inputParams: InputParam[] = opts.params.map((p) => ({
    name: p.name,
    type: p.type,
    required: true,
    sensitive: p.sensitive,
    example: p.exampleValue,
    ...(p.description !== undefined ? { description: p.description } : {}),
  }));

  const draft = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: opts.id,
    name: opts.name,
    description: opts.description,
    version: opts.version,
    contentHash: "pending",
    createdAt: new Date().toISOString(),
    discovery: {
      model: opts.discoveryResult.model,
      discoveredAt: new Date().toISOString(),
    },
    target: opts.target,
    preconditions: opts.preconditions,
    inputParams,
    outputs: opts.discoveryResult.outputs,
    steps: opts.discoveryResult.steps.map((step) => generalizeStepValue(step, opts.params)),
    checkpoints: opts.discoveryResult.checkpoints,
    knownOutcomes: opts.knownOutcomes ?? [],
  } as CapabilityArtifact;

  const { artifact: generalized, findings } = generalizeArtifact(draft, opts.params);

  // Throws. Runs after generalization on purpose: a param-derived literal has
  // by now become a template, so anything still matching is genuinely page
  // data rather than a false positive on the caller's own arguments.
  const leakFindings = assertNoLeakedPageData(generalized, opts.discoveryResult.extractedValues);

  const artifact: CapabilityArtifact = {
    ...generalized,
    contentHash: computeContentHash(generalized),
  };

  const result = parseArtifact(artifact);
  if (!result.success) {
    throw new Error(`Compiled artifact failed schema validation:\n${result.errors.join("\n")}`);
  }
  return { artifact: result.artifact, compileFindings: [...findings, ...leakFindings] };
}

/**
 * The `ValueRef` half: what a `fill` or `select` step types. Exact equality
 * against the raw example value, because a typed value is the entire field —
 * there is no surrounding text to match within, and a `ValueRef` resolves via
 * `String(value)` so a *formatted* surface could not be expressed as one
 * anyway. A fill value that matches only a formatted surface stays a literal
 * and the recording scorer flags it.
 */
function generalizeStepValue(step: Step, params: DiscoveryParam[]): Step {
  if (step.type !== "fill" && step.type !== "select") return step;
  return { ...step, value: generalizeValue(step.value, params) };
}

function generalizeValue(value: ValueRef, params: DiscoveryParam[]): ValueRef {
  if (value.kind !== "literal") return value;
  const match = params.find((p) => p.exampleValue === value.value);
  return match ? { kind: "param", param: match.name } : value;
}
