import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import type { CheckpointCondition, OutputField, Step, Target } from "../artifact/schema.js";
import { assertCondition } from "../shared/assert.js";
import { applyTransform, readRaw } from "../shared/extract.js";
import { describeCandidate, LocatorResolutionError, resolveLocator } from "../shared/locator.js";
import { loadGuardrailsConfig } from "../guardrails/config.js";
import { evaluateGuardrails } from "../guardrails/policy.js";
import { redactTranscriptText, redactValue } from "../guardrails/redact.js";
import type { LogEvent, RunLogger } from "../logging/logger.js";
import type { DialogEvent } from "../shared/session.js";
import type { EscalationHandler, HumanIntervention, InterventionContext } from "../escalation/types.js";
import { observe, renderObservation } from "./observe.js";
import {
  ClickInputSchema,
  ExtractInputSchema,
  FillInputSchema,
  FinishInputSchema,
  NavigateInputSchema,
  SelectOptionInputSchema,
  WaitForInputSchema,
} from "./tool-input-schemas.js";
import { DISCOVERY_TOOLS } from "./tools.js";
import type { ExtractedRecord } from "./generalize.js";
import { getAppAdapter, type AppAdapter } from "../apps/index.js";
import { checkCheckpointQuality, violationMessage } from "./checkpoint-quality.js";

export interface DiscoveryParam {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "currency";
  exampleValue: string;
  sensitive: boolean;
  description?: string;
}

export interface RunDiscoveryOptions {
  runId: string;
  capabilityId: string;
  /**
   * Which app this run is recording against. Previously implicit — a
   * module-level factory resolved the one target that existed — which meant
   * neither the guardrail lookup nor the run log could say which system a run
   * had touched.
   */
  target: Target;
  /** The role the session authenticated as, recorded for provenance. */
  sessionRole: string;
  goal: string;
  params: DiscoveryParam[];
  page: Page;
  dialogEvents: DialogEvent[];
  logger: RunLogger;
  maxSteps?: number;
  timeoutMs?: number;
  model?: string;
  /**
   * When set, hitting max_steps/timeout/dead_end raises a "discovery_stuck"
   * intervention instead of just failing outright — the same pause/cede/
   * resume mechanism replay uses, applied to the "agent is stuck" trigger
   * from the brief rather than "replay hit a condition it can't recover
   * from." A human can complete the goal manually on the same live
   * session; discovery does not attempt to synthesize a capability from
   * their actions afterward (see LEARNING_NOTES.md's Phase 5 entry for why
   * that's a deliberate, documented cut, not an oversight) — a resumed run
   * ends as `escalated_completed`, recording what the human did, without a
   * compiled artifact.
   */
  escalate?: EscalationHandler;
}

export type DiscoveryOutcome = "success" | "dead_end" | "max_steps" | "timeout" | "escalated_completed" | "escalated_aborted";

export interface DiscoveryResult {
  outcome: DiscoveryOutcome;
  reason: string;
  steps: Step[];
  checkpoints: CheckpointCondition[];
  outputs: OutputField[];
  transcript: Anthropic.MessageParam[];
  model: string;
  /**
   * What this run actually read off the page, keyed by outputName. Consumed
   * by the artifact compiler to refuse emitting page data into checkpoints or
   * locators, and by the finish-time checkpoint gate — then dropped. Never
   * persisted anywhere: this is the leak-detection input, not evidence.
   */
  extractedValues: Record<string, ExtractedRecord>;
  humanIntervention?: HumanIntervention;
}

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const ACTION_TIMEOUT_MS = 8_000;
const DEFAULT_MODEL = "claude-sonnet-5";

function systemPrompt(params: DiscoveryParam[], adapter: AppAdapter): string {
  const paramLines = params
    .map(
      (p) =>
        `- ${p.name} (${p.type}${p.sensitive ? ", sensitive" : ""}): ${p.exampleValue}${
          p.description ? ` — ${p.description}` : ""
        }`,
    )
    .join("\n");
  return `You are operating ${adapter.displayName}, an internal back-office web application, on behalf of an authorized bank employee. You act the way a human operator would: reading the screen, then clicking and typing. You are ALREADY LOGGED IN.

You must accomplish exactly the stated goal — nothing more. In particular:
- Never click a final "Confirm", "Submit", or similarly consequential button beyond what the goal asks for. If the goal says "reach the confirmation screen," stop there — do not confirm/submit it.
- When the goal DOES ask you to complete such an action, set irreversible=true on that click. That flag is how replay knows to stop and ask a human before doing it unattended later; a consequential click recorded without it runs unsupervised. When in doubt, set it.
- Only act within this one application; never attempt to navigate to a different site or origin.

Call exactly one tool per turn. After each action you will be shown the resulting accessibility tree (and any iframe content) — use it to decide the next step; don't assume an action worked without observing the result.

${adapter.locatorGuidance}

The observation after each action lists the page's form controls by their name attribute, with a select's option values. Use that list — do not guess a field name, and do not use the extract tool to probe the page for one. Extract declares an output in this capability's public contract; every one you call adds a field the caller will receive forever.

NEVER LOCATE SOMETHING BY THE VALUE YOU ARE ABOUT TO READ FROM IT. You can see the value on the page in front of you, so it is tempting to write a locator naming it — but that value is different on every run, so the locator finds nothing the next time. Anchor on the *label* beside it, on the row it sits in, or on a static column heading. The same applies to anything you just extracted: a confirmation number, a balance and an account id are all run-specific, and a later step that locates by one of them is recorded as broken. A locator built this way is refused when the artifact is compiled.

A locator that matches more than one element is rejected outright for clicks, fills and extracts, so if you see that error, disambiguate rather than retrying the same idea. Always give a short "reason" for each locator candidate — it becomes part of a reviewable, reusable automation artifact, so the reasoning matters as much as the result. Give 2-3 candidates per element, ordered most robust first. The chain is a fallback list: if the first candidate stops resolving after a UI change, replay tries the next, so a one-candidate chain has no resilience at all. A single-candidate chain is acceptable only when you say in its "reason" why no second way to find this element exists.

CHECKPOINTS — how you must verify success.

A checkpoint is not a snapshot of this run. It is saved and re-run later, unchanged, against different members, different amounts and different dates. So:

- ASSERT STRUCTURE, NOT DATA. Assert that the member heading exists and contains "Member:" — never that it says "Member: Jane Smith". Assert that the balance cell exists and holds a dollar amount — never what the amount is.
- THE LOCATOR COUNTS TOO, not just "expected". A checkpoint has to *find* its element before it can assert anything, so a locator naming this run's data fails for every other input even when the assertion itself is generic. This is the single most common mistake, so concretely:

    WRONG: { locator: [{ strategy: "role", role: "heading", name: "Member: Jane Smith" }],
             assertion: "textContains", expected: "Member:" }
             (the assertion generalizes; the locator does not, so it resolves nothing for any other member)

    RIGHT: { locator: [{ strategy: "role", role: "heading", name: "Member:", exact: false }],
             assertion: "textContains", expected: "Member:" }

  Before you submit a checkpoint, read its locator back and ask: would this still find an element for a *different* member, amount or date? If not, cut the varying part out of it.
- NEVER put a value you read off the page into a checkpoint's "expected", into a locator's name/text/selector/expression, or into a checkpoint's description. That includes every value you extracted, and anything else that would differ for a different member, account or date. This is a hard rule: a finish call that breaks it is rejected and you will have to redo it.
- The input parameter values listed below ARE safe to assert. The caller supplies them, so they are part of the request rather than part of the page.
- Static application chrome is safe: page headings, banner text, column labels, button labels — anything identical for every member.

Prefer these assertions, in order:
  1. "urlMatches" on the route you should have landed on
  2. "exists" on a role+name locator whose name is static chrome
  3. "textContains" against a value that IS one of the input parameters — see below
  4. "textContains" with a static label prefix ("Member:", "Savings Balance")
  5. "textMatches" with a regex describing the SHAPE of a value you must not hardcode — e.g. ^\\$[0-9,]+\\.[0-9]{2}$ for "some dollar amount is shown"
  6. "attributeEquals" on a stable attribute

WHEN THE VALUE ON SCREEN IS ONE OF YOUR INPUT PARAMETERS, ASSERT IT EXACTLY. A confirmation screen echoing back the account type and deposit you requested is the strongest possible evidence the flow did what was asked, so assert those values as they appear on screen — "$100.00" for a deposit you entered as 100. Do NOT fall back to a shape regex for these: ^\\$[0-9,]+\\.[0-9]{2}$ would pass even if the app recorded the wrong amount. Shape regexes are for values you READ off the page and could not know in advance, such as a balance. These parameter values are generalized automatically after the run, so type them exactly as displayed.

LOCATING A CELL IN A LEGACY TABLE. When a value sits in a table cell with no aria-label, its own text is its accessible name, so it can be targeted as role "cell" with that text as the name — no positional CSS needed. A positional selector like table tr:nth-child(2) td:nth-child(2) makes a fine *second* candidate, but it should not be the first.

Give at least two checkpoints: one proving you are on the right page, and one proving the specific thing the goal asked for is present.

AT LEAST ONE CHECKPOINT MUST ASSERT AN INPUT PARAMETER, directly or through a URL derived from one. Without that, a run that searched correctly but landed on the *wrong record* still passes every check — the page looks right, it is simply the wrong member's. A urlMatches on the route containing the member number is usually the cheapest way to do this. (A parameter marked sensitive is the exception: never assert one of those, in a checkpoint or a locator.)

These are the parameter values available for this run — the variable data for this task. Type them in verbatim wherever the goal calls for them:
${paramLines || "(none)"}

When you extract a value from the page, mark "sensitive": true for any financial amount, account number, or personally identifying information.

When the goal is accomplished, call "finish" with outcome="success" and at least one checkpoint that verifies you actually reached the target state — don't just assume your last click worked, assert it. If you become genuinely stuck with no viable path forward, call "finish" with outcome="dead_end" and explain why.`;
}

let stepCounter = 0;
function nextStepId(): string {
  stepCounter += 1;
  return `step-${stepCounter}`;
}

export async function runDiscovery(opts: RunDiscoveryOptions): Promise<DiscoveryResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = opts.model ?? DEFAULT_MODEL;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  stepCounter = 0;

  const steps: Step[] = [];
  const outputs: OutputField[] = [];
  const extractedValues: Record<string, ExtractedRecord> = {};
  const messages: Anthropic.MessageParam[] = [];

  // Sensitive values populated as extract steps succeed (see the "extract"
  // case below). Every log line is scrubbed against this growing set before
  // it's written — the model can echo an already-extracted value back in its
  // own free text at any later point (its `finish` reasoning, in particular),
  // so redaction has to apply live, per event, not just once at the end of
  // the run against the full transcript (see cli.ts's separate transcript
  // redaction pass, which exists for the same reason but operates on the
  // Anthropic message history rather than this run log).
  const knownSensitiveValues: (string | number)[] = [];
  const logger: RunLogger = {
    filePath: opts.logger.filePath,
    log: (event) => opts.logger.log(redactLogEvent(event, knownSensitiveValues)),
  };

  logger.log({
    type: "run_start",
    kind: "discovery",
    // runId/capabilityId/app/baseUrl/role were all absent, so a discovery run
    // in a history view could not be attributed to a capability or a target
    // except by parsing its filename — which worked only by accident of how
    // runIds happen to be composed.
    runId: opts.runId,
    capabilityId: opts.capabilityId,
    app: opts.target.app,
    baseUrl: opts.target.baseUrl,
    role: opts.sessionRole,
    goal: opts.goal,
    model,
    maxSteps,
    timeoutMs,
  });

  const initialObs = await observe(opts.page);
  messages.push({
    role: "user",
    content: `Goal: ${opts.goal}\n\nCurrent state:\n${renderObservation(initialObs)}`,
  });
  logger.log({ type: "observation", url: initialObs.url });

  // Discovery's tool names don't all match the artifact's step-type
  // vocabulary 1:1 (select_option/wait_for vs. select/waitFor) — the
  // allowlist config is keyed on the artifact vocabulary since that's what
  // replay also uses, so this maps a proposed tool call onto the same
  // names before checking it against the same policy replay enforces.
  // Declared here, before the loop that calls executeTool — a `const`
  // declared textually *after* an infinite while(true) loop is in the
  // temporal dead zone for the loop's entire lifetime (the loop's body runs
  // to completion/return before source-order execution would ever reach a
  // statement below it), so any nested function the loop calls would throw
  // "Cannot access before initialization" the moment it referenced it. Hit
  // this for real on the first live discovery run after adding the
  // guardrail wiring — see LEARNING_NOTES.md's Phase 5 entry.
  const TOOL_NAME_TO_STEP_TYPE: Record<string, string> = {
    navigate: "navigate",
    click: "click",
    fill: "fill",
    select_option: "select",
    wait_for: "waitFor",
    extract: "extract",
  };

  let lastCheckpoints: CheckpointCondition[] = [];
  let iteration = 0;
  while (true) {
    iteration += 1;
    if (Date.now() - startedAt > timeoutMs) {
      return finalize("timeout", `Exceeded ${timeoutMs}ms wall-clock timeout after ${iteration - 1} step(s).`);
    }
    if (iteration > maxSteps) {
      return finalize("max_steps", `Exceeded ${maxSteps} max steps without reaching the goal.`);
    }

    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt(opts.params, getAppAdapter(opts.target.app)),
      tools: DISCOVERY_TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const reasoningText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();

    if (toolUses.length === 0) {
      logger.log({ type: "model_no_tool_call", reasoning: reasoningText });
      messages.push({
        role: "user",
        content: "You must call exactly one tool per turn. Please choose one of the available tools now.",
      });
      continue;
    }

    const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
    let finished: { outcome: DiscoveryOutcome; reason: string } | null = null;

    for (const [i, toolUse] of toolUses.entries()) {
      if (i > 0) {
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Skipped: only one tool call is processed per turn. Try this again on your next turn.",
        });
        continue;
      }

      logger.log({
        type: "model_decision",
        step: iteration,
        reasoning: reasoningText,
        tool: toolUse.name,
        input: redactToolInputForLog(toolUse.name, toolUse.input),
      });

      const outcome = await executeTool(opts, toolUse.name, toolUse.input, steps, outputs);
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: outcome.resultText,
        is_error: !outcome.ok,
      });
      logger.log({
        type: "action_result",
        step: iteration,
        tool: toolUse.name,
        ok: outcome.ok,
        detail: outcome.logDetail,
      });

      if (outcome.ok && toolUse.name === "finish" && outcome.finished) {
        finished = outcome.finished;
      }
    }

    messages.push({ role: "user", content: resultBlocks });

    if (finished) {
      if (finished.outcome === "success") {
        return finalize("success", finished.reason);
      }
      return finalize("dead_end", finished.reason);
    }
  }

  async function finalize(outcome: DiscoveryOutcome, reason: string): Promise<DiscoveryResult> {
    const checkpoints = lastCheckpoints;
    let finalOutcome = outcome;
    let humanIntervention: HumanIntervention | undefined;

    if (outcome !== "success" && opts.escalate) {
      const raisedAt = new Date().toISOString();
      const ctx: InterventionContext = {
        runId: opts.runId,
        capabilityId: opts.capabilityId,
        kind: "discovery_stuck",
        reason,
        currentUrl: opts.page.url(),
        goal: opts.goal,
      };
      const escalationOutcome = await opts.escalate(ctx);
      humanIntervention = {
        raisedAt,
        resolvedAt: new Date().toISOString(),
        kind: "discovery_stuck",
        reason,
        decision: escalationOutcome.decision,
        actions: escalationOutcome.actions,
      };
      finalOutcome = escalationOutcome.decision === "resumed" ? "escalated_completed" : "escalated_aborted";
    }

    logger.log({
      type: "run_end",
      outcome: finalOutcome,
      // Replay logs `status` and discovery logs `outcome`. Rather than rename
      // either (replay's is already correct and already committed in
      // evidence/), discovery additionally emits `status` in replay's
      // vocabulary so one reader can classify both without branching.
      status: finalOutcome === "success" || finalOutcome === "escalated_completed" ? "success" : "hard_failure",
      reason,
      stepCount: steps.length,
      outputCount: outputs.length,
      humanIntervened: humanIntervention !== undefined,
    });
    return { outcome: finalOutcome, reason, steps, checkpoints, outputs, transcript: messages, model, extractedValues, ...(humanIntervention ? { humanIntervention } : {}) };
  }

  async function executeTool(
    o: RunDiscoveryOptions,
    name: string,
    rawInput: unknown,
    stepsAcc: Step[],
    outputsAcc: OutputField[],
  ): Promise<{
    ok: boolean;
    resultText: string;
    logDetail: string;
    finished?: { outcome: DiscoveryOutcome; reason: string };
  }> {
    try {
      const stepType = TOOL_NAME_TO_STEP_TYPE[name];
      if (stepType) {
        const currentUrl = o.page.url();
        const targetUrl = stepType === "navigate" ? guessNavigateTargetUrl(rawInput, currentUrl) : undefined;
        const guardDecision = evaluateGuardrails(
          { type: stepType, irreversible: false },
          { currentUrl, ...(targetUrl !== undefined ? { targetUrl } : {}) },
          loadGuardrailsConfig(o.target.app),
        );
        if (!guardDecision.allowed) {
          const reason = `Blocked by guardrail: ${guardDecision.reason ?? "not permitted"}.`;
          logger.log({ type: "guardrail_blocked", tool: name, reason });
          return { ok: false, resultText: reason, logDetail: reason };
        }
      }
      switch (name) {
        case "navigate": {
          const input = NavigateInputSchema.parse(rawInput);
          const url = new URL(input.url, o.page.url()).toString();
          await o.page.goto(url, { timeout: ACTION_TIMEOUT_MS, waitUntil: "load" });
          stepsAcc.push({
            id: nextStepId(),
            description: input.description,
            type: "navigate",
            urlTemplate: input.url,
            retryable: false,
            irreversible: false,
          });
          return await observedSuccess(`Navigated to ${input.url}.`);
        }
        case "click": {
          const input = ClickInputSchema.parse(rawInput);
          const dialogsBefore = o.dialogEvents.length;
          const resolved = await resolveLocator(o.page, input.frame, input.locator, { timeoutMs: ACTION_TIMEOUT_MS, requireUnique: true });
          await resolved.locator.click({ timeout: ACTION_TIMEOUT_MS });
          logNewDialogs(o, dialogsBefore);
          stepsAcc.push({
            id: nextStepId(),
            description: input.description,
            type: "click",
            frame: input.frame,
            locator: input.locator,
            retryable: false,
            irreversible: input.irreversible,
          });
          return await observedSuccess(
            `Clicked (resolved via ${describeCandidate(resolved.candidate)}, candidate #${resolved.candidateIndex}).`,
          );
        }
        case "fill": {
          const input = FillInputSchema.parse(rawInput);
          const resolved = await resolveLocator(o.page, input.frame, input.locator, { timeoutMs: ACTION_TIMEOUT_MS, requireUnique: true });
          await resolved.locator.fill(input.value, { timeout: ACTION_TIMEOUT_MS });
          stepsAcc.push({
            id: nextStepId(),
            description: input.description,
            type: "fill",
            frame: input.frame,
            locator: input.locator,
            value: { kind: "literal", value: input.value },
            retryable: false,
            irreversible: false,
          });
          return await observedSuccess(
            `Filled (resolved via ${describeCandidate(resolved.candidate)}, candidate #${resolved.candidateIndex}).`,
          );
        }
        case "select_option": {
          const input = SelectOptionInputSchema.parse(rawInput);
          const resolved = await resolveLocator(o.page, input.frame, input.locator, { timeoutMs: ACTION_TIMEOUT_MS, requireUnique: true });
          await resolved.locator.selectOption(input.value, { timeout: ACTION_TIMEOUT_MS });
          stepsAcc.push({
            id: nextStepId(),
            description: input.description,
            type: "select",
            frame: input.frame,
            locator: input.locator,
            value: { kind: "literal", value: input.value },
            retryable: false,
            irreversible: false,
          });
          return await observedSuccess(
            `Selected (resolved via ${describeCandidate(resolved.candidate)}, candidate #${resolved.candidateIndex}).`,
          );
        }
        case "wait_for": {
          const input = WaitForInputSchema.parse(rawInput);
          await assertCondition(o.page, input.frame, input.locator, input.assertion, input.expected, input.attributeName, ACTION_TIMEOUT_MS);
          stepsAcc.push({
            id: nextStepId(),
            description: input.description,
            type: "waitFor",
            frame: input.frame,
            locator: input.locator,
            assertion: input.assertion,
            ...(input.expected !== undefined ? { expected: input.expected } : {}),
            ...(input.attributeName !== undefined ? { attributeName: input.attributeName } : {}),
            retryable: true,
            irreversible: false,
          });
          return await observedSuccess(`Condition held: ${input.assertion}.`);
        }
        case "extract": {
          const input = ExtractInputSchema.parse(rawInput);
          const resolved = await resolveLocator(o.page, input.frame, input.locator, { timeoutMs: ACTION_TIMEOUT_MS, requireUnique: true });
          const readSpec = {
            from: input.from,
            ...(input.attributeName !== undefined ? { attributeName: input.attributeName } : {}),
            ...(input.transform !== undefined ? { transform: input.transform } : {}),
          };
          // Split rather than calling extractValue, because the compiler's
          // leak check needs the *raw* page text too: a currency output
          // transforms "$3482.10" into the number 3482.1, and String(3482.1)
          // is not a substring of the string that actually leaks.
          const raw = await readRaw(resolved.locator, readSpec);
          const value = applyTransform(raw, readSpec.transform);
          extractedValues[input.outputName] = { raw, value, sensitive: input.sensitive };
          if (input.sensitive) {
            // Tracked so every subsequent log line — including the model's own
            // free-text reasoning, which can echo this value back in prose —
            // gets scrubbed for the rest of the run, not just this one event.
            // Both forms: scrubbing only the transformed value would leave the
            // raw "$3482.10" to survive on any path the currency regex misses.
            knownSensitiveValues.push(value, raw.trim());
          }
          if (!outputsAcc.some((out) => out.name === input.outputName)) {
            outputsAcc.push({
              name: input.outputName,
              type: input.type,
              sensitive: input.sensitive,
              description: input.description,
            });
          }
          stepsAcc.push({
            id: nextStepId(),
            description: input.description,
            type: "extract",
            frame: input.frame,
            locator: input.locator,
            outputName: input.outputName,
            read: readSpec,
            retryable: false,
            irreversible: false,
          });
          const displayValue = redactValue(value, input.sensitive);
          return await observedSuccess(`Extracted ${input.outputName} = ${displayValue}.`);
        }
        case "finish": {
          const input = FinishInputSchema.parse(rawInput);
          if (input.outcome === "success" && input.checkpoints.length === 0) {
            return {
              ok: false,
              resultText:
                'outcome="success" requires at least one checkpoint that verifies the goal state was reached. Please call finish again with a checkpoints array.',
              logDetail: "rejected: success with no checkpoints",
            };
          }
          if (input.checkpoints.length > 0) {
            // Quality before correctness: a checkpoint that asserts page data
            // would pass the live assertion below (it was just read off this
            // very page) and then fail for every other input the capability is
            // invoked with. Rejecting here costs one model turn and reuses the
            // is_error tool_result channel the model already self-corrects
            // from; the compiler's assertNoLeakedPageData is the backstop.
            const violations = checkCheckpointQuality(input.checkpoints, {
              extractedValues,
              params: o.params,
            });
            if (violations.length > 0) {
              logger.log({
                type: "checkpoint_rejected",
                count: violations.length,
                kinds: violations.map((v) => v.kind),
              });
              return {
                ok: false,
                resultText: violationMessage(violations, input.checkpoints),
                logDetail: `rejected: ${violations.length} checkpoint quality violation(s)`,
              };
            }
            for (const cp of input.checkpoints) {
              await assertCondition(o.page, cp.frame, cp.locator, cp.assertion, cp.expected, cp.attributeName, ACTION_TIMEOUT_MS);
            }
            lastCheckpoints = input.checkpoints;
          }
          return {
            ok: true,
            resultText: `Run finished: ${input.outcome}.`,
            logDetail: input.reason,
            finished: { outcome: input.outcome, reason: input.reason },
          };
        }
        default:
          return { ok: false, resultText: `Unknown tool "${name}".`, logDetail: "unknown tool" };
      }
    } catch (err) {
      if (err instanceof LocatorResolutionError) {
        return { ok: false, resultText: err.message, logDetail: err.message };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, resultText: `Action failed: ${message}`, logDetail: message };
    }

    async function observedSuccess(note: string): Promise<{ ok: true; resultText: string; logDetail: string }> {
      const obs = await observe(o.page);
      logger.log({ type: "observation", url: obs.url });
      return { ok: true, resultText: `${note}\n\nCurrent state:\n${renderObservation(obs)}`, logDetail: note };
    }
  }

  function logNewDialogs(o: RunDiscoveryOptions, countBefore: number): void {
    const newDialogs = o.dialogEvents.slice(countBefore);
    for (const d of newDialogs) {
      logger.log({ type: "dialog", dialogType: d.type, message: d.message, accepted: d.accepted });
    }
  }
}


/**
 * Best-effort peek at a not-yet-validated navigate tool call's target URL,
 * purely so the guardrail check can run *before* the full zod parse that
 * happens inside the switch below. If the input is malformed in a way that
 * defeats this, the guardrail check simply has no targetUrl to evaluate
 * (falls through on the currentUrl check alone) and the real schema
 * validation a few lines later reports the malformed input properly.
 */
function guessNavigateTargetUrl(rawInput: unknown, currentUrl: string): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  const url = (rawInput as { url?: unknown }).url;
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url, currentUrl).toString();
  } catch {
    return undefined;
  }
}

function redactToolInputForLog(toolName: string, input: unknown): unknown {
  if (toolName !== "fill" || typeof input !== "object" || input === null) return input;
  // fill values aren't known-sensitive at tool-call time (sensitivity is only
  // declared on extract) — logged as-is here since discovery only ever types
  // non-secret parameter values (memberId, deposit amount), never credentials
  // (see credentials.ts). Extracted sensitive values ARE redacted, above.
  return input;
}

/**
 * Scrubs a log event against every sensitive value extracted so far in the
 * run before it's written to disk. Structural: applied once, at the logger
 * wrapper in runDiscovery, rather than patched into each individual log call
 * site — a free-text field (the model's `reasoning`, a `finish` tool's
 * `reason`) can echo an already-extracted value back in prose at any later
 * point in the run, so every event from here on has to be checked, not just
 * the one that performed the extraction.
 */
function redactLogEvent(event: LogEvent, sensitiveValues: readonly (string | number)[]): LogEvent {
  if (sensitiveValues.length === 0) return event;
  return JSON.parse(redactTranscriptText(JSON.stringify(event), sensitiveValues)) as LogEvent;
}
