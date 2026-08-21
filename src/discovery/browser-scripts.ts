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

// ---------------------------------------------------------------------------
// Operator console: enumerating what a human can act on
// ---------------------------------------------------------------------------

export interface RawPickerOption {
  value: string;
  label: string;
}

export interface RawPickerTarget {
  /**
   * `text` is a value the operator can *read off* the page rather than act on.
   *
   * It exists because a run that hard-failed on an extract step could not be
   * rescued: the console had no verb that puts a value into `outputs`, so an
   * operator could navigate to the page, see the balance, hand back, and still
   * be failed by the missing-outputs check. Naming these separately keeps the
   * action panel to things that change the page.
   */
  kind: "click" | "fill" | "select" | "text";
  /** What the operator reads. Never a selector. */
  label: string;
  /** A CSS selector verified unique *within this document*. */
  selector: string;
  /** Present for `select` only: the option values the page itself offers. */
  options?: RawPickerOption[];
}

/**
 * Collects everything on the page a human could act on, as (label, selector)
 * pairs.
 *
 * A sibling of `collectFormControls` rather than an extension of it, because
 * the consumer is different and so are the rules. That one feeds the discovery
 * model, which locates elements by their submission contract, so it skips
 * anything without a `name` and skips hidden fields as a matter of policy. A
 * human picking from a list needs the opposite: every control they can see,
 * named or not — a legacy form with an unnamed input is precisely the case
 * this project exists for — and each one needs a *label they can recognise*,
 * which the model never needed because it reads the accessibility tree.
 *
 * Nothing here knows anything about any particular application. The two
 * algorithms that make that true are `describe` and `uniqueSelector` below.
 */
export function collectPickerTargets(): RawPickerTarget[] {
  const CLICKABLE =
    'a[href], button, input[type="submit"], input[type="button"], input[type="image"], input[type="reset"], [role="button"], [role="link"]';
  const NON_TEXT_INPUT = ["hidden", "submit", "button", "image", "reset", "file"];

  function visible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    // A disabled control is on screen but not actionable; offering it produces
    // a Playwright timeout the operator has no way to interpret.
    return !(el as HTMLInputElement).disabled;
  }

  function clean(text: string | null | undefined): string {
    return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  /**
   * The label fallback chain, most meaningful first.
   *
   * The interesting rung is the table anchor. A server-rendered legacy app
   * routinely has no <label> anywhere and lays a form out as a table, so the
   * only thing identifying a field is the text in the cell to its left. That
   * is the same content-anchoring insight the recording scorer landed on, used
   * here for a human instead of for a locator.
   */
  function describe(el: Element): string {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const referenced = labelledBy
        .split(/\s+/)
        .map((id) => clean(el.ownerDocument.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(" ");
      if (referenced) return referenced;
    }

    const id = el.getAttribute("id");
    if (id) {
      const forLabel = clean(el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent);
      if (forLabel) return forLabel;
    }
    const wrapping = clean(el.closest("label")?.textContent);
    if (wrapping) return wrapping;

    // A link or a button *is* its text. A form control's textContent is
    // something else entirely — for a <select> it is every option
    // concatenated, which produced labels like
    // "MAIN-001 - Main OfficeWEST-014 - WestsideEAST-022 - Eastgate".
    const tag = el.tagName.toLowerCase();
    if (tag !== "select" && tag !== "input" && tag !== "textarea") {
      const own = clean(el.textContent);
      if (own) return own;
    }

    // How a legacy form labels its submit button: the text is the value.
    const value = clean(el.getAttribute("value"));
    if (value && tag === "input") return value;

    for (const attr of ["placeholder", "title", "alt"]) {
      const found = clean(el.getAttribute(attr));
      if (found) return found;
    }

    // Table anchor: the cell to the left, else the row's first cell.
    const cell = el.closest("td, th");
    if (cell) {
      const previous = clean(cell.previousElementSibling?.textContent);
      if (previous) return previous;
      const firstInRow = clean(cell.closest("tr")?.querySelector("td, th")?.textContent);
      if (firstInRow) return firstInRow;
    }

    const name = clean(el.getAttribute("name"));
    if (name) return name;

    const type = el.getAttribute("type");
    return `${el.tagName.toLowerCase()}${type ? `[${type}]` : ""}`;
  }

  function quote(value: string): string {
    return value.replace(/["\\]/g, "\\$&");
  }

  /**
   * A structural path, used only when the element offers no stable anchor of
   * its own. Verbose by design — it is the candidate of last resort, and it
   * being obviously positional is useful information to whoever reads the log.
   */
  function structuralPath(el: Element): string {
    const segments: string[] = [];
    let node: Element | null = el;
    while (node && node.tagName.toLowerCase() !== "html") {
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (!parent) {
        segments.unshift(tag);
        break;
      }
      const twins = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      segments.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
      node = parent;
      if (tag === "body") break;
    }
    return segments.join(" > ");
  }

  /**
   * The first candidate that matches exactly one element in this document.
   *
   * Ordered by how much meaning the anchor carries, not by syntax: an `id`, a
   * `name` (the form's submission contract, and the most stable thing on a
   * legacy form), the `href` a link points at, the `value` a submit button
   * carries — and only then a positional path. Uniqueness is *verified* rather
   * than assumed, because the action policy refuses an ambiguous selector and
   * an operator should never be offered a choice that will be refused.
   */
  function uniqueSelector(el: Element): string | null {
    const doc = el.ownerDocument;
    const tag = el.tagName.toLowerCase();
    const candidates: string[] = [];

    const id = el.getAttribute("id");
    if (id) candidates.push(`[id="${quote(id)}"]`);

    const name = el.getAttribute("name");
    if (name) {
      const type = el.getAttribute("type");
      candidates.push(type ? `${tag}[name="${quote(name)}"][type="${quote(type)}"]` : `${tag}[name="${quote(name)}"]`);
    }

    const href = el.getAttribute("href");
    if (href) candidates.push(`a[href="${quote(href)}"]`);

    const value = el.getAttribute("value");
    const type = el.getAttribute("type");
    if (value && tag === "input" && type) candidates.push(`input[type="${quote(type)}"][value="${quote(value)}"]`);

    candidates.push(structuralPath(el));

    for (const candidate of candidates) {
      try {
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        // A malformed candidate (an attribute value that defeats the quoting)
        // is skipped rather than thrown: the structural path always follows.
      }
    }
    return null;
  }

  const seen = new Set<string>();
  const targets: RawPickerTarget[] = [];

  function add(el: Element, kind: RawPickerTarget["kind"], options?: RawPickerOption[]): void {
    if (!visible(el)) return;
    const selector = uniqueSelector(el);
    if (!selector || seen.has(selector)) return;
    seen.add(selector);
    targets.push({ kind, label: describe(el), selector, ...(options ? { options } : {}) });
  }

  for (const el of Array.from(document.querySelectorAll(CLICKABLE))) add(el, "click");

  for (const el of Array.from(document.querySelectorAll("input, textarea"))) {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (el.tagName.toLowerCase() === "input" && NON_TEXT_INPUT.includes(type)) continue;
    add(el, "fill");
  }

  for (const el of Array.from(document.querySelectorAll("select"))) {
    const options = Array.from((el as HTMLSelectElement).options).map((o) => ({
      value: o.value,
      label: clean(o.textContent) || o.value,
    }));
    add(el, "select", options);
  }

  /**
   * Readable values: leaf elements carrying short text.
   *
   * Leaf-only (no element children) because an ancestor's text is the
   * concatenation of everything beneath it — offering the whole shares table as
   * one "value" would hand the operator a blob, and offering both it and its
   * cells would bury the cells. The tag list is where a legacy server-rendered
   * app puts a value; anything outside it is reachable through the raw selector.
   *
   * The label here is the text itself rather than `describe()`'s anchor, since
   * for a value the thing worth reading *is* the value — that is what lets the
   * operator confirm they picked the right cell before committing.
   */
  const READABLE = "td, th, span, div, p, dd, li, strong, b, em, code, label, h1, h2, h3, h4";
  for (const el of Array.from(document.querySelectorAll(READABLE))) {
    if (el.children.length > 0) continue;
    const text = clean(el.textContent);
    if (!text) continue;
    if (!visible(el)) continue;
    const selector = uniqueSelector(el);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    // Anchored on the cell to its left where there is one, so "$53.00" reads as
    // "Balance — $53.00" on the kind of table this app is built from.
    const anchor = describe(el);
    targets.push({
      kind: "text",
      label: anchor && anchor !== text ? `${text}   (${anchor})` : text,
      selector,
    });
  }

  return targets;
}
