import type { CapabilityArtifact } from "../artifact/schema.js";
import {
  escapeLiteral,
  formatParam,
  renderTemplate,
  PARAM_FORMATS,
  type ParamFormat,
  type ParamValue,
} from "../artifact/template.js";
import { mapArtifactStrings, type TemplateSite } from "../artifact/template-sites.js";
import type { DiscoveryParam } from "./loop.js";

/**
 * Turns the concrete literals a discovery run recorded into `${param}`
 * templates — the compile step that makes a recording reusable for inputs
 * other than the one it happened to be recorded with.
 *
 * The model is deliberately not asked to do this. It types real values into
 * real fields, because reasoning in placeholders mid-flow is an unnecessary
 * source of error; generalizing afterwards is mechanical, deterministic, and
 * auditable in one place.
 */

export interface ParamSurface {
  /** The concrete string as it appears on the page, in a URL, or in an assertion. */
  text: string;
  param: string;
  format: ParamFormat;
  /** Drives the digit-boundary rule — see templatize. */
  numeric: boolean;
}

export interface CompileFinding {
  severity: "error" | "warn";
  code: "currency_literal" | "roundtrip_failed";
  where: string;
  message: string;
}

/**
 * A surface shorter than this would shred unrelated strings: a param with
 * exampleValue "1" would rewrite every "1" in every selector in the artifact.
 */
const MIN_SURFACE_LENGTH = 2;

const CURRENCY_LITERAL = /\$\s?[\d,]+\.\d{2}/;

/**
 * The concrete strings that could stand in for a param at a given site.
 *
 * One surface per (param x format), each guarded by actually rendering it —
 * so `formatParam` deciding that "Standard Savings" is not a currency simply
 * drops that combination, rather than needing a type check here. This is what
 * makes format selection observation-driven rather than type-driven:
 * `openingDeposit` offers both "100" and "$100.00", and whichever one the page
 * actually rendered is the one that matches.
 *
 * `regexContext` is for `urlMatches`/`textMatches` sites, whose value is
 * compiled with `new RegExp`. Only the raw form is offered there, tagged
 * `regexEscape` so a member id containing a regex metacharacter cannot corrupt
 * the pattern at replay time. A currency surface is deliberately not offered
 * in a regex context: "$100.00" is three metacharacters, and there is no
 * escaped-currency formatter that could render it safely.
 */
export function paramSurfaces(params: DiscoveryParam[], regexContext = false): ParamSurface[] {
  const order = new Map<string, number>();
  const surfaces: ParamSurface[] = [];
  const seen = new Set<string>();

  params.forEach((param, declarationOrder) => {
    order.set(param.name, declarationOrder);
    // A sensitive value must never become a search key: it would surface in
    // LocatorResolutionError's message and from there in the run log and the
    // failure evidence. Sensitive params stay legal as fill/select values
    // only — enforced again in the schema's superRefine.
    if (param.sensitive) return;

    const formats: readonly ParamFormat[] = regexContext ? ["regexEscape"] : PARAM_FORMATS;
    for (const format of formats) {
      let text: string;
      try {
        text = formatParam(param.exampleValue, format);
      } catch {
        continue; // this param has no meaningful rendering in this format
      }
      if (text.length < MIN_SURFACE_LENGTH) continue;
      if (!/[A-Za-z0-9]/.test(text)) continue; // pure punctuation
      if (seen.has(text)) continue; // first (param, format) to claim a spelling wins
      seen.add(text);
      surfaces.push({ text, param: param.name, format, numeric: /^\D?[\d.,]+$/.test(text) });
    }
  });

  // Longest first, then declaration order. Longest-first is what makes the
  // pass order-independent: with memberId="1001" and openingDeposit="100",
  // position 9 of "/members/1001" is offered "1001" before "100" is ever
  // considered, so the old bug — whichever param iterated first decided the
  // answer — cannot recur.
  return surfaces.sort((a, b) => {
    if (b.text.length !== a.text.length) return b.text.length - a.text.length;
    return (order.get(a.param) ?? 0) - (order.get(b.param) ?? 0);
  });
}

function boundaryOk(literal: string, start: number, surface: ParamSurface): boolean {
  if (!surface.numeric) return true;
  // A numeric surface must not be part of a longer number: "/members/10015"
  // is not member 1001 followed by a stray 5.
  const before = start > 0 ? literal[start - 1]! : "";
  const after = literal[start + surface.text.length] ?? "";
  return !/[0-9]/.test(before) && !/[0-9]/.test(after);
}

/**
 * Single left-to-right pass, longest match at each position. Output is never
 * re-scanned, so a substituted placeholder cannot be matched again by a later
 * surface — that was the second bug in the string-replace version this
 * replaces, where a param with exampleValue "member" corrupted a already
 * inserted memberId placeholder.
 */
export function templatize(literal: string, surfaces: ParamSurface[]): string {
  let out = "";
  let i = 0;
  while (i < literal.length) {
    if (literal.startsWith("${", i)) {
      out += "${{"; // preserve a literal "${" through rendering
      i += 2;
      continue;
    }
    const hit = surfaces.find((s) => literal.startsWith(s.text, i) && boundaryOk(literal, i, s));
    if (hit) {
      out += hit.format === "raw" ? "${" + hit.param + "}" : "${" + hit.param + ":" + hit.format + "}";
      i += hit.text.length;
      continue;
    }
    out += literal[i];
    i += 1;
  }
  return out;
}

function isRegexSite(site: TemplateSite): boolean {
  return site.assertion === "urlMatches" || site.assertion === "textMatches";
}

export interface GeneralizeResult {
  artifact: CapabilityArtifact;
  findings: CompileFinding[];
}

/**
 * Rewrites every templatable string in the artifact, verifying as it goes
 * that each rewrite renders back to exactly what discovery observed. A
 * rewrite that does not round-trip is reverted rather than shipped — the
 * recorded literal is at least known to have worked once.
 */
export function generalizeArtifact(
  artifact: CapabilityArtifact,
  params: DiscoveryParam[],
): GeneralizeResult {
  const plain = paramSurfaces(params, false);
  const regex = paramSurfaces(params, true);
  const exampleValues: Record<string, ParamValue> = Object.fromEntries(
    params.map((p) => [p.name, p.exampleValue]),
  );
  const findings: CompileFinding[] = [];

  const generalized = mapArtifactStrings(artifact, (value, site) => {
    const rewritten = templatize(value, isRegexSite(site) ? regex : plain);
    if (rewritten === value) return value;

    // Round-trip: the template must reproduce the literal discovery actually
    // asserted live. Note this does NOT catch a substring collision on its
    // own — a wrongly-split "/members/1001" would round-trip perfectly.
    // Longest-match in templatize is what prevents that; this is the
    // independent safety net for everything else.
    let rendered: string;
    try {
      rendered = renderTemplate(rewritten, exampleValues, site.path);
    } catch (err) {
      findings.push({
        severity: "warn",
        code: "roundtrip_failed",
        where: site.path,
        message: `generalization reverted: ${err instanceof Error ? err.message : String(err)}`,
      });
      return escapeLiteral(value);
    }
    if (rendered !== value) {
      findings.push({
        severity: "warn",
        code: "roundtrip_failed",
        where: site.path,
        message: `generalization reverted: "${rewritten}" renders to "${rendered}", not the recorded "${value}"`,
      });
      return escapeLiteral(value);
    }
    return rewritten;
  });

  return { artifact: generalized, findings };
}

/** A runtime value this recording read off the page. Never persisted. */
export interface ExtractedRecord {
  /** Raw page text, before `read.transform` — e.g. "$3482.10". */
  raw: string;
  /** Post-transform value handed to the caller — e.g. 3482.1. */
  value: string | number;
  sensitive: boolean;
}

interface StringLeaf {
  path: string;
  value: string;
}

function collectStrings(node: unknown, path: string, out: StringLeaf[]): void {
  if (typeof node === "string") {
    out.push({ path, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectStrings(v, `${path}.${k}`, out);
  }
}

/**
 * Refuses to emit an artifact containing data this run read off the page.
 *
 * Throws rather than redacting: a `[REDACTED]` checkpoint is a checkpoint that
 * can never pass, which is worse than the leak it hides. And by the time this
 * runs, the model's own output has already been through the finish-time
 * quality gate, so a violation here means the *compiler* is wrong — this is a
 * correctness assertion, not a quality judgement.
 *
 * Two rules, scoped differently on purpose:
 *
 *  - An extracted value must appear nowhere at all, including in `reason`
 *    prose and in knownOutcome text.
 *  - A bare currency literal is refused in `steps` and `checkpoints`, which
 *    are compiled from the recording — but not in `knownOutcomes`, which are
 *    hand-authored against the app's own validation copy and legitimately say
 *    things like "at least $25.00". In `reason` prose it is a warning rather
 *    than a failure, for the same reason.
 */
export function assertNoLeakedPageData(
  artifact: CapabilityArtifact,
  extracted: Record<string, ExtractedRecord>,
): CompileFinding[] {
  const findings: CompileFinding[] = [];
  const forbidden: { needle: string; outputName: string }[] = [];
  for (const [outputName, record] of Object.entries(extracted)) {
    for (const form of extractedSurfaces(record)) {
      if (form.length >= MIN_SURFACE_LENGTH) forbidden.push({ needle: form, outputName });
    }
  }

  const leaves: StringLeaf[] = [];
  collectStrings(artifact.steps, "steps", leaves);
  collectStrings(artifact.checkpoints, "checkpoints", leaves);
  const compiledLeafCount = leaves.length;
  collectStrings(artifact.knownOutcomes, "knownOutcomes", leaves);

  leaves.forEach((leaf, index) => {
    for (const { needle, outputName } of forbidden) {
      if (leaf.value.includes(needle)) {
        // Names the output, never the value — this message reaches stdout and
        // the run log.
        throw new Error(
          `Refusing to write artifact: ${leaf.path} contains the value extracted as "${outputName}". ` +
            `Checkpoints and locators must assert structure, not data read from the page.`,
        );
      }
    }

    if (!CURRENCY_LITERAL.test(leaf.value)) return;
    const isProse = leaf.path.endsWith(".reason");
    if (index < compiledLeafCount && !isProse) {
      throw new Error(
        `Refusing to write artifact: ${leaf.path} contains a hardcoded currency amount ("${leaf.value}"). ` +
          `A capability that asserts one run's amounts cannot replay for any other input.`,
      );
    }
    if (isProse) {
      findings.push({
        severity: "warn",
        code: "currency_literal",
        where: leaf.path,
        message: "locator reason mentions a currency amount; prose only, but check it is not page data",
      });
    }
  });

  return findings;
}

/** Every textual form an extracted value could plausibly appear as. */
function extractedSurfaces(record: ExtractedRecord): string[] {
  const forms = new Set<string>([record.raw.trim(), String(record.value)]);
  if (typeof record.value === "number") {
    // String(3482.1) is "3482.1", which is NOT a substring of the "$3482.10"
    // that actually leaked — matching on the transformed value alone misses
    // the real thing.
    forms.add(record.value.toFixed(2));
    forms.add(`$${record.value.toFixed(2)}`);
  }
  return [...forms].filter((f) => f !== "");
}
