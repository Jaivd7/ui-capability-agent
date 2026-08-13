import type Anthropic from "@anthropic-ai/sdk";

/**
 * Tool definitions for the discovery loop. Each action tool's `locator`
 * argument is shaped to mirror src/artifact/schema.ts's LocatorCandidate
 * union directly — the model proposes the same fallback-chain-with-reason
 * structure the artifact stores, so building a Step from a successful tool
 * call is a direct mapping, not a reverse-engineering pass over a raw
 * transcript. This JSON Schema is a generation aid, not the source of
 * truth; every tool_use input is re-validated against the real zod schema
 * (see loop.ts) before it's trusted.
 */

const locatorCandidateSchema = {
  type: "object",
  description:
    "One candidate for locating an element. Prefer accessibility-tree-based " +
    "strategies (role, label, text, placeholder) over css/xpath, which are " +
    "brittle last resorts for elements with no accessible name.",
  properties: {
    strategy: {
      type: "string",
      enum: ["role", "label", "text", "placeholder", "testId", "css", "xpath"],
    },
    role: { type: "string", description: "ARIA role, e.g. button, textbox, link, cell (strategy=role only)" },
    name: { type: "string", description: "accessible name (strategy=role only)" },
    text: { type: "string", description: "label/text/placeholder content (strategy=label|text|placeholder)" },
    testId: { type: "string", description: "data-testid value (strategy=testId only)" },
    selector: { type: "string", description: "CSS selector, last resort (strategy=css only)" },
    expression: { type: "string", description: "XPath expression, last resort (strategy=xpath only)" },
    exact: { type: "boolean", description: "exact text/name match, default false" },
    reason: {
      type: "string",
      description: "why this candidate should reliably identify the element, or why it's ranked where it is",
    },
  },
  required: ["strategy", "reason"],
} as const;

const locatorChainSchema = {
  type: "array",
  minItems: 1,
  items: locatorCandidateSchema,
  description:
    "Ordered fallback chain, tried [0] first. Provide 2-3 candidates when possible, " +
    "most robust (role/label/text) first, css/xpath last.",
};

const frameSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      strategy: { type: "string", enum: ["name", "url", "index"] },
      value: { description: "iframe name, a substring of its src, or a 0-based index" },
    },
    required: ["strategy", "value"],
  },
  description:
    "Path into nested iframes to reach this element. Empty array (default) means the top-level page. " +
    "Use strategy=\"name\" with the iframe's name attribute when the observation shows one.",
};

const assertionSchema = {
  type: "string",
  enum: ["exists", "notExists", "textEquals", "textContains", "urlMatches", "attributeEquals"],
};

export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL (relative paths are resolved against the current origin).",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" }, description: { type: "string" } },
      required: ["url", "description"],
    },
  },
  {
    name: "click",
    description: "Click an element.",
    input_schema: {
      type: "object",
      properties: { locator: locatorChainSchema, frame: frameSchema, description: { type: "string" } },
      required: ["locator", "description"],
    },
  },
  {
    name: "fill",
    description: "Type a literal value into a text input or textarea, replacing its current content.",
    input_schema: {
      type: "object",
      properties: {
        locator: locatorChainSchema,
        frame: frameSchema,
        value: { type: "string" },
        description: { type: "string" },
      },
      required: ["locator", "value", "description"],
    },
  },
  {
    name: "select_option",
    description: "Choose an option in a <select> dropdown by its visible label or value.",
    input_schema: {
      type: "object",
      properties: {
        locator: locatorChainSchema,
        frame: frameSchema,
        value: { type: "string" },
        description: { type: "string" },
      },
      required: ["locator", "value", "description"],
    },
  },
  {
    name: "wait_for",
    description:
      "Explicitly wait for a condition to hold before proceeding (e.g. after a slow-loading action). " +
      "Use this when the observation shows a loading state rather than the expected content.",
    input_schema: {
      type: "object",
      properties: {
        locator: locatorChainSchema,
        frame: frameSchema,
        assertion: assertionSchema,
        expected: { type: "string", description: "required for textEquals/textContains/urlMatches/attributeEquals" },
        attributeName: { type: "string", description: "required for attributeEquals" },
        description: { type: "string" },
      },
      required: ["locator", "assertion", "description"],
    },
  },
  {
    name: "extract",
    description: "Read a value from the page to include in the capability's output contract.",
    input_schema: {
      type: "object",
      properties: {
        locator: locatorChainSchema,
        frame: frameSchema,
        outputName: { type: "string", description: "short camelCase name for this output, e.g. savingsBalance" },
        type: { type: "string", enum: ["string", "number", "boolean", "date", "currency"] },
        sensitive: {
          type: "boolean",
          description: "true for financial amounts, account numbers, names, or other PII/regulated data",
        },
        from: { type: "string", enum: ["innerText", "value", "href", "attribute"] },
        attributeName: { type: "string", description: "required if from=attribute" },
        transform: { type: "string", enum: ["trim", "currency", "number", "date"] },
        description: { type: "string" },
      },
      required: ["locator", "outputName", "type", "sensitive", "from", "description"],
    },
  },
  {
    name: "finish",
    description:
      "Call this once the goal has been reached (or if genuinely stuck and no path forward exists). " +
      "On success, provide at least one checkpoint that verifies the goal state was actually reached — " +
      "don't assume a click worked, assert it.",
    input_schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["success", "dead_end"] },
        reason: { type: "string" },
        checkpoints: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              locator: locatorChainSchema,
              frame: frameSchema,
              assertion: assertionSchema,
              expected: { type: "string" },
              attributeName: { type: "string" },
            },
            required: ["description", "locator", "assertion"],
          },
          description: "Required when outcome=success. Omit or leave empty when outcome=dead_end.",
        },
      },
      required: ["outcome", "reason"],
    },
  },
];
