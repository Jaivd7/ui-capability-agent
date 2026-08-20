import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computeContentHash } from "../artifact/hash.js";
import { parseArtifact } from "../artifact/index.js";
import type { CapabilityArtifact } from "../artifact/schema.js";

/**
 * Reads a capability off disk, validates it, and verifies its content hash.
 *
 * Lifted out of the replay CLI so the API loads capabilities through exactly
 * the same gate — including the hash check, which is the difference between
 * `contentHash` being an integrity guarantee and being decorative.
 *
 * Capabilities live under `capabilities/<appId>/<id>.json`. They were flat
 * until a second target arrived, at which point two apps with a same-named
 * capability would have collided and the re-record version counter would have
 * incremented across them.
 */

export const CAPABILITIES_ROOT = join(process.cwd(), "capabilities");

export class CapabilityLoadError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "hash_mismatch",
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "CapabilityLoadError";
  }
}

export interface CapabilityRef {
  app: string;
  id: string;
  path: string;
}

/** Every capability on disk, across all apps. */
export function listCapabilityRefs(root = CAPABILITIES_ROOT): CapabilityRef[] {
  if (!existsSync(root)) return [];
  const refs: CapabilityRef[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const appDir = join(root, entry.name);
    for (const file of readdirSync(appDir)) {
      if (!file.endsWith(".json")) continue;
      refs.push({ app: entry.name, id: file.replace(/\.json$/, ""), path: join(appDir, file) });
    }
  }
  return refs.sort((a, b) => a.app.localeCompare(b.app) || a.id.localeCompare(b.id));
}

export function capabilityPath(app: string, id: string, root = CAPABILITIES_ROOT): string {
  return join(root, app, `${id}.json`);
}

/** Finds a capability by id alone, which is how the API and CLI address them. */
export function resolveCapabilityRef(id: string, root = CAPABILITIES_ROOT): CapabilityRef | undefined {
  return listCapabilityRefs(root).find((r) => r.id === id);
}

export interface LoadOptions {
  /** Skip the content-hash check. For the deliberately-corrupted artifacts in evidence/. */
  allowHashMismatch?: boolean;
}

export function loadCapability(path: string, opts: LoadOptions = {}): CapabilityArtifact {
  if (!existsSync(path)) {
    throw new CapabilityLoadError("not_found", `No capability artifact at ${path}.`);
  }
  const parsed = parseArtifact(JSON.parse(readFileSync(path, "utf-8")));
  if (!parsed.success) {
    throw new CapabilityLoadError(
      "invalid",
      "Artifact failed schema validation.",
      parsed.errors.join("\n"),
    );
  }
  const artifact = parsed.artifact;

  const actual = computeContentHash(artifact);
  if (actual !== artifact.contentHash && !opts.allowHashMismatch) {
    throw new CapabilityLoadError(
      "hash_mismatch",
      "Artifact contentHash does not match its content.",
      `recorded: ${artifact.contentHash}\nactual:   ${actual}\n` +
        "The artifact was edited after it was recorded, or produced by a different compiler.",
    );
  }
  return artifact;
}

export function loadCapabilityById(id: string, opts: LoadOptions = {}): CapabilityArtifact {
  const ref = resolveCapabilityRef(id);
  if (!ref) {
    throw new CapabilityLoadError("not_found", `No capability "${id}" under ${CAPABILITIES_ROOT}.`);
  }
  return loadCapability(ref.path, opts);
}
