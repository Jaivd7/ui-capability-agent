import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePick, describePageTargets, encodePick } from "./page-targets.js";

/**
 * The picker exists so an operator never has to author a CSS selector, and the
 * only way to know it works is to point it at real markup in a real browser.
 *
 * The fixtures below are deliberately hostile in the way this project's targets
 * are: no ids, no test IDs, no `<label>`, a table layout, and a control inside
 * an iframe. None of them is any application this code knows about, which is
 * the property under test — the enumeration reads the page rather than
 * recognising it.
 */

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function load(html: string): Promise<void> {
  await page.setContent(html);
}

describe("describePageTargets", () => {
  it("labels a table-laid-out form from the cell beside each field", async () => {
    // No <label>, no id, no aria — the label is the text to the left, which is
    // how every server-rendered legacy form of this era is built.
    await load(`<table>
      <tr><td>Operator ID:</td><td><input type="text" name="operator"></td></tr>
      <tr><td>Password:</td><td><input type="password" name="password"></td></tr>
      <tr><td colspan="2"><input type="submit" value="Sign On"></td></tr>
    </table>`);

    const targets = await describePageTargets(page);

    expect(targets.filter((t) => t.kind === "fill").map((t) => t.label)).toEqual([
      "Operator ID:",
      "Password:",
    ]);
    // A submit button's text is its value attribute, not its textContent.
    expect(targets.find((t) => t.kind === "click")?.label).toBe("Sign On");
  });

  it("reports a select's own option values, and does not label it with them", async () => {
    // Regression: textContent on a <select> is every option concatenated, which
    // produced the label "MAIN-001 - Main OfficeWEST-014 - Westside...".
    await load(`<table><tr><td>Branch:</td><td>
      <select name="branch">
        <option value="MAIN-001">MAIN-001 - Main Office</option>
        <option value="WEST-014">WEST-014 - Westside</option>
      </select></td></tr></table>`);

    const [target] = (await describePageTargets(page)).filter((t) => t.kind === "select");

    expect(target?.label).toBe("Branch:");
    expect(target?.options?.map((o) => o.value)).toEqual(["MAIN-001", "WEST-014"]);
    // The value, not the visible text: a label can embed a balance that moves.
    expect(target?.options?.[0]?.label).toBe("MAIN-001 - Main Office");
  });

  it("offers a field that has no name, no id and no label at all", async () => {
    // `collectFormControls` skips these by design — it feeds a model that
    // locates by name. A human picking from a list needs to see it.
    await load(`<table><tr><td>Unlabelled:</td><td><input type="text"></td></tr></table>`);

    const targets = await describePageTargets(page);
    // The label cell is offered too, as a readable value; this test is about
    // the input.
    const fillable = targets.filter((t) => t.kind === "fill");

    expect(fillable).toHaveLength(1);
    await expect(page.locator(fillable[0]!.selector).count()).resolves.toBe(1);
  });

  it("every offered selector resolves to exactly one element", async () => {
    // The action policy refuses an ambiguous selector, so offering one would be
    // offering a choice guaranteed to be rejected.
    await load(`<table>
      <tr><td>A:</td><td><input type="text"></td><td><a href="/x">Go</a></td></tr>
      <tr><td>B:</td><td><input type="text"></td><td><a href="/y">Go</a></td></tr>
      <tr><td>C:</td><td><input type="text"></td><td><a href="/z">Go</a></td></tr>
    </table>`);

    const targets = await describePageTargets(page);

    // Three inputs and three links to act on, plus the three label cells as
    // readable values. Uniqueness is asserted over every one of them: a `text`
    // target is picked the same way and refused the same way if ambiguous.
    expect(targets.filter((t) => t.kind !== "text").length).toBe(6);
    expect(targets.filter((t) => t.kind === "text").length).toBe(3);
    for (const target of targets) {
      await expect(page.locator(target.selector).count(), target.selector).resolves.toBe(1);
    }
  });

  it("skips controls a human cannot act on", async () => {
    await load(`<div>
      <input type="hidden" name="_token" value="abc">
      <input type="text" name="disabled-one" disabled>
      <input type="text" name="invisible" style="display:none">
      <input type="text" name="usable">
    </div>`);

    const targets = await describePageTargets(page);

    expect(targets.map((t) => t.label)).toEqual(["usable"]);
  });

  it("reaches controls inside an iframe and records how to get back to them", async () => {
    // The frameset case is one of the surfaces this project exists for, and a
    // console that could only see the outer document could not fix it. Served
    // over a routed origin rather than setContent, because a data-URL parent
    // and a real child frame do not share a resolvable relationship.
    await page.route("https://example.test/**", (route) => {
      const body = route.request().url().endsWith("/panel.html")
        ? `<button>Inner Button</button>`
        : `<a href="/outer-link">Outer Link</a><iframe name="detail" src="/panel.html"></iframe>`;
      return route.fulfill({ contentType: "text/html", body });
    });
    await page.goto("https://example.test/outer.html", { waitUntil: "networkidle" });

    const targets = await describePageTargets(page);
    const inner = targets.find((t) => t.label === "Inner Button");

    expect(inner, `no target found inside the iframe; got ${targets.map((t) => t.label).join(", ")}`).toBeDefined();
    expect(inner?.frame).toEqual([{ strategy: "name", value: "detail" }]);
    expect(inner?.frameLabel).toBe("detail");
    // The outer document's own targets are unaffected and carry no frame.
    expect(targets.find((t) => t.label === "Outer Link")?.frame).toEqual([]);

    await page.unroute("https://example.test/**");
    await page.goto("about:blank");
  });

  it("offers a value cell that carries inline decoration, and anchors it on its row", async () => {
    // The exact markup MERIDIAN CORE renders for a share's status. Leaf-only
    // skipped the cell (it has a child) and the child alone reads "[HOLD]" —
    // the annotation without the value — so `status` could not be captured at
    // all. Verified against the live target before being written down here.
    await load(`<table>
      <tr class="lbl"><td>Share ID</td><td>Balance</td><td>Status</td></tr>
      <tr><td>101555-S0001</td><td>$17,925.98</td><td>HOLD <font class="err">[HOLD]</font></td></tr>
      <tr><td>101555-MMKT-4</td><td>$26.00</td><td>HOLD <font class="err">[HOLD]</font></td></tr>
    </table>`);

    const labels = (await describePageTargets(page)).filter((t) => t.kind === "text").map((t) => t.label);

    // The whole value, not just its decoration.
    expect(labels).toContain("HOLD [HOLD]   (101555-S0001)");
    expect(labels).toContain("HOLD [HOLD]   (101555-MMKT-4)");
    // And the two rows are told apart, which a bare "HOLD [HOLD]" could not do.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("offers nothing to act on for a page with nothing to do", async () => {
    await load(`<p>Maintenance in progress.</p>`);
    const targets = await describePageTargets(page);
    expect(targets.filter((t) => t.kind !== "text")).toEqual([]);
    // The message itself is still offered as a readable value, which is right:
    // a maintenance interstitial is exactly the page an operator lands on, and
    // its text may be the thing worth capturing.
    expect(targets.map((t) => t.label)).toEqual(["Maintenance in progress."]);
  });
});

describe("pick encoding", () => {
  it("round-trips a target through the form value", () => {
    const encoded = encodePick({ selector: 'a[href="/x"]', frame: [{ strategy: "name", value: "detail" }] });
    expect(decodePick(encoded)).toEqual({
      selector: 'a[href="/x"]',
      frame: [{ strategy: "name", value: "detail" }],
    });
  });

  it("rejects anything that is not a well-formed pick", () => {
    // The value comes back over HTTP, so it is caller-controlled: a bad one has
    // to fall through to the raw-selector path, not become a half-built action.
    for (const bad of [undefined, "", "not json", "[]", '{"s":""}', '{"s":"a"}', '{"s":"a","f":"x"}']) {
      expect(decodePick(bad), String(bad)).toBeUndefined();
    }
    expect(decodePick('{"s":"a","f":[{"strategy":"evil","value":"x"}]}')).toBeUndefined();
    expect(decodePick('{"s":"a","f":[{"strategy":"index","value":-1}]}')).toBeUndefined();
  });

  it("accepts a main-document pick", () => {
    expect(decodePick('{"s":"button","f":[]}')).toEqual({ selector: "button", frame: [] });
  });
});
