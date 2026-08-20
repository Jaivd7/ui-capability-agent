/**
 * The `${param}` template grammar used inside artifact strings.
 *
 * This exists because a capability is only genuinely parameterized if its
 * *verification* is parameterized too. Recording a flow against member 1001
 * and then asserting `heading "Member: Alicia Gomez"` produces an artifact
 * that walks every step correctly for member 1002 and then fails its own
 * checkpoint — parameterized in its steps, hardcoded in its proof. So the
 * `${name}` convention that already existed on `navigate.urlTemplate` is
 * generalized here to every string site that can legitimately depend on a
 * caller's argument (see docs/artifact-schema.md, "Parameterization and
 * templates", for the full site list and rationale).
 *
 * Three properties are load-bearing:
 *
 * 1. **The model never authors a template.** Discovery records concrete
 *    literals; `src/discovery/generalize.ts` introduces `${}` afterwards, as
 *    a mechanical compile step. So `src/shared/` — the locator and assertion
 *    code shared verbatim by discovery and replay — never sees a template,
 *    and stays params-free. That sharing is the project's central structural
 *    claim and this design preserves it rather than working around it.
 * 2. **One left-to-right pass; output is never re-scanned.** A substituted
 *    value containing `${y}` is inert. This is both the fix for the
 *    cascading-replacement bug in the old `generalizeString` and an
 *    injection guard on caller-supplied arguments.
 * 3. **Parses as a placeholder => must resolve. Doesn't parse => literal.**
 *    `${foo}` for an undeclared param throws (matching the behaviour of the
 *    `substituteUrlTemplate` this replaces); `${1}`, `${ x}` and a bare `$`
 *    are left verbatim, so a pathological CSS selector can't crash a run.
 */

/** A value a caller supplies for one declared input param. */
export type ParamValue = string | number | boolean;

/**
 * How a param's value is rendered at a given site. Deliberately explicit
 * (`${x:currency}`) rather than inferred from `inputParams[].type`, because
 * the *same* param needs different surface forms in different places: the
 * `fill` step types `100` into the deposit field, while the confirmation
 * screen renders `$100.00`. An implicit type-driven rule would have to pick
 * one and be wrong about the other.
 */
export type ParamFormat = "raw" | "currency" | "number" | "regexEscape";

export const PARAM_FORMATS: readonly ParamFormat[] = ["raw", "currency", "number", "regexEscape"];

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface TemplateRef {
  param: string;
  format: ParamFormat;
  /** The exact source text, e.g. "${openingDeposit:currency}". */
  source: string;
}

/**
 * Matches either the `${{` escape or a well-formed placeholder. Anything that
 * doesn't match here is literal text by definition — see property 3 above.
 *
 * The escape is `${{` rather than the more obvious `$${` because the latter is
 * ambiguous in exactly the case that matters: a regex assertion ending in a
 * literal `\$` immediately followed by a placeholder produces `$${`, which a
 * scanner cannot tell from an escaped `${`. `{` is not a legal first character
 * of an identifier, so `${{` can never be the start of a placeholder and the
 * two readings never collide.
 */
const SCANNER = /\$\{\{|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z][A-Za-z0-9_]*))?\}/g;

function isParamFormat(s: string): s is ParamFormat {
  return (PARAM_FORMATS as readonly string[]).includes(s);
}

/**
 * Parse without resolving. Used by the schema's cross-field validation and by
 * the recording scorer, neither of which has param *values* available.
 * `unknownFormats` is reported separately rather than thrown so a validator
 * can surface every problem in one pass instead of the first one.
 */
export function parseTemplate(s: string): { refs: TemplateRef[]; unknownFormats: string[] } {
  const refs: TemplateRef[] = [];
  const unknownFormats: string[] = [];
  for (const match of s.matchAll(SCANNER)) {
    const [source, param, format] = match;
    if (param === undefined) continue; // the `${{` escape
    if (format !== undefined && !isParamFormat(format)) {
      unknownFormats.push(format);
      continue;
    }
    refs.push({ param, format: (format as ParamFormat | undefined) ?? "raw", source });
  }
  return { refs, unknownFormats };
}

export function hasTemplate(s: string): boolean {
  SCANNER.lastIndex = 0;
  return SCANNER.test(s);
}

/**
 * Makes a literal safe to store at a templated site, such that
 * `renderTemplate(escapeLiteral(s), {}, w) === s` for any `s`.
 */
export function escapeLiteral(s: string): string {
  return s.split("${").join("${{");
}

/**
 * Renders `value` for a site expecting `format`.
 *
 * `currency` deliberately does NOT group thousands. The target app renders
 * `$${n.toFixed(2)}` (mock-app/views.ts), so a deposit of 1500 appears as
 * "$1500.00" — an Intl.NumberFormat currency formatter would emit "$1,500.00"
 * and produce a checkpoint that passes for 100 and silently fails for 1500.
 * The compiler picks a format by round-tripping it against the literal the
 * model actually observed on the page, so an app that *does* group would get
 * a new formatter here and be selected automatically, with no other change.
 */
export function formatParam(value: ParamValue, format: ParamFormat): string {
  switch (format) {
    case "raw":
      return String(value);
    case "number":
      return String(toNumber(value, format));
    case "currency":
      return `$${toNumber(value, format).toFixed(2)}`;
    case "regexEscape":
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

function toNumber(value: ParamValue, format: ParamFormat): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TemplateError(`cannot render "${String(value)}" with format "${format}"`);
    }
    return value;
  }
  const cleaned = String(value).replace(/[$,\s]/g, "");
  // Number("") is 0, not NaN — so an empty or symbols-only value would
  // otherwise render as "$0.00" and quietly assert the wrong thing. Reject it
  // explicitly rather than relying on the isFinite check below.
  if (cleaned === "") {
    throw new TemplateError(`cannot render "${String(value)}" with format "${format}": no numeric content`);
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new TemplateError(`cannot render "${String(value)}" with format "${format}"`);
  }
  return n;
}

/**
 * Resolves every placeholder in `s` against `params`. `where` is a path like
 * "checkpoints[1].locator[0].name", carried purely so a failure names the
 * exact site rather than just the offending string.
 */
export function renderTemplate(s: string, params: Record<string, ParamValue>, where: string): string {
  let out = "";
  let cursor = 0;
  SCANNER.lastIndex = 0;
  for (const match of s.matchAll(SCANNER)) {
    const [source, param, rawFormat] = match;
    const start = match.index;
    out += s.slice(cursor, start);
    cursor = start + source.length;

    if (param === undefined) {
      out += "${"; // the `${{` escape
      continue;
    }
    if (rawFormat !== undefined && !isParamFormat(rawFormat)) {
      throw new TemplateError(`unknown format "${rawFormat}" in "${source}" at ${where}`);
    }
    const format = (rawFormat as ParamFormat | undefined) ?? "raw";
    const value = params[param];
    if (value === undefined) {
      throw new TemplateError(`unresolved template "${source}" at ${where}: no value for param "${param}"`);
    }
    const rendered = formatParam(value, format);
    if (rendered === "") {
      // A locator or assertion built from an empty string matches nothing (or
      // everything) rather than failing, so refuse it here where the cause is
      // still obvious.
      throw new TemplateError(`param "${param}" rendered empty at ${where}`);
    }
    out += rendered;
  }
  return out + s.slice(cursor);
}
