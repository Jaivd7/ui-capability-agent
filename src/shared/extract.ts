import type { Locator } from "playwright";
import type { ExtractStepSchema } from "../artifact/schema.js";
import type { z } from "zod";

export type ReadSpec = z.infer<typeof ExtractStepSchema>["read"];

/** Reads a raw string from a resolved element per the artifact's `read` spec. */
export async function readRaw(locator: Locator, read: ReadSpec): Promise<string> {
  switch (read.from) {
    case "innerText":
      return locator.innerText();
    case "value":
      return locator.inputValue();
    case "href": {
      const href = await locator.getAttribute("href");
      if (href === null) throw new Error(`element has no "href" attribute`);
      return href;
    }
    case "attribute": {
      if (!read.attributeName) throw new Error(`read.from = "attribute" requires read.attributeName`);
      const value = await locator.getAttribute(read.attributeName);
      if (value === null) throw new Error(`element has no "${read.attributeName}" attribute`);
      return value;
    }
  }
}

/** Applies the declared transform, producing the value handed back to the caller. */
export function applyTransform(raw: string, transform: ReadSpec["transform"]): string | number {
  const trimmed = raw.trim();
  switch (transform) {
    case undefined:
      return trimmed;
    case "trim":
      return trimmed;
    case "currency": {
      // Accounting notation: "(1,234.56)" is negative twelve hundred, not
      // positive. Stripping punctuation first would have dropped the sign
      // silently and returned the wrong number with no error.
      const negative = /^\(.*\)$/.test(trimmed);
      const digits = trimmed.replace(/[^0-9.-]/g, "");
      const num = toFiniteNumber(digits, raw, "currency");
      return negative ? -Math.abs(num) : num;
    }
    case "number": {
      return toFiniteNumber(trimmed.replace(/,/g, ""), raw, "a number");
    }
    case "date": {
      const date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) throw new Error(`could not parse "${raw}" as a date`);
      return date.toISOString();
    }
  }
}

/**
 * `Number("")` is `0`, not `NaN` — so an empty or symbols-only cell used to
 * extract as the number **0** and throw nothing. On a capability whose whole
 * job is reading a balance, silently returning zero is the worst available
 * failure: the caller cannot tell it apart from a real zero balance.
 */
function toFiniteNumber(cleaned: string, raw: string, label: string): number {
  if (cleaned.trim() === "" || !/[0-9]/.test(cleaned)) {
    throw new Error(`could not parse "${raw}" as ${label}: no numeric content`);
  }
  const num = Number(cleaned);
  if (!Number.isFinite(num)) throw new Error(`could not parse "${raw}" as ${label}`);
  return num;
}

export async function extractValue(locator: Locator, read: ReadSpec): Promise<string | number> {
  const raw = await readRaw(locator, read);
  return applyTransform(raw, read.transform);
}
