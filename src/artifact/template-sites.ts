import type {
  AssertionKind,
  CapabilityArtifact,
  CheckpointCondition,
  FrameLocator,
  KnownOutcome,
  LocatorCandidate,
  LocatorChain,
  Step,
} from "./schema.js";

/**
 * The single definition of "which strings in an artifact may contain a
 * `${param}` template," expressed as a mapper rather than a visitor so its
 * three consumers can share one walk:
 *
 *   - `schema.ts`      validates template refs (returns the string unchanged)
 *   - `materialize.ts` resolves them against a caller's arguments
 *   - `generalize.ts`  authors them at compile time from a recording
 *
 * Keeping these on one walk is what stops the three from drifting — a site
 * that gets validated but not materialized would leave a `${x}` that silently
 * never substitutes, which is a wrong-behaviour hole rather than a loud one.
 *
 * Deliberately NOT walked: `LocatorCandidate.reason` (reviewer prose, and
 * excluded from the content hash) and `knownOutcomes[].outcome.code`/
 * `.message` (the caller-facing contract, which must be identical on every
 * invocation). Both are still scanned by the leak gate, which is a separate
 * concern from templating.
 */
export type TemplateSiteKind = "url" | "locator" | "assertion" | "frame" | "description";

export interface TemplateSite {
  /** e.g. "checkpoints[1].locator[0].name" — carried so a failure names the exact site. */
  path: string;
  kind: TemplateSiteKind;
  /** Set on `assertion` sites: lets a consumer know the value is compiled as a regex. */
  assertion?: AssertionKind;
}

export type StringMapper = (value: string, site: TemplateSite) => string;

function mapCandidate(c: LocatorCandidate, base: string, fn: StringMapper): LocatorCandidate {
  const at = (field: string, value: string): string =>
    fn(value, { path: `${base}.${field}`, kind: "locator" });
  switch (c.strategy) {
    case "role":
      return c.name === undefined ? c : { ...c, name: at("name", c.name) };
    case "label":
    case "text":
    case "placeholder":
      return { ...c, text: at("text", c.text) };
    case "testId":
      return { ...c, testId: at("testId", c.testId) };
    case "css":
      return { ...c, selector: at("selector", c.selector) };
    case "xpath":
      return { ...c, expression: at("expression", c.expression) };
  }
}

function mapChain(chain: LocatorChain, base: string, fn: StringMapper): LocatorChain {
  return chain.map((c, i) => mapCandidate(c, `${base}[${i}]`, fn)) as LocatorChain;
}

function mapFrame(frame: FrameLocator[], base: string, fn: StringMapper): FrameLocator[] {
  return frame.map((f, i) =>
    f.strategy === "index"
      ? f
      : { ...f, value: fn(f.value, { path: `${base}[${i}].value`, kind: "frame" }) },
  );
}

function mapExpected(
  expected: string | undefined,
  assertion: AssertionKind,
  base: string,
  fn: StringMapper,
): { expected?: string } {
  if (expected === undefined) return {};
  return { expected: fn(expected, { path: `${base}.expected`, kind: "assertion", assertion }) };
}

function mapStep(step: Step, base: string, fn: StringMapper): Step {
  const description = fn(step.description, { path: `${base}.description`, kind: "description" });
  if (step.type === "navigate") {
    return {
      ...step,
      description,
      urlTemplate: fn(step.urlTemplate, { path: `${base}.urlTemplate`, kind: "url" }),
    };
  }
  const common = {
    description,
    frame: mapFrame(step.frame, `${base}.frame`, fn),
    locator: mapChain(step.locator, `${base}.locator`, fn),
  };
  if (step.type === "waitFor") {
    return {
      ...step,
      ...common,
      ...mapExpected(step.expected, step.assertion, base, fn),
    };
  }
  return { ...step, ...common };
}

function mapCheckpoint(cp: CheckpointCondition, base: string, fn: StringMapper): CheckpointCondition {
  return {
    ...cp,
    description: fn(cp.description, { path: `${base}.description`, kind: "description" }),
    frame: mapFrame(cp.frame, `${base}.frame`, fn),
    locator: mapChain(cp.locator, `${base}.locator`, fn),
    ...mapExpected(cp.expected, cp.assertion, base, fn),
  };
}

function mapOutcome(o: KnownOutcome, base: string, fn: StringMapper): KnownOutcome {
  return {
    ...o,
    description: fn(o.description, { path: `${base}.description`, kind: "description" }),
    detect: {
      frame: mapFrame(o.detect.frame, `${base}.detect.frame`, fn),
      locator: mapChain(o.detect.locator, `${base}.detect.locator`, fn),
    },
  };
}

/** Applies `fn` to every templatable string in the artifact, returning a new artifact. */
export function mapArtifactStrings(artifact: CapabilityArtifact, fn: StringMapper): CapabilityArtifact {
  return {
    ...artifact,
    steps: artifact.steps.map((s, i) => mapStep(s, `steps[${i}]`, fn)),
    checkpoints: artifact.checkpoints.map((c, i) => mapCheckpoint(c, `checkpoints[${i}]`, fn)),
    knownOutcomes: artifact.knownOutcomes.map((o, i) => mapOutcome(o, `knownOutcomes[${i}]`, fn)),
  };
}

/** Read-only walk over the same sites, for validators and scorers that don't rebuild. */
export function forEachTemplateSite(
  artifact: CapabilityArtifact,
  visit: (value: string, site: TemplateSite) => void,
): void {
  mapArtifactStrings(artifact, (value, site) => {
    visit(value, site);
    return value;
  });
}

export { mapStep as mapStepStrings, mapCheckpoint as mapCheckpointStrings, mapOutcome as mapOutcomeStrings };
