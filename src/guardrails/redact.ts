/**
 * Redaction for anything that might get logged or persisted. This one
 * function is pulled forward from Phase 4 (safety guardrails) because the
 * discovery loop's very first live run extracts a real (mock) account
 * balance and needs to not write it to disk in cleartext — "never persist
 * secrets/PII into artifacts or logs" has to hold from the first evidence
 * captured, not just once the guardrail phase is formally built. The rest
 * of the guardrail layer (allowlist enforcement, irreversible-action
 * gating) is built in Phase 4 proper.
 */
export const REDACTED = "[REDACTED]";

/** Masks a value for logging, keeping just enough shape to be useful for debugging. */
export function redactValue(value: unknown, sensitive: boolean): unknown {
  if (!sensitive) return value;
  if (typeof value === "string") {
    if (value.length <= 2) return REDACTED;
    return `${value[0]}${REDACTED}${value[value.length - 1]}`;
  }
  if (typeof value === "number") return REDACTED;
  return REDACTED;
}

/** Redacts named fields in a plain object given a set of field names known to be sensitive. */
export function redactFields<T extends Record<string, unknown>>(
  obj: T,
  sensitiveKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = redactValue(value, sensitiveKeys.has(key));
  }
  return out;
}

/**
 * Redacts a serialized transcript/log blob before it's written to disk as
 * evidence. The model necessarily sees sensitive values transiently (it has
 * to read a balance to extract it) — that's an unavoidable part of the API
 * call itself — but what lands in /evidence/ is a separate concern. This
 * targets two things: (1) exact occurrences of values already known to be
 * sensitive (declared outputs' runtime values, in any string form), and
 * (2) a general currency-amount pattern, since in this app a dollar amount
 * is the sensitive category regardless of whether it was ever formally
 * captured as a declared output.
 *
 * This is deliberately narrow, not general PII/NER redaction (it won't
 * catch e.g. a member's name in free text) — see REPORT.md §7 for that cut
 * and why.
 */
export function redactTranscriptText(text: string, knownSensitiveValues: readonly (string | number)[]): string {
  let out = text;
  for (const v of knownSensitiveValues) {
    const str = String(v);
    if (!str) continue;
    out = out.split(str).join(REDACTED);
  }
  return out.replace(/\$[\d,]+\.\d{2}/g, REDACTED);
}
