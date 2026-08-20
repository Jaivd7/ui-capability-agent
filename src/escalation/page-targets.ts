import type { Frame, Page } from "playwright";
import { collectPickerTargets, type RawPickerTarget } from "../discovery/browser-scripts.js";
import type { FrameLocator } from "../artifact/schema.js";
import { resolveFrameRoot } from "../shared/locator.js";

/**
 * What the operator console offers a human to act on, read off the live page
 * every time the console renders.
 *
 * The console used to ask for a CSS selector. On a target with no ids, no test
 * IDs and no labels — the case this project exists for — that is not a usable
 * request: the operator is looking at a screenshot and would have to already
 * know that "Funds Transfer" is `a[href="/members/101555/transfer"]`. So the
 * server, which has the page, enumerates it instead.
 *
 * Nothing here is specific to any application or any page. It asks the
 * document what it contains, labels each control by the most meaningful thing
 * available (see `describe` in browser-scripts.ts), and hands back selectors it
 * has verified resolve to exactly one element. A page this code has never seen
 * produces a list the same way.
 */

export interface PageTarget extends RawPickerTarget {
  /** Empty for the main document. */
  frame: FrameLocator[];
  /** Shown next to the label so an operator knows a control is inside a frame. */
  frameLabel?: string;
}

/**
 * Reads the main document and every iframe one level down.
 *
 * One level rather than arbitrary depth: nested framesets exist but are rare,
 * and the recursion is only worth writing once something needs it. A control
 * deeper than that is missed by the picker and still reachable through the raw
 * selector escape hatch, which is exactly what that escape hatch is for.
 */
export async function describePageTargets(page: Page): Promise<PageTarget[]> {
  const targets: PageTarget[] = [];

  for (const raw of await collectFrom(page.mainFrame())) {
    targets.push({ ...raw, frame: [] });
  }

  for (const { frame, path, label } of await childFrames(page)) {
    for (const raw of await collectFrom(frame)) {
      // The in-page pass proved uniqueness within that document; this proves
      // the *frame path* resolves, which is the part Node guessed at. A target
      // that fails here would be refused by the action policy anyway, and
      // offering a choice that is going to be refused is worse than omitting it.
      const count = await resolveFrameRoot(page, path)
        .locator(raw.selector)
        .count()
        .catch(() => 0);
      if (count !== 1) continue;
      targets.push({ ...raw, frame: path, frameLabel: label });
    }
  }

  return targets;
}

async function collectFrom(frame: Frame): Promise<RawPickerTarget[]> {
  // A frame can detach or navigate between being listed and being read, which
  // is a normal race on a live page rather than a failure worth surfacing.
  return frame.evaluate(inPageSource(collectPickerTargets)).catch(() => []) as Promise<RawPickerTarget[]>;
}

/**
 * Serializes a browser-script for `evaluate`, with one shim.
 *
 * Playwright ships a function to the page via `toString()`, so what arrives is
 * the *compiled* source. tsx compiles with esbuild's `keepNames`, which wraps
 * every nested function declaration in a `__name(fn, "fn")` call so stack
 * traces survive minification. That helper is defined in the Node module
 * scope and not in the page, so any browser-script containing an inner
 * function throws `ReferenceError: __name is not defined` — which
 * `collectFrom`'s catch would then quietly turn into "this page has no
 * controls".
 *
 * `collectFormControls` predates this only because it happens to have no inner
 * functions. Defining an identity `__name` alongside the call is the smallest
 * fix that keeps the script written in checked TypeScript rather than as a
 * string literal.
 */
function inPageSource(fn: () => unknown): string {
  return `(() => { const __name = (f) => f; return (${fn.toString()})(); })()`;
}

interface ChildFrame {
  frame: Frame;
  path: FrameLocator[];
  label: string;
}

async function childFrames(page: Page): Promise<ChildFrame[]> {
  const metas = await page
    .$$eval("iframe", (els) =>
      els.map((el, index) => ({
        name: el.getAttribute("name"),
        src: el.getAttribute("src"),
        index,
      })),
    )
    .catch(() => [] as Array<{ name: string | null; src: string | null; index: number }>);

  const out: ChildFrame[] = [];
  for (const meta of metas) {
    // Addressed the same three ways the artifact schema's FrameLocator does,
    // in the same order of preference, so a frame the console can reach is a
    // frame a recorded step could have reached.
    const path: FrameLocator[] = meta.name
      ? [{ strategy: "name", value: meta.name }]
      : meta.src
        ? [{ strategy: "url", value: meta.src }]
        : [{ strategy: "index", value: meta.index }];

    const frame = meta.name
      ? page.frame({ name: meta.name })
      : (page.frames().find((f) => meta.src !== null && f.url().includes(meta.src)) ?? null);
    if (!frame) continue;

    out.push({ frame, path, label: meta.name ?? meta.src ?? `frame ${meta.index + 1}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * A picked target travels as one opaque form value.
 *
 * An index into the list would be simpler and wrong: the list is recomputed on
 * every render, so an index submitted from a tab opened thirty seconds ago can
 * address a different element than the one the operator read. Carrying the
 * selector itself makes a stale pick fail as "matches nothing on this page",
 * which is true and legible, instead of silently acting on the wrong control.
 */
export function encodePick(target: Pick<PageTarget, "selector" | "frame">): string {
  return JSON.stringify({ s: target.selector, f: target.frame });
}

export interface DecodedPick {
  selector: string;
  frame: FrameLocator[];
}

const FRAME_STRATEGIES = new Set(["name", "url", "index"]);

/** Returns undefined for anything that isn't a well-formed pick, including absent input. */
export function decodePick(raw: unknown): DecodedPick | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { s, f } = parsed as { s?: unknown; f?: unknown };
  if (typeof s !== "string" || s === "") return undefined;
  if (!Array.isArray(f)) return undefined;

  const frame: FrameLocator[] = [];
  for (const entry of f) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { strategy, value } = entry as { strategy?: unknown; value?: unknown };
    if (typeof strategy !== "string" || !FRAME_STRATEGIES.has(strategy)) return undefined;
    if (strategy === "index") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
      frame.push({ strategy: "index", value });
    } else {
      if (typeof value !== "string" || value === "") return undefined;
      frame.push({ strategy: strategy as "name" | "url", value });
    }
  }
  return { selector: s, frame };
}
