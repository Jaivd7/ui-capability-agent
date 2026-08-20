import type {
  CapabilityArtifact,
  CheckpointCondition,
  FrameLocator,
  LocatorCandidate,
  LocatorChain,
  Step,
} from "../artifact/schema.js";
import { formatParam, parseTemplate, PARAM_FORMATS } from "../artifact/template.js";
import { forEachTemplateSite } from "../artifact/template-sites.js";
import type { ReplayResult } from "../replay/result.js";
import type { CompileFinding, ExtractedRecord } from "./generalize.js";

/**
 * Grades a freshly compiled recording and prints what a human reviewer would
 * want to know before approving it to run unattended.
 *
 * Warn-only by design: it never blocks a write. A discovery run costs real
 * API spend, and refusing to save an artifact because its locator chains are
 * thin would throw away a recording that is merely mediocre. The two things
 * that *are* refused (an extracted value in a checkpoint, a hardcoded amount)
 * are refused earlier and elsewhere, because those are correctness, not
 * quality.
 *
 * A pure function over the compiled artifact, so it can also be pointed at
 * `capabilities/*.json` from a test or a CI check without a browser.
 */

export type FindingCode =
  | "single_candidate_chain"
  | "brittle_locator_root"
  | "brittle_locator_only"
  | "unbound_data_literal"
  | "ungeneralized_param_literal"
  | "param_never_referenced"
  | "param_unverified"
  | "single_checkpoint"
  | "no_structural_checkpoint"
  | "output_unverified"
  | "weak_reason"
  | "irreversible_unmarked"
  | "compile_degraded"
  | "differential_probe_failed";

export type Severity = "error" | "warn" | "info";

export interface RecordingFinding {
  severity: Severity;
  code: FindingCode;
  /** e.g. "checkpoints[1].locator[0]" */
  where: string;
  message: string;
  suggestion?: string;
}

export interface RecordingMetrics {
  steps: number;
  chains: number;
  meanChainDepth: number;
  singleCandidateChains: number;
  brittleRootedChains: number;
  brittleOnlyChains: number;
  checkpoints: number;
  structuralCheckpoints: number;
  paramsDeclared: number;
  paramsBoundInSteps: number;
  paramsAssertedInCheckpoints: number;
  outputs: number;
  outputsVerified: number;
}

export interface RecordingScore {
  score: number;
  grade: "A" | "B" | "C" | "D";
  metrics: RecordingMetrics;
  findings: RecordingFinding[];
}

export interface ScoreContext {
  extractedValues?: Record<string, ExtractedRecord>;
  compileFindings?: CompileFinding[];
  /** The differential probe: this artifact replayed with a *different* parameter set. */
  probe?: { params: Record<string, unknown>; result: ReplayResult };
}

/** Tunable in one place rather than buried in the sum. */
export const FINDING_WEIGHTS: Record<Severity, number> = { error: 15, warn: 7, info: 2 };
/** Each additional instance of a code already charged. */
export const REPEAT_WEIGHT = 1;

const ACCESSIBILITY_STRATEGIES = new Set(["role", "label", "text", "placeholder"]);

/**
 * Distinguishes a *contract* selector from a *positional* one.
 *
 * The original rule was "css or xpath means brittle", which was right for a
 * target that had a real accessibility tree and is wrong for one that has
 * none: against MERIDIAN CORE every chain is css, so an undifferentiated rule
 * fires on 100% of them at error severity and the scorer stops being read.
 *
 * `[name="amount"]` is part of the form's submission contract — the app cannot
 * change it without changing what it posts — and `#id` is an explicit handle.
 * `tr:nth-child(2) td` is a description of where something happens to sit
 * today. Only the second kind is brittle.
 */
function isContractSelector(c: LocatorCandidate): boolean {
  if (c.strategy === "testId") return true;
  if (c.strategy !== "css") return false; // xpath is positional by nature
  const sel = c.selector;
  if (/:nth-child|:nth-of-type|:nth-match|:first|:last|[>+~]/.test(sel)) return false;
  return /\[[A-Za-z_:-]+\s*[~|^$*]?=/.test(sel) || /#[A-Za-z_]/.test(sel);
}

function isAccessibilityStrategy(c: LocatorCandidate): boolean {
  return ACCESSIBILITY_STRATEGIES.has(c.strategy);
}

/** A candidate a reviewer should be comfortable seeing first in a chain. */
function isStableCandidate(c: LocatorCandidate): boolean {
  return isAccessibilityStrategy(c) || isContractSelector(c);
}
const CURRENCY_LITERAL = /\$\s?[\d,]+\.\d{2}/;
const CONSEQUENTIAL = /\b(confirm|submit|delete|transfer|close|approve|post|void|apply|open|place|hold)\b/i;
const MIN_REASON_LENGTH = 15;

function chainsOf(artifact: CapabilityArtifact): { where: string; chain: LocatorChain }[] {
  const out: { where: string; chain: LocatorChain }[] = [];
  artifact.steps.forEach((step, i) => {
    if ("locator" in step) out.push({ where: `steps[${i}].locator`, chain: step.locator });
  });
  artifact.checkpoints.forEach((cp, i) => {
    out.push({ where: `checkpoints[${i}].locator`, chain: cp.locator });
  });
  // knownOutcome detectors are hand-authored preset content, not something
  // this recording produced, so they are not scored as recording quality.
  return out;
}

function candidateText(c: LocatorCandidate): string {
  switch (c.strategy) {
    case "role":
      return c.name ?? "";
    case "label":
    case "text":
    case "placeholder":
      return c.text;
    case "testId":
      return c.testId;
    case "css":
      return c.selector;
    case "xpath":
      return c.expression;
  }
}

function sameFrame(a: FrameLocator[], b: FrameLocator[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isStructural(cp: CheckpointCondition): boolean {
  if (cp.assertion === "urlMatches" || cp.assertion === "textMatches") return true;
  if (cp.assertion === "exists" || cp.assertion === "notExists") return true;
  // A text comparison is structural only if what it compares against comes
  // from the caller rather than from the page.
  return cp.expected !== undefined && parseTemplate(cp.expected).refs.length > 0;
}

function paramSpellings(artifact: CapabilityArtifact): Set<string> {
  const out = new Set<string>();
  for (const p of artifact.inputParams) {
    if (p.example === undefined) continue;
    for (const format of PARAM_FORMATS) {
      try {
        out.add(formatParam(p.example, format));
      } catch {
        // no meaningful rendering in this format
      }
    }
  }
  return out;
}

export function scoreRecording(artifact: CapabilityArtifact, ctx: ScoreContext = {}): RecordingScore {
  const findings: RecordingFinding[] = [];
  const chains = chainsOf(artifact);

  // --- locator chain quality ------------------------------------------------
  let singleCandidateChains = 0;
  let brittleRootedChains = 0;
  let brittleOnlyChains = 0;
  const reasonCounts = new Map<string, number>();

  for (const { where, chain } of chains) {
    if (chain.length === 1) {
      singleCandidateChains += 1;
      findings.push({
        severity: "warn",
        code: "single_candidate_chain",
        where,
        message: "no fallback candidate; the ordered chain degrades to a single selector",
        suggestion: "record 2-3 candidates, or state in the reason why no fallback exists",
      });
    }
    if (chain[0] && !isStableCandidate(chain[0])) {
      brittleRootedChains += 1;
      findings.push({
        severity: "warn",
        code: "brittle_locator_root",
        where: `${where}[0]`,
        message: `resolves first via a positional ${chain[0].strategy} selector rather than an accessible name or an attribute`,
      });
    }
    if (chain.every((c) => !isStableCandidate(c))) {
      brittleOnlyChains += 1;
      findings.push({
        severity: "error",
        code: "brittle_locator_only",
        where,
        message: "every candidate is positional; nothing anchors this to an accessible name or a form attribute",
        suggestion:
          "look for an accessible name, an aria-label, or a name/id attribute — a [name=...] selector is a contract, an nth-child is a guess",
      });
    }
    chain.forEach((c, i) => {
      reasonCounts.set(c.reason, (reasonCounts.get(c.reason) ?? 0) + 1);
      if (c.reason.trim().length < MIN_REASON_LENGTH) {
        findings.push({
          severity: "info",
          code: "weak_reason",
          where: `${where}[${i}].reason`,
          message: "reason is too short to tell a reviewer why this locator was trusted",
        });
      }
    });
  }
  for (const [reason, count] of reasonCounts) {
    if (count >= 3) {
      findings.push({
        severity: "info",
        code: "weak_reason",
        where: "(locator reasons)",
        message: `${count} candidates share the identical reason "${reason}"`,
      });
    }
  }

  // --- data literals that survived generalization ---------------------------
  const spellings = paramSpellings(artifact);
  const extracted = Object.entries(ctx.extractedValues ?? {});
  forEachTemplateSite(artifact, (value, site) => {
    if (site.path.startsWith("knownOutcomes")) return;
    for (const [outputName, record] of extracted) {
      const forms = new Set([record.raw.trim(), String(record.value)]);
      if (typeof record.value === "number") forms.add(`$${record.value.toFixed(2)}`);
      if ([...forms].some((f) => f.length >= 2 && value.includes(f))) {
        findings.push({
          severity: "error",
          code: "unbound_data_literal",
          where: site.path,
          message: `contains the value extracted as \`${outputName}\` (value withheld)`,
        });
        return;
      }
    }
    const currency = CURRENCY_LITERAL.exec(value);
    if (currency && !spellings.has(currency[0])) {
      findings.push({
        severity: "error",
        code: "unbound_data_literal",
        where: site.path,
        message: "contains a hardcoded currency amount that is not one of this capability's parameters",
      });
      return;
    }
    // A param's value present as a literal rather than a template means
    // generalization did not reach this site — the string is *correct* for the
    // recorded arguments and wrong for every other invocation. Static analysis
    // can see this one; the differential probe is what catches the page data
    // that no static rule can recognise.
    const referenced = new Set(parseTemplate(value).refs.map((r) => r.param));
    for (const param of artifact.inputParams) {
      if (param.example === undefined || referenced.has(param.name)) continue;
      const literal = [...PARAM_FORMATS]
        .map((format) => {
          try {
            return formatParam(param.example!, format);
          } catch {
            return "";
          }
        })
        .find((text) => text.length >= 2 && value.includes(text));
      if (literal !== undefined) {
        findings.push({
          severity: "warn",
          code: "ungeneralized_param_literal",
          where: site.path,
          message: `hardcodes the recorded value of \`${param.name}\` instead of referencing it`,
          suggestion: `use \${${param.name}} so this holds for any argument`,
        });
        return;
      }
    }
  });

  // --- call contract coverage ----------------------------------------------
  const boundInSteps = new Set<string>();
  const assertedInCheckpoints = new Set<string>();
  for (const step of artifact.steps) {
    if ("value" in step && step.value.kind === "param") boundInSteps.add(step.value.param);
  }
  forEachTemplateSite(artifact, (value, site) => {
    for (const ref of parseTemplate(value).refs) {
      if (site.path.startsWith("steps")) boundInSteps.add(ref.param);
      if (site.path.startsWith("checkpoints")) assertedInCheckpoints.add(ref.param);
    }
  });

  for (const param of artifact.inputParams) {
    if (!boundInSteps.has(param.name) && !assertedInCheckpoints.has(param.name)) {
      findings.push({
        severity: "error",
        code: "param_never_referenced",
        where: `inputParams.${param.name}`,
        message: "declared in the call contract but used by no step, url or checkpoint",
        suggestion: "the capability is advertising an argument it ignores; drop it or bind it",
      });
    } else if (!assertedInCheckpoints.has(param.name)) {
      findings.push({
        severity: "info",
        code: "param_unverified",
        where: `inputParams.${param.name}`,
        message: "used by a step but asserted by no checkpoint, so a wrong-target run would still pass",
      });
    }
  }

  // --- checkpoints ----------------------------------------------------------
  const structuralCheckpoints = artifact.checkpoints.filter(isStructural).length;
  if (artifact.checkpoints.length === 1) {
    findings.push({
      severity: "warn",
      code: "single_checkpoint",
      where: "checkpoints",
      message: "one checkpoint only; nothing separately proves the right page was reached",
    });
  }
  if (structuralCheckpoints === 0) {
    findings.push({
      severity: "warn",
      code: "no_structural_checkpoint",
      where: "checkpoints",
      message: "no checkpoint asserts structure (urlMatches/textMatches/exists or a param-derived value)",
    });
  }

  // --- outputs --------------------------------------------------------------
  let outputsVerified = 0;
  for (const output of artifact.outputs) {
    const producer = artifact.steps.find(
      (s): s is Extract<Step, { type: "extract" }> =>
        s.type === "extract" && s.outputName === output.name,
    );
    if (!producer) continue;
    const verified = artifact.checkpoints.some(
      (cp) =>
        sameFrame(cp.frame, producer.frame) &&
        cp.locator.some((c) =>
          producer.locator.some((p) => p.strategy === c.strategy && candidateText(p) === candidateText(c)),
        ),
    );
    if (verified) outputsVerified += 1;
    else {
      findings.push({
        severity: "info",
        code: "output_unverified",
        where: `outputs.${output.name}`,
        message: "no checkpoint touches the element this output is read from",
      });
    }
  }

  // --- risky steps ----------------------------------------------------------
  artifact.steps.forEach((step, i) => {
    if (step.type !== "click" || step.irreversible) return;
    const label = step.locator.map(candidateText).join(" ");
    if (CONSEQUENTIAL.test(label) || CONSEQUENTIAL.test(step.description)) {
      findings.push({
        severity: "info",
        code: "irreversible_unmarked",
        where: `steps[${i}]`,
        message: "looks like a consequential action but is not marked irreversible, so the guardrail will not gate it",
      });
    }
  });

  // --- carried in from the compiler and the probe ---------------------------
  for (const f of ctx.compileFindings ?? []) {
    findings.push({
      severity: f.severity,
      code: "compile_degraded",
      where: f.where,
      message: f.message,
    });
  }
  if (ctx.probe && ctx.probe.result.status !== "success") {
    const result = ctx.probe.result;
    const detail =
      result.status === "hard_failure"
        ? `${result.stepDescription}: ${result.reason}`
        : `${result.code}: ${result.message}`;
    findings.push({
      severity: "error",
      code: "differential_probe_failed",
      where: "(differential probe)",
      message: `replaying with ${JSON.stringify(ctx.probe.params)} gave ${result.status} — ${detail}`,
      suggestion:
        "this flow passed live moments ago with the recorded arguments, so something in it is fitted to those arguments rather than to the app",
    });
  }

  // Charged per distinct finding code, with a small increment per extra
  // instance. "Every chain in this recording is single-candidate" is one
  // systemic problem, not seven independent ones, and scoring it seven times
  // made a clean-but-thin recording grade the same as a broken one.
  const firstSeen = new Set<FindingCode>();
  let penalty = 0;
  for (const f of findings) {
    if (firstSeen.has(f.code)) {
      penalty += REPEAT_WEIGHT;
    } else {
      firstSeen.add(f.code);
      penalty += FINDING_WEIGHTS[f.severity];
    }
  }
  const score = Math.max(0, 100 - penalty);

  return {
    score,
    grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D",
    metrics: {
      steps: artifact.steps.length,
      chains: chains.length,
      meanChainDepth:
        chains.length === 0
          ? 0
          : Math.round((chains.reduce((n, c) => n + c.chain.length, 0) / chains.length) * 10) / 10,
      singleCandidateChains,
      brittleRootedChains,
      brittleOnlyChains,
      checkpoints: artifact.checkpoints.length,
      structuralCheckpoints,
      paramsDeclared: artifact.inputParams.length,
      paramsBoundInSteps: boundInSteps.size,
      paramsAssertedInCheckpoints: assertedInCheckpoints.size,
      outputs: artifact.outputs.length,
      outputsVerified,
    },
    findings,
  };
}

const SEVERITY_ORDER: Severity[] = ["error", "warn", "info"];

export function formatScoreReport(score: RecordingScore, capabilityId: string): string {
  const m = score.metrics;
  const pct = (n: number, of: number) => (of === 0 ? "" : ` (${Math.round((n / of) * 100)}%)`);
  const lines = [
    "",
    `Recording quality for "${capabilityId}": ${score.grade} (${score.score}/100)    [warn-only — the artifact was still written]`,
    "",
    "  metrics",
    `    steps                    ${m.steps}     locator chains           ${m.chains}`,
    `    mean chain depth         ${m.meanChainDepth.toFixed(1)}   single-candidate         ${m.singleCandidateChains}${pct(m.singleCandidateChains, m.chains)}`,
    `    positional-rooted        ${m.brittleRootedChains}     positional-only          ${m.brittleOnlyChains}`,
    `    checkpoints              ${m.checkpoints}     structural               ${m.structuralCheckpoints}/${m.checkpoints}`,
    `    params declared          ${m.paramsDeclared}     bound in steps           ${m.paramsBoundInSteps}/${m.paramsDeclared}     asserted in checkpoints  ${m.paramsAssertedInCheckpoints}/${m.paramsDeclared}`,
    `    outputs                  ${m.outputs}     verified by a checkpoint ${m.outputsVerified}/${m.outputs}`,
  ];

  if (score.findings.length > 0) {
    lines.push("", "  findings");
    for (const severity of SEVERITY_ORDER) {
      const bySeverity = score.findings.filter((x) => x.severity === severity);
      const seen = new Set<FindingCode>();
      for (const f of bySeverity) {
        if (seen.has(f.code)) continue;
        seen.add(f.code);
        const others = bySeverity.filter((x) => x.code === f.code);
        const where = others.length > 1 ? `${f.where} (+${others.length - 1} more)` : f.where;
        lines.push(`    ${severity.toUpperCase().padEnd(5)}  ${where}  ${f.message}`);
        if (f.suggestion) lines.push(`           -> ${f.suggestion}`);
      }
    }
  }

  const totals = SEVERITY_ORDER.map(
    (s) => `${score.findings.filter((f) => f.severity === s).length} ${s}(s)`,
  ).join(", ");
  lines.push("", `  ${totals}. Review before approving for unattended use.`, "");
  return lines.join("\n");
}
