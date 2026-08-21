import { describe, expect, it } from "vitest";
import { describeTable, parseDelimitedTable } from "./tabular.js";

/**
 * The real shape, verified against Playwright: `innerText` on a table element
 * yields tab-separated cells and newline-separated rows, and `applyTransform`
 * with no declared transform only trims — so this is byte-for-byte what a
 * `meridian-read-member-record` run puts in `outputs.shares`.
 */
const SHARES = [
  "Share ID\tType\tBalance\tStatus",
  "100987-S0001\tRegular Shares\t$53.00\tHOLD [HOLD]",
  "100987-S0070\tShare Draft (Checking)\t$104.22\tHOLD [HOLD]",
  "100987-MMKT-11\tMoney Market\t$286.00\tOPEN",
].join("\n");

describe("parseDelimitedTable", () => {
  it("recovers the grid from an innerText-extracted shares table", () => {
    const t = parseDelimitedTable(SHARES);
    expect(t).not.toBeNull();
    expect(t!.header).toEqual(["Share ID", "Type", "Balance", "Status"]);
    expect(t!.rows).toHaveLength(3);
    // The column the whole feature exists to line up.
    expect(t!.rows.map((r) => r[2])).toEqual(["$53.00", "$104.22", "$286.00"]);
    expect(t!.rows[1]).toEqual(["100987-S0070", "Share Draft (Checking)", "$104.22", "HOLD [HOLD]"]);
  });

  it("keeps a status containing a space and brackets in one cell", () => {
    // "HOLD [HOLD]" is two words; splitting on whitespace rather than tabs
    // would put "[HOLD]" in a fifth column and shift nothing else, which is
    // exactly the silent corruption the tab delimiter avoids.
    expect(parseDelimitedTable(SHARES)!.rows[0]![3]).toBe("HOLD [HOLD]");
  });

  it("pads a short trailing row rather than rejecting it", () => {
    const t = parseDelimitedTable("A\tB\tC\n1\t2\t3\n4\t5");
    expect(t!.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", ""],
    ]);
  });

  it("refuses a row wider than its header instead of guessing", () => {
    expect(parseDelimitedTable("A\tB\n1\t2\t3")).toBeNull();
  });

  it("ignores blank lines between rows", () => {
    const t = parseDelimitedTable("A\tB\n\n1\t2\n\n3\t4\n");
    expect(t!.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("returns null for an ordinary single-value output", () => {
    // Every other output on the same run goes through this function too.
    expect(parseDelimitedTable("Turing, Alan")).toBeNull();
    expect(parseDelimitedTable("alan.turing@example.com")).toBeNull();
    expect(parseDelimitedTable("$53.00")).toBeNull();
  });

  it("returns null for a redacted sensitive value", () => {
    // What a restarted dashboard reads back off disk for a sensitive output.
    expect(parseDelimitedTable("S[REDACTED]]")).toBeNull();
  });

  it("returns null for non-strings and for a header with one column", () => {
    expect(parseDelimitedTable(42)).toBeNull();
    expect(parseDelimitedTable(undefined)).toBeNull();
    expect(parseDelimitedTable("only\nlines\nno tabs")).toBeNull();
    expect(parseDelimitedTable("A\n1")).toBeNull();
  });

  it("needs at least one data row", () => {
    expect(parseDelimitedTable("A\tB")).toBeNull();
  });
});

describe("describeTable", () => {
  it("summarises the grid for the value cell", () => {
    expect(describeTable(parseDelimitedTable(SHARES)!)).toBe("3 rows × 4 columns — shown below");
  });

  it("singularises a one-row table", () => {
    expect(describeTable(parseDelimitedTable("A\tB\n1\t2")!)).toBe("1 row × 2 columns — shown below");
  });
});
