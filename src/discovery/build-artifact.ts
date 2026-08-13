import type { CapabilityArtifact, InputParam, Step, Target, ValueRef } from "../artifact/schema.js";
import { computeContentHash } from "../artifact/hash.js";
import { parseArtifact } from "../artifact/index.js";
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

/**
 * Compiles a successful discovery run into a validated CapabilityArtifact.
 *
 * The discovery loop executes with concrete values (e.g. memberId "1001"
 * literally typed in) for reliability — asking the model to reason in
 * templated placeholders mid-flow would be an unnecessary source of error.
 * Generalizing those concrete values into `{kind:"param"}` references is a
 * mechanical, deterministic compile step instead: any literal fill/select
 * value or navigate urlTemplate segment that exactly matches a declared
 * param's example value is substituted here. This is the one place that
 * substitution happens, so it's auditable in one function rather than
 * scattered through the live loop.
 */
export function buildArtifact(opts: BuildArtifactOptions): CapabilityArtifact {
  const inputParams: InputParam[] = opts.params.map((p) => ({
    name: p.name,
    type: p.type,
    required: true,
    sensitive: p.sensitive,
    example: p.exampleValue,
    ...(p.description !== undefined ? { description: p.description } : {}),
  }));

  const steps = opts.discoveryResult.steps.map((step) => generalizeStep(step, opts.params));

  const draft: Omit<CapabilityArtifact, "contentHash"> = {
    schemaVersion: "1.0.0",
    id: opts.id,
    name: opts.name,
    description: opts.description,
    version: opts.version,
    createdAt: new Date().toISOString(),
    discovery: {
      model: opts.discoveryResult.model,
      discoveredAt: new Date().toISOString(),
    },
    target: opts.target,
    preconditions: opts.preconditions,
    inputParams,
    outputs: opts.discoveryResult.outputs,
    steps,
    checkpoints: opts.discoveryResult.checkpoints,
    knownOutcomes: opts.knownOutcomes ?? [],
  };

  const artifact: CapabilityArtifact = {
    ...draft,
    contentHash: computeContentHash(draft),
  };

  const result = parseArtifact(artifact);
  if (!result.success) {
    throw new Error(`Compiled artifact failed schema validation:\n${result.errors.join("\n")}`);
  }
  return result.artifact;
}

function generalizeStep(step: Step, params: DiscoveryParam[]): Step {
  if (step.type === "navigate") {
    return { ...step, urlTemplate: generalizeString(step.urlTemplate, params) };
  }
  if (step.type === "fill" || step.type === "select") {
    return { ...step, value: generalizeValue(step.value, params) };
  }
  return step;
}

function generalizeValue(value: ValueRef, params: DiscoveryParam[]): ValueRef {
  if (value.kind !== "literal") return value;
  const match = params.find((p) => p.exampleValue === value.value);
  return match ? { kind: "param", param: match.name } : value;
}

function generalizeString(literal: string, params: DiscoveryParam[]): string {
  let result = literal;
  for (const p of params) {
    if (p.exampleValue && result.includes(p.exampleValue)) {
      result = result.split(p.exampleValue).join(`\${${p.name}}`);
    }
  }
  return result;
}
