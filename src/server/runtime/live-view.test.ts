import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { createLiveView, livePlaceholderSvg } from "./live-view.js";

/**
 * The registry's whole job is lifetime and failure containment: a page is
 * visible for exactly as long as the run holds it, and nothing a dying page
 * does may reach the request that asked for a picture of it.
 */

interface FakePage {
  page: Page;
  calls: number;
}

function fakePage(behaviour: () => Promise<Buffer>): FakePage {
  const fake: FakePage = {
    calls: 0,
    page: {
      screenshot: async () => {
        fake.calls += 1;
        return behaviour();
      },
    } as unknown as Page,
  };
  return fake;
}

describe("live view registry", () => {
  it("has no page for a run that was never registered", async () => {
    const liveView = createLiveView();
    expect(liveView.has("run-1")).toBe(false);
    await expect(liveView.screenshot("run-1")).resolves.toBeUndefined();
  });

  it("screenshots the registered page", async () => {
    const liveView = createLiveView();
    const fake = fakePage(async () => Buffer.from("png-bytes"));
    liveView.register("run-1", fake.page);

    expect(liveView.has("run-1")).toBe(true);
    await expect(liveView.screenshot("run-1")).resolves.toEqual(Buffer.from("png-bytes"));
  });

  it("stops answering once the run releases its page", async () => {
    const liveView = createLiveView();
    const fake = fakePage(async () => Buffer.from("png-bytes"));
    liveView.register("run-1", fake.page);
    liveView.release("run-1");

    expect(liveView.has("run-1")).toBe(false);
    await expect(liveView.screenshot("run-1")).resolves.toBeUndefined();
    // Not merely absent from the map — the page is never touched again, which
    // is what keeps a closed context from costing a timeout per request.
    expect(fake.calls).toBe(0);
  });

  it("resolves undefined when the capture fails, rather than rejecting", async () => {
    const liveView = createLiveView();
    // What a page closing mid-capture actually looks like.
    const fake = fakePage(async () => {
      throw new Error("Target page, context or browser has been closed");
    });
    liveView.register("run-1", fake.page);

    await expect(liveView.screenshot("run-1")).resolves.toBeUndefined();
  });

  it("collapses concurrent requests onto one capture", async () => {
    const liveView = createLiveView();
    let resolveShot: ((buf: Buffer) => void) | undefined;
    const fake = fakePage(() => new Promise<Buffer>((resolve) => (resolveShot = resolve)));
    liveView.register("run-1", fake.page);

    const first = liveView.screenshot("run-1");
    const second = liveView.screenshot("run-1");
    resolveShot?.(Buffer.from("png-bytes"));

    await expect(first).resolves.toEqual(Buffer.from("png-bytes"));
    await expect(second).resolves.toEqual(Buffer.from("png-bytes"));
    // A 1.5s poller against a slow page must not stack captures on it.
    expect(fake.calls).toBe(1);
  });

  it("captures again once the previous one has settled", async () => {
    const liveView = createLiveView();
    const fake = fakePage(async () => Buffer.from("png-bytes"));
    liveView.register("run-1", fake.page);

    await liveView.screenshot("run-1");
    await liveView.screenshot("run-1");

    expect(fake.calls).toBe(2);
  });

  it("keeps runs apart", async () => {
    const liveView = createLiveView();
    const one = fakePage(async () => Buffer.from("one"));
    const two = fakePage(async () => Buffer.from("two"));
    liveView.register("run-1", one.page);
    liveView.register("run-2", two.page);

    await expect(liveView.screenshot("run-1")).resolves.toEqual(Buffer.from("one"));
    await expect(liveView.screenshot("run-2")).resolves.toEqual(Buffer.from("two"));

    liveView.release("run-1");
    expect(liveView.has("run-2")).toBe(true);
  });
});

describe("live placeholder", () => {
  it("carries the reason as visible text and as an accessible name", () => {
    const svg = livePlaceholderSvg("Waiting for the browser session");
    expect(svg).toContain("<svg");
    expect(svg).toContain("Waiting for the browser session");
    expect(svg).toContain('aria-label="Waiting for the browser session"');
  });

  it("escapes a reason that would otherwise break the document", () => {
    const svg = livePlaceholderSvg('a <script> & "quotes"');
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });
});
