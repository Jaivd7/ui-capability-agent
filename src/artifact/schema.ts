import { z } from "zod";

/**
 * The capability artifact schema — the contract between:
 *   - a human reviewer (can this be trusted to run unattended?)
 *   - the discovery loop (what it writes after a successful LLM-driven run)
 *   - the replay engine (what it executes with no LLM involved)
 *   - a calling AI agent (what it invokes, with what args, getting what back)
 *
 * See /docs/artifact-schema.md for the field-by-field rationale. This file is
 * the single source of truth: it is both the compile-time TS type (via
 * z.infer) and the runtime validator, so a malformed artifact can never
 * silently reach the replay engine.
 */

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/**
 * A single candidate for locating an element, tagged with *why* it was
 * chosen. Never used alone — always as one rung in a LocatorChain.
 *
 * Ordered roughly by robustness against a "no clean DOM" legacy surface:
 * role/label/text/placeholder survive markup rewrites because they key off
 * the accessibility tree; testId is ideal but rare in legacy apps; css/xpath
 * are last-resort, most brittle, kept only as a final fallback rung.
 */
export const LocatorCandidateSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("role"),
    // Should be a valid Playwright AriaRole (e.g. "button", "textbox", "row").
    // Kept as z.string() rather than a hand-maintained enum of the ~70 ARIA
    // roles — Playwright's getByRole() will reject an invalid role at
    // replay time, which is an acceptable place for that validation to live.
    role: z.string().min(1),
    name: z.string().optional(),
    exact: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    strategy: z.literal("label"),
    text: z.string().min(1),
    exact: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    strategy: z.literal("text"),
    text: z.string().min(1),
    exact: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    strategy: z.literal("placeholder"),
    text: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    strategy: z.literal("testId"),
    testId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    strategy: z.literal("css"),
    selector: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    strategy: z.literal("xpath"),
    expression: z.string().min(1),
    reason: z.string().min(1),
  }),
]);
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;

/** Ordered fallback chain: try [0] first, fall through on failure. */
export const LocatorChainSchema = z.array(LocatorCandidateSchema).min(1);
export type LocatorChain = z.infer<typeof LocatorChainSchema>;

/** Path into nested iframes, top-level page = []. */
export const FrameLocatorSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("name"), value: z.string().min(1) }),
  z.object({ strategy: z.literal("url"), value: z.string().min(1) }), // substring match on iframe src
  z.object({ strategy: z.literal("index"), value: z.number().int().nonnegative() }),
]);
export type FrameLocator = z.infer<typeof FrameLocatorSchema>;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Either a literal, or a reference to a named input param supplied at replay time. */
export const ValueRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("param"), param: z.string().min(1) }),
]);
export type ValueRef = z.infer<typeof ValueRefSchema>;

// ---------------------------------------------------------------------------
// Assertions (shared by checkpoints and waitFor steps)
// ---------------------------------------------------------------------------

export const AssertionKindSchema = z.enum([
  "exists",
  "notExists",
  "textEquals",
  "textContains",
  "urlMatches",
  "attributeEquals",
]);
export type AssertionKind = z.infer<typeof AssertionKindSchema>;

const assertionFieldsRequiringExpected: AssertionKind[] = [
  "textEquals",
  "textContains",
  "urlMatches",
  "attributeEquals",
];

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const stepCommon = {
  id: z.string().min(1),
  description: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  // If true, the replay engine may retry this step's wait a bounded number
  // of times on a timeout before treating it as a hard failure. This is the
  // step-local answer to "transient slowness"; it is distinct from the
  // app-level recovery actions attached to knownOutcomes (see below), which
  // handle *detected, named* conditions (e.g. session timeout) rather than
  // plain timeouts.
  retryable: z.boolean().default(false),
  // High-consequence action (state mutation that can't be trivially undone).
  // Gated by the guardrail layer (Phase 4): blocked or requires explicit
  // confirmation before executing, never silently run unattended.
  irreversible: z.boolean().default(false),
};

const targetableStep = {
  ...stepCommon,
  frame: z.array(FrameLocatorSchema).default([]),
  locator: LocatorChainSchema,
};

export const NavigateStepSchema = z.object({
  ...stepCommon,
  type: z.literal("navigate"),
  // e.g. "/members/${memberId}" — ${name} placeholders are substituted from
  // inputParams at replay time. Navigation targets the whole page, so it
  // deliberately has no `frame` field.
  urlTemplate: z.string().min(1),
});

export const ClickStepSchema = z.object({ ...targetableStep, type: z.literal("click") });

export const FillStepSchema = z.object({
  ...targetableStep,
  type: z.literal("fill"),
  value: ValueRefSchema,
});

export const SelectStepSchema = z.object({
  ...targetableStep,
  type: z.literal("select"),
  value: ValueRefSchema,
});

export const CheckStepSchema = z.object({
  ...targetableStep,
  type: z.literal("check"),
  checked: z.boolean().default(true),
});

export const WaitForStepSchema = z.object({
  ...targetableStep,
  type: z.literal("waitFor"),
  assertion: AssertionKindSchema,
  expected: z.string().optional(),
  attributeName: z.string().optional(),
});

export const ExtractStepSchema = z.object({
  ...targetableStep,
  type: z.literal("extract"),
  // Must match the `name` of one entry in the artifact's top-level `outputs`.
  outputName: z.string().min(1),
  read: z.object({
    from: z.enum(["innerText", "value", "href", "attribute"]),
    attributeName: z.string().optional(),
    transform: z.enum(["trim", "currency", "number", "date"]).optional(),
  }),
});

export const StepSchema = z.discriminatedUnion("type", [
  NavigateStepSchema,
  ClickStepSchema,
  FillStepSchema,
  SelectStepSchema,
  CheckStepSchema,
  WaitForStepSchema,
  ExtractStepSchema,
]);
export type Step = z.infer<typeof StepSchema>;

// ---------------------------------------------------------------------------
// Checkpoint (final success condition)
// ---------------------------------------------------------------------------

export const CheckpointConditionSchema = z
  .object({
    description: z.string().min(1),
    frame: z.array(FrameLocatorSchema).default([]),
    locator: LocatorChainSchema,
    assertion: AssertionKindSchema,
    expected: z.string().optional(),
    attributeName: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (assertionFieldsRequiringExpected.includes(c.assertion) && !c.expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `assertion "${c.assertion}" requires "expected" to be set`,
        path: ["expected"],
      });
    }
    if (c.assertion === "attributeEquals" && !c.attributeName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `assertion "attributeEquals" requires "attributeName" to be set`,
        path: ["attributeName"],
      });
    }
  });
export type CheckpointCondition = z.infer<typeof CheckpointConditionSchema>;

// ---------------------------------------------------------------------------
// Input params / outputs (the capability's call contract)
// ---------------------------------------------------------------------------

export const ParamTypeSchema = z.enum(["string", "number", "boolean", "date", "currency"]);
export type ParamType = z.infer<typeof ParamTypeSchema>;

export const InputParamSchema = z.object({
  name: z.string().min(1),
  type: ParamTypeSchema,
  required: z.boolean().default(true),
  description: z.string().optional(),
  // Never persisted in cleartext to artifact/log storage; masked wherever
  // this param's value would otherwise be logged (see src/guardrails/redact.ts).
  sensitive: z.boolean().default(false),
  example: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputFieldSchema = z.object({
  name: z.string().min(1),
  type: ParamTypeSchema,
  description: z.string().optional(),
  sensitive: z.boolean().default(false),
});
export type OutputField = z.infer<typeof OutputFieldSchema>;

// ---------------------------------------------------------------------------
// Known outcomes (the error-taxonomy seam)
// ---------------------------------------------------------------------------

const outcomeDetector = {
  id: z.string().min(1),
  description: z.string().min(1),
  // Which step's completion triggers checking for this outcome's signature.
  // Optional: omitted means "check after every step" (a condition like
  // session expiry can plausibly surface after any step, so this is the
  // common case). Set it only when a detector should be checked at one
  // specific, known point — e.g. a validation banner that can only ever
  // appear right after a particular form submission — since narrowing where
  // it's checked reduces the chance of an unrelated match elsewhere.
  checkAfterStepId: z.string().min(1).optional(),
  detect: z.object({
    frame: z.array(FrameLocatorSchema).default([]),
    locator: LocatorChainSchema,
  }),
};

/**
 * A named, expected business result (e.g. "member not found"). Capability-
 * specific by nature — discovered during this particular recording — so it
 * lives on the artifact, not in generic replay-engine config. Short-circuits
 * the run and is returned to the caller as a legitimate result, not an error.
 */
export const BusinessOutcomeSchema = z.object({
  ...outcomeDetector,
  classification: z.literal("business"),
  outcome: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

/**
 * A named, technical condition that a generic recovery action can resolve
 * (e.g. session timeout -> reauth). The *detector* is capability-specific
 * (where in this flow to look), but the *recovery action* it names is
 * app-level and implemented once in the replay engine's app config
 * (src/replay/app-config.ts) — not duplicated per capability.
 */
export const RecoverableOutcomeSchema = z.object({
  ...outcomeDetector,
  classification: z.literal("recoverable"),
  recovery: z.object({
    action: z.enum(["reauth", "dismissAndRetry", "reloadAndRetry"]),
    maxAttempts: z.number().int().positive().default(1),
  }),
});

export const KnownOutcomeSchema = z.discriminatedUnion("classification", [
  BusinessOutcomeSchema,
  RecoverableOutcomeSchema,
]);
export type KnownOutcome = z.infer<typeof KnownOutcomeSchema>;

// ---------------------------------------------------------------------------
// Target / preconditions / provenance
// ---------------------------------------------------------------------------

export const TargetSchema = z.object({
  // Vendor/app identity — stable across tenants running the same underlying
  // product. This, not baseUrl, is the multi-tenant reuse key (see REPORT.md
  // §4): two tenants on the same app share this value with different baseUrl.
  app: z.string().min(1),
  baseUrl: z.string().url(),
  entryRoute: z.string().min(1),
  // null in this project (no multi-tenancy implemented) — present as a
  // deliberate seam, not built out. A non-null value would mean "this
  // artifact carries tenant-specific overrides," per the design in REPORT.md.
  tenant: z.string().nullable().default(null),
});
export type Target = z.infer<typeof TargetSchema>;

export const PreconditionsSchema = z.object({
  authRequired: z.boolean().default(true),
  startRoute: z.string().optional(),
  requiredRole: z.string().optional(),
});
export type Preconditions = z.infer<typeof PreconditionsSchema>;

export const DiscoveryProvenanceSchema = z.object({
  model: z.string().min(1),
  discoveredAt: z.string().datetime(),
  sourceSessionId: z.string().optional(),
});
export type DiscoveryProvenance = z.infer<typeof DiscoveryProvenanceSchema>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const CapabilityArtifactSchema = z
  .object({
    // Version of this *format*, independent of the capability's own
    // revision. A future breaking schema change bumps this, not `version`.
    schemaVersion: z.literal("1.0.0"),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    // This capability's own revision — incremented each time discovery
    // re-records it (e.g. after the underlying app changes).
    version: z.number().int().positive(),
    // sha256 fingerprint of the semantically meaningful content (steps,
    // checkpoints, target identity) at save time — see hash.ts. Used to
    // detect drift when compared against a fresh recording later.
    contentHash: z.string().min(1),
    createdAt: z.string().datetime(),
    discovery: DiscoveryProvenanceSchema,
    target: TargetSchema,
    preconditions: PreconditionsSchema,
    inputParams: z.array(InputParamSchema).default([]),
    outputs: z.array(OutputFieldSchema).default([]),
    steps: z.array(StepSchema).min(1),
    checkpoints: z.array(CheckpointConditionSchema).min(1),
    knownOutcomes: z.array(KnownOutcomeSchema).default([]),
  })
  .superRefine((artifact, ctx) => {
    const stepIds = new Set<string>();
    for (const [i, step] of artifact.steps.entries()) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step id "${step.id}"`,
          path: ["steps", i, "id"],
        });
      }
      stepIds.add(step.id);
    }

    const paramNames = new Set(artifact.inputParams.map((p) => p.name));
    artifact.steps.forEach((step, i) => {
      const value = "value" in step ? step.value : undefined;
      if (value?.kind === "param" && !paramNames.has(value.param)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}" references unknown param "${value.param}"`,
          path: ["steps", i, "value", "param"],
        });
      }
      if (step.type === "navigate") {
        for (const match of step.urlTemplate.matchAll(/\$\{(\w+)\}/g)) {
          const paramName = match[1]!;
          if (!paramNames.has(paramName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `step "${step.id}" urlTemplate references unknown param "${paramName}"`,
              path: ["steps", i, "urlTemplate"],
            });
          }
        }
      }
    });

    const outputNames = new Set(artifact.outputs.map((o) => o.name));
    const producedOutputs = new Set<string>();
    artifact.steps.forEach((step, i) => {
      if (step.type === "extract") {
        if (!outputNames.has(step.outputName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `extract step "${step.id}" produces undeclared output "${step.outputName}"`,
            path: ["steps", i, "outputName"],
          });
        }
        producedOutputs.add(step.outputName);
      }
    });
    for (const output of artifact.outputs) {
      if (!producedOutputs.has(output.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `declared output "${output.name}" is never produced by an extract step`,
          path: ["outputs"],
        });
      }
    }

    artifact.knownOutcomes.forEach((outcome, i) => {
      if (outcome.checkAfterStepId !== undefined && !stepIds.has(outcome.checkAfterStepId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `knownOutcome "${outcome.id}" references unknown step "${outcome.checkAfterStepId}"`,
          path: ["knownOutcomes", i, "checkAfterStepId"],
        });
      }
    });
  });

export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
