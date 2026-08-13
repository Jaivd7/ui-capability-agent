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
      const num = Number(trimmed.replace(/[^0-9.-]/g, ""));
      if (Number.isNaN(num)) throw new Error(`could not parse "${raw}" as currency`);
      return num;
    }
    case "number": {
      const num = Number(trimmed.replace(/,/g, ""));
      if (Number.isNaN(num)) throw new Error(`could not parse "${raw}" as a number`);
      return num;
    }
    case "date": {
      const date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) throw new Error(`could not parse "${raw}" as a date`);
      return date.toISOString();
    }
  }
}

export async function extractValue(locator: Locator, read: ReadSpec): Promise<string | number> {
  const raw = await readRaw(locator, read);
  return applyTransform(raw, read.transform);
}
