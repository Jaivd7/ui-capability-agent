import type { Page } from "playwright";
import type { AssertionKind, FrameLocator, LocatorChain } from "../artifact/schema.js";
import { resolveLocator } from "./locator.js";

/**
 * Shared by discovery (verifying the checkpoint a model proposes when it
 * calls `finish`) and replay (verifying the artifact's stored checkpoint,
 * and every knownOutcome detector). Using one implementation for both is
 * what makes "the checkpoint that passed during discovery" and "the
 * checkpoint replay verifies" the same claim rather than two similar-looking
 * but potentially drifting ones.
 */
export async function assertCondition(
  page: Page,
  frame: FrameLocator[],
  locator: LocatorChain,
  assertion: AssertionKind,
  expected: string | undefined,
  attributeName: string | undefined,
  timeoutMs: number,
): Promise<void> {
  if (assertion === "notExists") {
    const resolvedOrNull = await resolveLocator(page, frame, locator, { timeoutMs }).catch(() => null);
    if (resolvedOrNull) throw new Error("Expected element to not exist, but it was found.");
    return;
  }
  const resolved = await resolveLocator(page, frame, locator, { timeoutMs });
  switch (assertion) {
    case "exists":
      return;
    case "textEquals": {
      const text = (await resolved.locator.innerText()).trim();
      if (text !== expected) throw new Error(`Expected text "${expected}", got "${text}".`);
      return;
    }
    case "textContains": {
      const text = (await resolved.locator.innerText()).trim();
      if (!expected || !text.includes(expected)) {
        throw new Error(`Expected text to contain "${expected}", got "${text}".`);
      }
      return;
    }
    case "textMatches": {
      const text = (await resolved.locator.innerText()).trim();
      if (!expected || !new RegExp(expected).test(text)) {
        throw new Error(`Expected text to match /${expected}/, got "${text}".`);
      }
      return;
    }
    case "urlMatches": {
      const url = page.url();
      if (!expected || !new RegExp(expected).test(url)) {
        throw new Error(`Expected URL to match "${expected}", got "${url}".`);
      }
      return;
    }
    case "attributeEquals": {
      if (!attributeName) throw new Error("attributeEquals requires attributeName.");
      const value = await resolved.locator.getAttribute(attributeName);
      if (value !== expected) {
        throw new Error(`Expected attribute "${attributeName}" to equal "${expected}", got "${value}".`);
      }
      return;
    }
  }
}

/** True/false variant for probing knownOutcome detectors, where a non-match is expected most of the time. */
export async function detectorMatches(
  page: Page,
  frame: FrameLocator[],
  locator: LocatorChain,
  timeoutMs: number,
): Promise<boolean> {
  const resolved = await resolveLocator(page, frame, locator, { timeoutMs }).catch(() => null);
  return resolved !== null;
}
