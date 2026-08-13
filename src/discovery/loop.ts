import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import type { CheckpointCondition, OutputField, Step } from "../artifact/schema.js";
import { assertCondition } from "../shared/assert.js";
import { extractValue } from "../shared/extract.js";
import { describeCandidate, LocatorResolutionError, resolveLocator } from "../shared/locator.js";
import { redactTranscriptText, redactValue } from "../guardrails/redact.js";
import type { LogEvent, RunLogger } from "../logging/logger.js";
import type { DialogEvent } from "../shared/session.js";
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

export interface DiscoveryParam {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "currency";
  exampleValue: string;
  sensitive: boolean;
  description?: string;
}

export interface RunDiscoveryOptions {
  goal: string;
  params: DiscoveryParam[];
  page: Page;
  dialogEvents: DialogEvent[];
  logger: RunLogger;
  maxSteps?: number;
  timeoutMs?: number;
  model?: string;
}

export type DiscoveryOutcome = "success" | "dead_end" | "max_steps" | "timeout";

export interface DiscoveryResult {
  outcome: DiscoveryOutcome;
  reason: string;
  steps: Step[];
  checkpoints: CheckpointCondition[];
  outputs: OutputField[];
  transcript: Anthropic.MessageParam[];
  model: string;
}

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const ACTION_TIMEOUT_MS = 8_000;
const DEFAULT_MODEL = "claude-sonnet-5";

function systemPrompt(params: DiscoveryParam[]): string {
  const paramLines = params
    .map(
      (p) =>
        `- ${p.name} (${p.type}${p.sensitive ? ", sensitive" : ""}): ${p.exampleValue}${
          p.description ? ` — ${p.description}` : ""
        }`,
    )
    .join("\n");
  return `You are operating Meridian Core Banking, an internal back-office web application, on behalf of an authorized bank employee. You act the way a human operator would: reading the screen, then clicking and typing. You are ALREADY LOGGED IN.

You must accomplish exactly the stated goal — nothing more. In particular:
- Never click a final "Confirm", "Submit", or similarly consequential button beyond what the goal asks for. If the goal says "reach the confirmation screen," stop there — do not confirm/submit it.
- Only act within this one application; never attempt to navigate to a different site or origin.

Call exactly one tool per turn. After each action you will be shown the resulting accessibility tree (and any iframe content) — use it to decide the next step; don't assume an action worked without observing the result.

Locate elements using the accessibility tree, not visual position: prefer role+name, then label/text/placeholder, and only fall back to a CSS selector or XPath when an element genuinely has no accessible name. Always give a short "reason" for each locator candidate — it becomes part of a reviewable, reusable automation artifact, so the reasoning matters as much as the result. Provide 2-3 fallback candidates when you reasonably can.

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

  logger.log({ type: "run_start", kind: "discovery", goal: opts.goal, model, maxSteps, timeoutMs });

  const initialObs = await observe(opts.page);
  messages.push({
    role: "user",
    content: `Goal: ${opts.goal}\n\nCurrent state:\n${renderObservation(initialObs)}`,
  });
  logger.log({ type: "observation", url: initialObs.url });

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
      system: systemPrompt(opts.params),
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

  function finalize(outcome: DiscoveryOutcome, reason: string): DiscoveryResult {
    const checkpoints = lastCheckpoints;
    logger.log({ type: "run_end", outcome, reason, stepCount: steps.length, outputCount: outputs.length });
    return { outcome, reason, steps, checkpoints, outputs, transcript: messages, model };
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
          const resolved = await resolveLocator(o.page, input.frame, input.locator, { timeoutMs: ACTION_TIMEOUT_MS });
          await resolved.locator.click({ timeout: ACTION_TIMEOUT_MS });
          logNewDialogs(o, dialogsBefore);
          stepsAcc.push({
            id: nextStepId(),
            description: input.description,
            type: "click",
            frame: input.frame,
            locator: input.locator,
            retryable: false,
            irreversible: false,
          });
          return await observedSuccess(
            `Clicked (resolved via ${describeCandidate(resolved.candidate)}, candidate #${resolved.candidateIndex}).`,
          );
        }
        case "fill": {
          const input = FillInputSchema.parse(rawInput);
          const resolved = await resolveLocator(o.page, input.frame, input.locator, { timeoutMs: ACTION_TIMEOUT_MS });
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
          const resolved = await resolveLocator(o.page, input.frame, input.locator, { timeoutMs: ACTION_TIMEOUT_MS });
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
          const resolved = await resolveLocator(o.page, input.frame, input.locator, { timeoutMs: ACTION_TIMEOUT_MS });
          const value = await extractValue(resolved.locator, {
            from: input.from,
            ...(input.attributeName !== undefined ? { attributeName: input.attributeName } : {}),
            ...(input.transform !== undefined ? { transform: input.transform } : {}),
          });
          if (input.sensitive) {
            // Tracked so every subsequent log line — including the model's own
            // free-text reasoning, which can echo this value back in prose —
            // gets scrubbed for the rest of the run, not just this one event.
            knownSensitiveValues.push(value);
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
            read: {
              from: input.from,
              ...(input.attributeName !== undefined ? { attributeName: input.attributeName } : {}),
              ...(input.transform !== undefined ? { transform: input.transform } : {}),
            },
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
