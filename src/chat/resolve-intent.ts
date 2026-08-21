import type Anthropic from "@anthropic-ai/sdk";
import type { InputParam } from "../artifact/schema.js";

/**
 * Resolving a sentence to a capability invocation — and stopping there.
 *
 * This is the console's only runtime model call, and it is deliberately not in
 * the execution path. It reads the catalog's *call contract* — names,
 * descriptions, typed input params — and answers one question: which capability
 * did this person mean, and which of its parameters did they actually state?
 * The answer becomes a prefilled invoke form. Nothing runs.
 *
 * That boundary is the design, not a shortcut:
 *
 *   **The model proposes; a person commits.** On a system whose whole argument
 *   is guardrails and human-in-the-loop control, the router structurally cannot
 *   post a transfer or place a hold — it fills in a form and a human presses
 *   Invoke. The guarantee holds even if the model is wrong, prompt-injected, or
 *   confidently hallucinating a member number.
 *
 *   **No capability output ever reaches the model.** Because the router hands
 *   off before execution, balances, e-mail addresses and phone numbers never
 *   enter a model context or a transcript. The redaction problem is avoided
 *   rather than managed.
 *
 *   **It adds no path a human did not already have.** Every URL it produces is
 *   one a person can type, and the catalog underneath it is untouched — see
 *   views/pages/ask.ts.
 */

/** Matches the discovery loop's default, so the console speaks to one model. */
export const ROUTER_MODEL = "claude-sonnet-5";

export interface RoutableCapability {
  id: string;
  name: string;
  description: string;
  inputParams: InputParam[];
}

export type Intent =
  | { kind: "capability"; capabilityId: string; params: Record<string, string> }
  | { kind: "unclear"; message: string };

/** The subset of the SDK this module uses, so a test can pass a stub. */
export interface RouterClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

const SYSTEM = `You route a request to exactly one recorded capability in a credit-union back-office console, and fill in only the values the request actually states.

Rules:
- Choose exactly one capability, by calling its tool. Never call more than one.
- Only pass a value the request actually states. Never invent, guess or default a member number, share code, amount, reason code, or any other identifier. Leaving a parameter out is always correct when the request does not state it: the person sees a form and fills in the rest.
- If no capability fits, or you cannot tell which one is meant, do not call a tool. Reply with one short sentence saying what is missing or what you could not find.
- You never execute anything. A person reviews the filled-in form and decides whether to run it.`;

/**
 * A JSON Schema per capability, generated from its declared `inputParams` —
 * the same contract the invoke form renders from. Nothing about any capability
 * is written down here.
 *
 * `required` is deliberately left empty even for params the artifact marks
 * required. A partially-filled form is the intended output for a partial
 * request ("look up a member's balance" with no member number), and the form
 * itself is a better place to ask for the rest than a second conversational
 * turn. Requiring them here would push the model toward inventing one, which is
 * the single worst thing it could do.
 */
export function toolsFor(capabilities: readonly RoutableCapability[]): Anthropic.Tool[] {
  return capabilities.map((cap) => {
    const properties: Record<string, { type: string; description?: string }> = {};
    for (const p of cap.inputParams) {
      properties[p.name] = {
        type: jsonTypeFor(p),
        ...(p.description ? { description: p.description } : {}),
      };
    }
    return {
      name: toolNameFor(cap.id),
      description: `${cap.name}. ${cap.description}`,
      input_schema: { type: "object" as const, properties, required: [] },
    };
  });
}

function jsonTypeFor(param: InputParam): string {
  switch (param.type) {
    case "number":
    case "currency":
      return "number";
    case "boolean":
      return "boolean";
    // A date is carried as a string; the invoke form renders the picker and
    // coerce.ts does the parsing, exactly as it does for a typed URL.
    case "date":
    case "string":
      return "string";
  }
}

/**
 * Tool names are constrained to `[a-zA-Z0-9_-]{1,64}`. Every current capability
 * id already satisfies that, so this is a guard rather than a transformation —
 * but an id is author-controlled and a malformed tool name is an API error at
 * the least convenient moment.
 */
export function toolNameFor(capabilityId: string): string {
  return capabilityId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

/**
 * Keeps only what the capability actually declares.
 *
 * The invoke form also accepts `role` as a prefill (the "permission denied"
 * demo link relies on it), so an unfiltered pass-through would let a model
 * emit `role=supervisor` and pre-stage a privilege escalation for a human to
 * rubber-stamp. Nothing but declared input params survives this function, and
 * `role` is never a declared input param.
 */
export function pickDeclaredParams(
  capability: RoutableCapability,
  raw: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return out;
  const source = raw as Record<string, unknown>;
  for (const param of capability.inputParams) {
    const value = source[param.name];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    const text = String(value).trim();
    if (text === "") continue;
    out[param.name] = text;
  }
  return out;
}

export interface ResolveIntentOptions {
  client: RouterClient;
  capabilities: readonly RoutableCapability[];
  model?: string;
  maxTokens?: number;
}

/**
 * One non-streaming call. A `tool_use` block is a routing decision; anything
 * else is the model saying it could not route, and its own words are the better
 * message to show.
 */
export async function resolveIntent(request: string, opts: ResolveIntentOptions): Promise<Intent> {
  const text = request.trim();
  if (!text) return { kind: "unclear", message: "Type what you want to do." };
  if (opts.capabilities.length === 0) {
    return { kind: "unclear", message: "No capabilities are recorded yet, so there is nothing to route to." };
  }

  const byToolName = new Map(opts.capabilities.map((c) => [toolNameFor(c.id), c]));

  const response = await opts.client.messages.create({
    model: opts.model ?? ROUTER_MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: SYSTEM,
    tools: toolsFor(opts.capabilities),
    messages: [{ role: "user", content: text }],
  });

  const said: string[] = [];
  for (const block of response.content) {
    if (block.type === "tool_use") {
      const capability = byToolName.get(block.name);
      // A tool name that is not in the map means the model invented one. Fall
      // through to the unclear path rather than routing to a guess.
      if (!capability) continue;
      return {
        kind: "capability",
        capabilityId: capability.id,
        params: pickDeclaredParams(capability, block.input),
      };
    }
    if (block.type === "text" && block.text.trim()) said.push(block.text.trim());
  }

  return {
    kind: "unclear",
    message: said.join(" ") || "No recorded capability matches that. The catalog below lists everything available.",
  };
}

/** The prefilled invoke URL an intent resolves to. Every one of these is typeable by hand. */
export function invokeUrlFor(intent: { capabilityId: string; params: Record<string, string> }): string {
  const query = Object.entries(intent.params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `/capabilities/${encodeURIComponent(intent.capabilityId)}/invoke${query ? `?${query}` : ""}`;
}
