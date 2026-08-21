/**
 * Recovering the shape of a table that was extracted as one string.
 *
 * A capability that reads a whole table reads it in a single `extract` step —
 * `meridian-read-member-record`'s `shares` output is the example, and its
 * recording goal says why: "the number of shares differs from member to member
 * and per-cell steps would record one member's share count as the recipe." So
 * the artifact declares one string output and the run returns one string.
 *
 * That string is not shapeless. `readRaw` returns Playwright's `innerText`
 * verbatim and the default transform only trims, so what lands in `outputs` is
 * still tab-separated cells and newline-separated rows:
 *
 *   "Share ID\tType\tBalance\tStatus\n100987-S0001\tRegular Shares\t$53.00\tOPEN\n…"
 *
 * The structure was being lost at the last possible moment: HTML collapses tabs
 * and newlines to single spaces, so the run page rendered seventeen shares as
 * one unreadable line. Nothing was wrong with the extraction or the artifact.
 *
 * Nothing here knows anything about Meridian, shares, or balances. The
 * delimiters are a property of `innerText` on any table element, so any
 * capability against any application that extracts a table this way renders the
 * same way, with no per-app code.
 */

export interface DelimitedTable {
  /**
   * The first row.
   *
   * `innerText` erases the `th`/`td` distinction, so "the first row is the
   * header" is an assumption rather than something that can be detected. It
   * holds whenever the extracted element is a whole table including its heading
   * row, which is what anchoring the locator on a column heading produces. A
   * table captured without its headings renders its first data row as the
   * header — visibly odd, and the raw value is still shown underneath.
   */
  header: string[];
  rows: string[][];
}

/**
 * Returns the grid a string describes, or `null` if it does not describe one.
 *
 * Deliberately strict: a value that is not cleanly rectangular renders as the
 * plain string it always did. Guessing at a ragged grid would silently move
 * cells into the wrong columns, and a wrong balance under the right heading is
 * worse than an ugly line of text — that is the same reasoning the locator
 * layer applies when it refuses an ambiguous selector rather than taking the
 * first match.
 *
 * The one concession is short rows, which are padded: a trailing empty cell is
 * common in legacy markup and unambiguous to repair. A row *wider* than the
 * header is not repairable, so it rejects the whole value.
 */
export function parseDelimitedTable(value: unknown): DelimitedTable | null {
  if (typeof value !== "string") return null;
  if (!value.includes("\t") || !/\r?\n/.test(value)) return null;

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 2) return null;

  const header = lines[0]!.split("\t").map((c) => c.trim());
  if (header.length < 2) return null;

  const rows: string[][] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t").map((c) => c.trim());
    if (cells.length > header.length) return null;
    if (cells.length < 2) return null;
    while (cells.length < header.length) cells.push("");
    rows.push(cells);
  }
  if (rows.length === 0) return null;

  return { header, rows };
}

/** How the value cell describes a table it has handed off to be rendered below. */
export function describeTable(t: DelimitedTable): string {
  const rowLabel = t.rows.length === 1 ? "1 row" : `${t.rows.length} rows`;
  const colLabel = t.header.length === 1 ? "1 column" : `${t.header.length} columns`;
  return `${rowLabel} × ${colLabel} — shown below`;
}
