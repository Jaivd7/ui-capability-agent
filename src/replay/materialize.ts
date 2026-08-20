import type { CapabilityArtifact } from "../artifact/schema.js";
import { mapArtifactStrings } from "../artifact/template-sites.js";
import { renderTemplate, TemplateError, type ParamValue } from "../artifact/template.js";

/**
 * Resolves every `${param}` in a saved artifact against one invocation's
 * arguments, producing a fully concrete artifact for the replay engine.
 *
 * Called exactly once, at the top of `runReplay`, before anything touches the
 * browser. Two reasons it lives here rather than being threaded into
 * `src/shared/`:
 *
 *  - `src/shared/locator.ts` and `src/shared/assert.ts` are shared verbatim by
 *    discovery and replay, and that sharing is what makes "the locator that
 *    worked during discovery is the locator replay uses" structural rather
 *    than hoped-for. Pushing params into them would break that symmetry for
 *    no gain — discovery never sees a template in the first place, because
 *    the compiler introduces them only after a run completes.
 *  - Resolving up front means an unresolved placeholder aborts the run before
 *    step 1, rather than half-way through a flow that may already have
 *    mutated state.
 */
export function materializeArtifact(
  artifact: CapabilityArtifact,
  params: Record<string, ParamValue>,
): CapabilityArtifact {
  return mapArtifactStrings(artifact, (value, site) => {
    const rendered = renderTemplate(value, params, site.path);
    if (site.assertion === "urlMatches" || site.assertion === "textMatches") {
      // These are compiled with `new RegExp` inside assertCondition. If a
      // substituted value makes the pattern invalid, fail here — where the
      // message can name the site and the substitution — rather than as a
      // bare SyntaxError from deep inside an assertion.
      try {
        new RegExp(rendered);
      } catch (err) {
        throw new TemplateError(
          `${site.path} rendered to an invalid ${site.assertion} pattern "${rendered}": ${
            err instanceof Error ? err.message : String(err)
          }. Use the :regexEscape format for a param interpolated into a pattern.`,
        );
      }
    }
    return rendered;
  });
}
