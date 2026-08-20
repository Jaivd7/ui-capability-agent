import type { FrameLocator as PwFrameLocator, Locator, Page } from "playwright";
import type { FrameLocator, LocatorCandidate, LocatorChain } from "../artifact/schema.js";

/**
 * Resolves an artifact's LocatorChain/FrameLocator[] against a live
 * Playwright page. This is the one place that translates the artifact's
 * declarative "how to find this element" into an actual Playwright call —
 * used identically by the discovery loop (so what the model successfully
 * interacted with is provably the same resolution the replay engine will
 * later perform) and the replay engine (Phase 3). Keeping this shared,
 * rather than reimplemented per caller, is what makes "the recorded
 * locator strategy still works at replay time" a structural guarantee
 * rather than a hope.
 */

export interface ResolvedTarget {
  locator: Locator;
  candidate: LocatorCandidate;
  candidateIndex: number;
  /** How many elements this candidate matched. >1 means the chain fell back or the caller accepted ambiguity. */
  matchCount: number;
}

export class LocatorResolutionError extends Error {
  /**
   * True when every candidate simply failed to find a visible element in time,
   * as opposed to failing *structurally* — an invalid ARIA role, a malformed
   * CSS selector, a detached frame.
   *
   * The distinction matters for `notExists`, which treats a resolution failure
   * as proof of absence. Without it, an assertion passes precisely because its
   * own locator is broken, which is the most misleading way an assertion can
   * succeed.
   */
  public readonly allTimedOut: boolean;

  constructor(
    public readonly frame: FrameLocator[],
    public readonly chain: LocatorChain,
    public readonly attempts: { candidate: LocatorCandidate; error: string; timedOut: boolean }[],
  ) {
    super(
      `Could not resolve any locator candidate` +
        (frame.length ? ` in frame [${frame.map(describeFrame).join(" > ")}]` : "") +
        `. Tried ${attempts.length} candidate(s):\n` +
        attempts
          .map((a, i) => `  [${i}] ${describeCandidate(a.candidate)} -> ${a.error.split("\n")[0]}`)
          .join("\n"),
    );
    this.name = "LocatorResolutionError";
    this.allTimedOut = attempts.length > 0 && attempts.every((a) => a.timedOut);
  }
}

function describeFrame(f: FrameLocator): string {
  return `${f.strategy}=${f.value}`;
}

export function describeCandidate(c: LocatorCandidate): string {
  switch (c.strategy) {
    case "role":
      return `role(${c.role}${c.name ? `, name="${c.name}"` : ""})`;
    case "label":
      return `label("${c.text}")`;
    case "text":
      return `text("${c.text}")`;
    case "placeholder":
      return `placeholder("${c.text}")`;
    case "testId":
      return `testId("${c.testId}")`;
    case "css":
      return `css("${c.selector}")`;
    case "xpath":
      return `xpath("${c.expression}")`;
  }
}

function escapeAttrValue(v: string): string {
  return v.replace(/"/g, '\\"');
}

function frameSelector(f: FrameLocator): string {
  switch (f.strategy) {
    case "name":
      return `iframe[name="${escapeAttrValue(f.value)}"]`;
    case "url":
      return `iframe[src*="${escapeAttrValue(f.value)}"]`;
    case "index":
      return `:nth-match(iframe, ${f.value + 1})`;
  }
}

/** Walks a frame path down to the root (Page or nested FrameLocator) that locators should resolve against. */
export function resolveFrameRoot(page: Page, framePath: FrameLocator[]): Page | PwFrameLocator {
  let root: Page | PwFrameLocator = page;
  for (const f of framePath) {
    root = root.frameLocator(frameSelector(f));
  }
  return root;
}

function buildLocator(root: Page | PwFrameLocator, candidate: LocatorCandidate): Locator {
  switch (candidate.strategy) {
    case "role":
      // `role` is validated only as a non-empty string in the schema (not a
      // hand-maintained enum of the ~70 ARIA roles) — an invalid role name
      // surfaces here, as a normal LocatorResolutionError, which is an
      // acceptable place for that validation to live. See docs/artifact-schema.md.
      return root.getByRole(candidate.role as Parameters<typeof root.getByRole>[0], {
        ...(candidate.name !== undefined ? { name: candidate.name } : {}),
        exact: candidate.exact,
      });
    case "label":
      return root.getByLabel(candidate.text, { exact: candidate.exact });
    case "text":
      return root.getByText(candidate.text, { exact: candidate.exact });
    case "placeholder":
      return root.getByPlaceholder(candidate.text);
    case "testId":
      return root.getByTestId(candidate.testId);
    case "css":
      return root.locator(candidate.selector);
    case "xpath":
      return root.locator(`xpath=${candidate.expression}`);
  }
}

/**
 * Counts visible matches, capped — the number itself only matters as
 * "one" versus "more than one", and a locator matching hundreds of rows
 * shouldn't cost hundreds of visibility checks to find that out.
 */
const MAX_COUNTED_MATCHES = 5;

async function countVisible(all: Locator): Promise<number> {
  const total = await all.count();
  if (total <= 1) return total;
  let visible = 0;
  for (let i = 0; i < Math.min(total, MAX_COUNTED_MATCHES); i++) {
    if (await all.nth(i).isVisible()) visible += 1;
  }
  return visible;
}

export interface ResolveOptions {
  timeoutMs: number;
  /**
   * Reject a candidate that matches more than one visible element instead of
   * silently taking the first.
   *
   * Set for anything that *acts on* or *reads from* an element — a click, a
   * fill, an extract — where picking the wrong one of two matches produces a
   * confidently wrong result rather than an error. This is not hypothetical:
   * the mock app renders `<td>Savings Balance</td><td aria-label="Savings
   * Balance">$3482.10</td>`, so `role=cell, name="Savings Balance"` matches
   * both, and a live discovery run duly extracted the *label* as the member's
   * balance. Falling through to the next candidate turns that into a locator
   * the model can fix, rather than a plausible-looking wrong number.
   *
   * Left off for assertions and knownOutcome detectors, which ask "does
   * something like this exist" — two matching banners is still a yes.
   */
  requireUnique?: boolean;
  /** Optional hook invoked once per candidate attempt, for evidence logging. */
  onAttempt?: (candidate: LocatorCandidate, index: number, ok: boolean, matchCount?: number) => void;
}

/**
 * Tries each candidate in order. Every candidate gets an even share of the
 * overall timeout budget (simple, not adaptive) — see LEARNING_NOTES.md for
 * why an even split was chosen over a more sophisticated budget allocator.
 * Returns on the first candidate that resolves to a visible element;
 * throws LocatorResolutionError with every attempt's failure reason if none do.
 */
export async function resolveLocator(
  page: Page,
  frame: FrameLocator[],
  chain: LocatorChain,
  opts: ResolveOptions,
): Promise<ResolvedTarget> {
  const root = resolveFrameRoot(page, frame);
  const perCandidateMs = Math.max(500, Math.floor(opts.timeoutMs / chain.length));
  const attempts: { candidate: LocatorCandidate; error: string; timedOut: boolean }[] = [];

  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i]!;
    try {
      const all = buildLocator(root, candidate);
      const locator = all.first();
      await locator.waitFor({ state: "visible", timeout: perCandidateMs });
      const matchCount = await countVisible(all);
      if (opts.requireUnique && matchCount > 1) {
        throw new Error(
          `matched ${matchCount} visible elements; ambiguous for an action or extraction`,
        );
      }
      opts.onAttempt?.(candidate, i, true, matchCount);
      return { locator, candidate, candidateIndex: i, matchCount };
    } catch (err) {
      opts.onAttempt?.(candidate, i, false);
      attempts.push({
        candidate,
        error: err instanceof Error ? err.message : String(err),
        // Playwright names its wait timeouts; anything else means the locator
        // itself could not be evaluated.
        timedOut: err instanceof Error && err.name === "TimeoutError",
      });
    }
  }
  throw new LocatorResolutionError(frame, chain, attempts);
}
