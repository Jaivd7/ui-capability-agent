import type { Page } from "playwright";

/**
 * Captures the current page state as an accessibility-tree-first text
 * representation for the model — never a screenshot for decision-making
 * (screenshots are captured separately, only as evidence on failure; see
 * src/logging). This keeps discovery aligned with the same "how do we
 * perceive the surface" strategy replay uses to act (role/name over pixels),
 * and is what should still work against a legacy app with no clean DOM.
 *
 * Same-origin iframes (the account-detail panel) are enumerated and
 * snapshotted separately, since Playwright's ariaSnapshot doesn't cross
 * frame boundaries on its own — each is labeled with the iframe's `name`
 * attribute so the model can reference it via a frame locator.
 */
export interface FrameObservation {
  name: string | null;
  src: string | null;
  snapshot: string;
}

export interface Observation {
  url: string;
  title: string;
  mainSnapshot: string;
  frames: FrameObservation[];
}

export async function observe(page: Page): Promise<Observation> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const mainSnapshot = await page
    .locator("body")
    .ariaSnapshot()
    .catch((err) => `<failed to capture accessibility snapshot: ${String(err)}>`);

  const frameHandles = await page.locator("iframe").all();
  const frames: FrameObservation[] = [];
  for (const handle of frameHandles) {
    const name = await handle.getAttribute("name").catch(() => null);
    const src = await handle.getAttribute("src").catch(() => null);
    let snapshot: string;
    try {
      const frameRoot = name
        ? page.frameLocator(`iframe[name="${name}"]`)
        : page.frameLocator("iframe").first();
      snapshot = await frameRoot.locator("body").ariaSnapshot();
    } catch (err) {
      snapshot = `<failed to capture frame accessibility snapshot: ${String(err)}>`;
    }
    frames.push({ name, src, snapshot });
  }

  return { url, title, mainSnapshot, frames };
}

export function renderObservation(obs: Observation): string {
  const parts = [`URL: ${obs.url}`, `Title: ${obs.title}`, ``, `Accessibility tree (top-level page):`, obs.mainSnapshot];
  for (const frame of obs.frames) {
    parts.push(
      ``,
      `Accessibility tree (iframe name="${frame.name ?? "(unnamed)"}", src="${frame.src ?? ""}"):`,
      frame.snapshot,
    );
  }
  return parts.join("\n");
}
