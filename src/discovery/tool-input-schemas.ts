import { z } from "zod";
import {
  AssertionKindSchema,
  CheckpointConditionSchema,
  FrameLocatorSchema,
  LocatorChainSchema,
  ParamTypeSchema,
} from "../artifact/schema.js";

/**
 * Runtime validators for each tool_use input. The JSON Schema in tools.ts
 * guides the model's generation; these zod schemas are what's actually
 * trusted before an action executes against the live browser. A tool call
 * that fails validation is reported back to the model as a tool_result
 * error (see loop.ts) so it can retry with a corrected call, rather than
 * crashing the run.
 */

export const NavigateInputSchema = z.object({
  url: z.string().min(1),
  description: z.string().min(1),
});

const targetable = {
  locator: LocatorChainSchema,
  frame: z.array(FrameLocatorSchema).default([]),
  description: z.string().min(1),
};

export const ClickInputSchema = z.object(targetable);

export const FillInputSchema = z.object({ ...targetable, value: z.string() });

export const SelectOptionInputSchema = z.object({ ...targetable, value: z.string() });

export const WaitForInputSchema = z.object({
  ...targetable,
  assertion: AssertionKindSchema,
  expected: z.string().optional(),
  attributeName: z.string().optional(),
});

export const ExtractInputSchema = z.object({
  locator: LocatorChainSchema,
  frame: z.array(FrameLocatorSchema).default([]),
  outputName: z.string().min(1),
  type: ParamTypeSchema,
  sensitive: z.boolean(),
  from: z.enum(["innerText", "value", "href", "attribute"]),
  attributeName: z.string().optional(),
  transform: z.enum(["trim", "currency", "number", "date"]).optional(),
  description: z.string().min(1),
});

export const FinishInputSchema = z.object({
  outcome: z.enum(["success", "dead_end"]),
  reason: z.string().min(1),
  checkpoints: z.array(CheckpointConditionSchema).default([]),
});
