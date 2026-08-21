import type { CheckpointCondition, LocatorCandidate } from "../artifact/schema.js";
import { formatParam, PARAM_FORMATS } from "../artifact/template.js";
import type { ExtractedRecord } from "./generalize.js";
import type { DiscoveryParam } from "./loop.js";

/**
 * The one place discovery hard-fails a model turn on quality rather than
 * correctness.
 *
 * A checkpoint is not a snapshot of the run that produced it — it is stored
 * and re-run later, unchanged, against different members and amounts. So a
 * checkpoint asserting `textContains "$3482.10"` is not merely over-fitted:
 * it is a capability that can only ever verify itself for one input, and it
 * writes a value the model itself declared sensitive into the one file that
 * gets committed.
 *
 * The compiler has a backstop for this (`assertNoLeakedPageData`), but a
 * backstop that throws after a paid LLM run has finished is a bad place to
 * catch it. Rejecting at `finish` costs one extra model turn and the model
 * gets a corrective message, which it demonstrably acts on — the same channel
 * that already recovers a `finish` call rejected by schema validation.
 */

export type CheckpointViolation =
  | { kind: "extracted_value"; index: number; field: string; outputName: string }
  | { kind: "currency_literal"; index: number; field: string; literal: string };

const CURRENCY_LITERAL = /\$\s?[\d,]+\.\d{2}/;

interface QualityContext {
  extractedValues: Record<string, ExtractedRecord>;
  params: DiscoveryParam[];
}

/** Every string on a checkpoint that could carry page data. */
function checkpointFields(cp: CheckpointCondition): { field: string; value: string }[] {
  const fields: { field: string; value: string }[] = [
    { field: "description", value: cp.description },
  ];
  if (cp.expected !== undefined) fields.push({ field: "expected", value: cp.expected });
  cp.locator.forEach((candidate, i) => {
    for (const value of candidateStrings(candidate)) {
      fields.push({ field: `locator[${i}].${value.field}`, value: value.value });
    }
  });
  return fields;
}

function candidateStrings(c: LocatorCandidate): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [{ field: "reason", value: c.reason }];
  switch (c.strategy) {
    case "role":
      if (c.name !== undefined) out.push({ field: "name", value: c.name });
      break;
    case "label":
    case "text":
    case "placeholder":
      out.push({ field: "text", value: c.text });
      break;
    case "testId":
      out.push({ field: "testId", value: c.testId });
      break;
    case "css":
      out.push({ field: "selector", value: c.selector });
      break;
    case "xpath":
      out.push({ field: "expression", value: c.expression });
      break;
  }
  return out;
}

/** Every surface form a declared param could legitimately appear as. */
function paramSpellings(params: DiscoveryParam[]): Set<string> {
  const spellings = new Set<string>();
  for (const param of params) {
    for (const format of PARAM_FORMATS) {
      try {
        spellings.add(formatParam(param.exampleValue, format));
      } catch {
        // this param has no meaningful rendering in this format
      }
    }
  }
  return spellings;
}

export function checkCheckpointQuality(
  checkpoints: CheckpointCondition[],
  ctx: QualityContext,
): CheckpointViolation[] {
  const violations: CheckpointViolation[] = [];
  const spellings = paramSpellings(ctx.params);

  checkpoints.forEach((cp, index) => {
    for (const { field, value } of checkpointFields(cp)) {
      for (const [outputName, record] of Object.entries(ctx.extractedValues)) {
        const offending = extractedForms(record).find((form) => value.includes(form));
        if (offending === undefined) continue;
        // The same exemption the currency rule below already makes, for the
        // same reason: a value the *caller supplied* is not page data, even
        // when the capability also reads it back out as an output. A member
        // lookup that returns the member number it was given is exactly that
        // shape, and without this it cannot assert its own input — while a
        // test in artifact/capabilities.test.ts requires that it does. The
        // compiler templatizes the literal either way, so what lands in the
        // artifact is `${memberId}` rather than one member's number.
        if (spellings.has(offending)) continue;
        violations.push({ kind: "extracted_value", index, field, outputName });
        return;
      }
      const currency = CURRENCY_LITERAL.exec(value);
      // A param's own value is fine — that comes from the caller, not the
      // page, and the compiler will turn it into a template.
      if (currency && !spellings.has(currency[0])) {
        violations.push({ kind: "currency_literal", index, field, literal: currency[0] });
        return;
      }
    }
  });

  return violations;
}

function extractedForms(record: ExtractedRecord): string[] {
  const forms = new Set<string>([record.raw.trim(), String(record.value)]);
  if (typeof record.value === "number") {
    // The transformed value alone is not enough: String(3482.1) is "3482.1",
    // which is not a substring of the "$3482.10" that actually appears.
    forms.add(record.value.toFixed(2));
    forms.add(`$${record.value.toFixed(2)}`);
  }
  return [...forms].filter((f) => f.length >= 2);
}

/**
 * The message handed back to the model as a tool error.
 *
 * Names the *output*, never the value. The model already has the value in its
 * context so nothing is being hidden from it — but this string is written to
 * the transcript and the run log, and it is written before the redaction pass
 * would see it, so it must be safe on its own.
 */
export function violationMessage(
  violations: CheckpointViolation[],
  checkpoints: CheckpointCondition[],
): string {
  const lines = violations.map((v) => {
    const label = checkpoints[v.index]?.description ?? "(no description)";
    if (v.kind === "extracted_value") {
      return `- Checkpoint ${v.index + 1} ("${label}") puts the value you extracted as \`${v.outputName}\` in its \`${v.field}\`.`;
    }
    return `- Checkpoint ${v.index + 1} ("${label}") hardcodes the amount ${v.literal} in its \`${v.field}\`.`;
  });

  return [
    "These checkpoints assert data read from this page rather than the structure of the page, so they would fail for every other member, amount or date this capability is later invoked with:",
    "",
    ...lines,
    "",
    "Rewrite each one to assert structure instead. For a value you must not hardcode:",
    '  - assertion "exists" on the same locator — proves the field is present;',
    '  - assertion "textMatches" with expected "^\\\\$[0-9,]+\\\\.[0-9]{2}$" — proves it holds a dollar amount, without saying which;',
    '  - assertion "textContains" against the static row label rather than the value cell.',
    "",
    "Values of the declared input parameters are fine to assert — the caller supplies those, so they are part of the request rather than part of the page. Then call finish again.",
  ].join("\n");
}
