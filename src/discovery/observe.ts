import type { Page } from "playwright";
import { collectFormControls } from "./browser-scripts.js";

/**
 * Captures the current page state as an accessibility-tree-first text
 * representation for the model — never a screenshot for decision-making
 * (screenshots are captured separately, only as evidence on failure; see
 * src/logging). This keeps discovery aligned with the same "how do we
 * perceive the surface" strategy replay uses to act (role/name over pixels),
 * and is what should still work against a legacy app with no clean DOM.
 *
 * The accessibility tree is not always enough. A page with no <label>, role,
 * id or aria-* attribute anywhere — which is exactly the "legacy, no clean
 * DOM" case this project exists for — produces an aria snapshot in which every
 * text input is an anonymous textbox. The model then cannot see that the search
 * field is `name="by"`, guesses, and burns turns probing. So the observation
 * also carries a compact digest of the form controls actually present: name,
 * type, and for a <select> its option *values*.
 *
 * That digest is app-agnostic and cheap, and it closes the same gap the locator
 * guidance closes one layer up: perception was designed around an accessibility
 * tree, and a target without one needs the submission contract instead.
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

export interface FormControl {
  name: string;
  tag: string;
  type: string | null;
  /** Option values for a <select>, so the model selects by value rather than by a label that may embed volatile data. */
  options?: string[];
}

export interface Observation {
  url: string;
  title: string;
  mainSnapshot: string;
  formControls: FormControl[];
  frames: FrameObservation[];
}

export async function observe(page: Page): Promise<Observation> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const mainSnapshot = await page
    .locator("body")
    .ariaSnapshot()
    .catch((err) => `<failed to capture accessibility snapshot: ${String(err)}>`);

  const formControls = await readFormControls(page);

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

  return { url, title, mainSnapshot, formControls, frames };
}

/**
 * Read in one `evaluate` rather than via per-element Playwright calls: this
 * runs after every action, and a round trip per input would dominate the loop
 * on a form-heavy page.
 */
async function readFormControls(page: Page): Promise<FormControl[]> {
  return page.evaluate(collectFormControls).catch(() => []);
}

export function renderObservation(obs: Observation): string {
  const parts = [`URL: ${obs.url}`, `Title: ${obs.title}`, ``, `Accessibility tree (top-level page):`, obs.mainSnapshot];
  if (obs.formControls.length > 0) {
    parts.push(
      ``,
      `Form controls on this page (locate these by their name attribute):`,
      ...obs.formControls.map((c) => {
        const kind = c.tag === "select" ? "select" : `${c.tag}${c.type ? `[${c.type}]` : ""}`;
        const opts = c.options ? `  options: ${c.options.join(" | ")}` : "";
        return `- name="${c.name}"  ${kind}${opts}`;
      }),
    );
  }
  for (const frame of obs.frames) {
    parts.push(
      ``,
      `Accessibility tree (iframe name="${frame.name ?? "(unnamed)"}", src="${frame.src ?? ""}"):`,
      frame.snapshot,
    );
  }
  return parts.join("\n");
}
