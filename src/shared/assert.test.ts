import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocatorChain } from "../artifact/schema.js";
import { assertCondition } from "./assert.js";

/**
 * Drives assertCondition against a real browser, using setContent rather than
 * the mock app — these are properties of the assertion layer itself, not of
 * any particular page.
 */
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(`
    <h1>Member: Alicia Gomez</h1>
    <table><tr><td>Savings Balance</td><td aria-label="Savings Balance">$3482.10</td></tr></table>
  `);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const heading: LocatorChain = [
  { strategy: "role", role: "heading", name: "Member:", exact: false, reason: "static prefix" },
];
const absent: LocatorChain = [
  { strategy: "role", role: "heading", name: "Nothing Like This", exact: false, reason: "not present" },
];
const brokenSelector: LocatorChain = [
  { strategy: "css", selector: "div:has-text(", reason: "deliberately malformed" },
];

describe("assertCondition", () => {
  it("exists passes for a present element", async () => {
    await expect(assertCondition(page, [], heading, "exists", undefined, undefined, 1000)).resolves.toBeUndefined();
  });

  it("textContains compares trimmed inner text", async () => {
    await expect(
      assertCondition(page, [], heading, "textContains", "Member:", undefined, 1000),
    ).resolves.toBeUndefined();
    await expect(
      assertCondition(page, [], heading, "textContains", "Nope", undefined, 1000),
    ).rejects.toThrow(/Expected text to contain/);
  });

  it("textMatches asserts a shape without asserting the value", async () => {
    const cell: LocatorChain = [
      { strategy: "label", text: "Savings Balance", exact: true, reason: "aria-label on the value cell" },
    ];
    await expect(
      assertCondition(page, [], cell, "textMatches", "^\\$[0-9,]+\\.[0-9]{2}$", undefined, 1000),
    ).resolves.toBeUndefined();
    await expect(
      assertCondition(page, [], cell, "textMatches", "^[A-Z]+$", undefined, 1000),
    ).rejects.toThrow(/Expected text to match/);
  });

  it("notExists passes when the element is genuinely absent", async () => {
    await expect(
      assertCondition(page, [], absent, "notExists", undefined, undefined, 1000),
    ).resolves.toBeUndefined();
  });

  it("notExists fails when the element is present", async () => {
    await expect(
      assertCondition(page, [], heading, "notExists", undefined, undefined, 1000),
    ).rejects.toThrow(/Expected element to not exist/);
  });

  it("notExists does NOT pass just because the locator itself is broken", async () => {
    // Previously this caught every error and read a malformed selector as
    // proof of absence — an assertion passing precisely because it is broken,
    // which is the most misleading way an assertion can succeed.
    await expect(
      assertCondition(page, [], brokenSelector, "notExists", undefined, undefined, 1000),
    ).rejects.toThrow();
  });
});
