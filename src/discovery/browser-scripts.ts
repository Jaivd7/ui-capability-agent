/// <reference lib="dom" />

/**
 * Code that runs *inside the page*, not in Node.
 *
 * Isolated in its own file with a scoped `dom` lib reference rather than
 * adding "DOM" to tsconfig's `lib`: the rest of this project is Node, and
 * making `document` and `window` globally resolvable would turn a genuine
 * mistake (reaching for a browser global in server code) into something the
 * compiler accepts.
 */

export interface RawFormControl {
  name: string;
  tag: string;
  type: string | null;
  options?: string[];
}

/** Collects the form controls on the current page. Serialized into the browser by Playwright. */
export function collectFormControls(): RawFormControl[] {
  const out: RawFormControl[] = [];
  for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type");
    // A hidden field is submitted by the browser automatically. Surfacing it
    // would invite the model to try to manage it by hand — which is exactly
    // the per-transaction-token problem that turns out not to exist when you
    // drive a real browser.
    if (tag === "input" && type === "hidden") continue;
    if (tag === "select") {
      out.push({ name, tag, type, options: Array.from((el as HTMLSelectElement).options).map((o) => o.value) });
    } else {
      out.push({ name, tag, type });
    }
  }
  return out;
}
