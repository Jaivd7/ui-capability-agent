import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMBERS } from "../../mock-app/data.js";
import { scoreRecording } from "../discovery/score-recording.js";
import { computeContentHash } from "./hash.js";
import { parseArtifact } from "./index.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import { forEachTemplateSite } from "./template-sites.js";
import { renderTemplate, type ParamValue } from "./template.js";

/**
 * Invariants over the artifacts that are actually committed, rather than over
 * a fixture.
 *
 * This is the test that would have caught the original bug on day one: both
 * shipped capabilities asserted the recorded member's name and savings
 * balance in their checkpoints, so they could only ever replay for the single
 * input tuple they were recorded with — and the balance was a value the model
 * itself had declared sensitive, sitting in cleartext in the one file the repo
 * commits.
 */

const CAPABILITIES_DIR = join(process.cwd(), "capabilities");
const CURRENCY_LITERAL = /\$\s?[\d,]+\.\d{2}/;

// Capabilities are namespaced by app, so this walks every app directory —
// which also means these invariants automatically cover a second target
// without anyone remembering to extend them.
const refs = readdirSync(CAPABILITIES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .flatMap((appDir) =>
    readdirSync(join(CAPABILITIES_DIR, appDir.name))
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({
        label: `${appDir.name}/${f.replace(/\.json$/, "")}`,
        path: join(CAPABILITIES_DIR, appDir.name, f),
      })),
  );
const ids = refs.map((r) => r.label);

function load(label: string) {
  const ref = refs.find((r) => r.label === label)!;
  const parsed = parseArtifact(JSON.parse(readFileSync(ref.path, "utf-8")));
  if (!parsed.success) throw new Error(`${label}: ${parsed.errors.join("\n")}`);
  return parsed.artifact;
}

describe("committed capability artifacts", () => {
  it("there is at least one to check", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  describe.each(ids)("%s", (id) => {
    it("parses against the current schema", () => {
      expect(load(id).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    });

    it("its contentHash matches its content", () => {
      // Makes the drift signal real: a hand-edit or a stale commit is a test
      // failure rather than something noticed later, or never.
      const artifact = load(id);
      expect(computeContentHash(artifact)).toBe(artifact.contentHash);
    });

    it("contains no member's name or balance from the target app", () => {
      const artifact = load(id);
      const forbidden: string[] = [];
      for (const member of Object.values(MEMBERS)) {
        forbidden.push(member.name, member.savings.toFixed(2), member.checking.toFixed(2));
      }
      const offenders: string[] = [];
      forEachTemplateSite(artifact, (value, site) => {
        for (const needle of forbidden) {
          if (value.includes(needle)) offenders.push(`${site.path} contains page data`);
        }
      });
      expect(offenders).toEqual([]);
    });

    it("hardcodes no currency amount outside its own parameters", () => {
      const artifact = load(id);
      const offenders: string[] = [];
      forEachTemplateSite(artifact, (value, site) => {
        // knownOutcome detectors are hand-authored against the app's own
        // validation copy ("at least $25.00") and are not compiled from a run.
        if (site.path.startsWith("knownOutcomes")) return;
        if (CURRENCY_LITERAL.test(value)) offenders.push(`${site.path}: ${value}`);
      });
      expect(offenders).toEqual([]);
    });

    it("every declared input param is actually used", () => {
      const artifact = load(id);
      const used = new Set<string>();
      for (const step of artifact.steps) {
        if ("value" in step && step.value.kind === "param") used.add(step.value.param);
      }
      forEachTemplateSite(artifact, (value) => {
        for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(match[1]!);
      });
      const unused = artifact.inputParams.filter((p) => !used.has(p.name)).map((p) => p.name);
      expect(unused).toEqual([]);
    });

    it("every template resolves against the recorded example values", () => {
      const artifact = load(id);
      const examples: Record<string, ParamValue> = Object.fromEntries(
        artifact.inputParams.flatMap((p) => (p.example === undefined ? [] : [[p.name, p.example]])),
      );
      expect(() =>
        forEachTemplateSite(artifact, (v, site) => renderTemplate(v, examples, site.path)),
      ).not.toThrow();
    });

    it("has at least one checkpoint that asserts an input param", () => {
      // Otherwise a run that landed on the wrong record still passes.
      const artifact = load(id);
      const asserted = new Set<string>();
      forEachTemplateSite(artifact, (value, site) => {
        if (!site.path.startsWith("checkpoints")) return;
        for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) asserted.add(match[1]!);
      });
      expect(asserted.size).toBeGreaterThan(0);
    });

    it("carries no error-severity finding from the recording scorer", () => {
      const artifact = load(id);
      const errors = scoreRecording(artifact).findings.filter((f) => f.severity === "error");
      expect(errors.map((f) => `${f.code} at ${f.where}`)).toEqual([]);
    });
  });
});
