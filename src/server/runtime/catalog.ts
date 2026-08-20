import { statSync } from "node:fs";
import { getAppAdapter } from "../../apps/index.js";
import type { CapabilityArtifact } from "../../artifact/schema.js";
import { listCapabilityRefs, loadCapability } from "../../replay/load-capability.js";
import type { Catalog, CatalogEntry, CatalogEntryDetail } from "../types.js";

/**
 * The capability catalog: everything on disk under `capabilities/`, loaded
 * through the same gate the replay CLI uses.
 *
 * Going through `loadCapability` rather than reading the JSON directly is the
 * point — it schema-validates and verifies `contentHash`, so a tampered or
 * hand-edited artifact cannot show up in the catalog looking legitimate and
 * then fail only at invoke time.
 *
 * The corollary is that loading can fail per file, and a catalog that throws
 * on the first bad artifact takes the whole dashboard down with it — including
 * the pages an operator would use to work out *why* it's bad. So a failure is
 * a warning and a skipped entry, and the other capabilities still list.
 */

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** Absent when this file failed to load; the entry is kept to avoid re-warning. */
  detail?: CatalogEntryDetail;
}

export function createCatalog(): Catalog {
  /** path -> load result, invalidated by mtime/size. */
  const cache = new Map<string, CacheEntry>();
  /** id -> detail, rebuilt on every refresh. */
  let entries = new Map<string, CatalogEntryDetail>();

  function refresh(): void {
    const next = new Map<string, CatalogEntryDetail>();
    const seen = new Set<string>();

    for (const ref of listCapabilityRefs()) {
      seen.add(ref.path);
      const stats = statSync(ref.path, { throwIfNoEntry: false });
      if (!stats) continue;

      const cached = cache.get(ref.path);
      const fresh = cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size;
      const entry: CacheEntry = fresh
        ? cached
        : { mtimeMs: stats.mtimeMs, size: stats.size, ...buildEntry(ref.path) };

      cache.set(ref.path, entry);
      if (entry.detail) next.set(entry.detail.id, entry.detail);
    }

    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    entries = next;
  }

  // Reads happen through refresh() rather than off a snapshot taken at
  // construction: a capability recorded while the server is up should appear
  // without a restart, and the mtime cache makes the common case a stat per
  // file rather than a parse and a hash.
  return {
    list(app?: string): CatalogEntry[] {
      refresh();
      return [...entries.values()]
        .filter((e) => app === undefined || e.app === app)
        .map(toEntry)
        .sort((a, b) => a.app.localeCompare(b.app) || a.name.localeCompare(b.name));
    },

    get(id: string): CatalogEntryDetail | undefined {
      refresh();
      return entries.get(id);
    },

    refresh,
  };
}

function buildEntry(path: string): { detail?: CatalogEntryDetail } {
  try {
    return { detail: toDetail(loadCapability(path)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[catalog] Skipping ${path}: ${message}`);
    return {};
  }
}

function toDetail(artifact: CapabilityArtifact): CatalogEntryDetail {
  const app = artifact.target.app;
  return {
    id: artifact.id,
    name: artifact.name,
    description: artifact.description,
    version: artifact.version,
    schemaVersion: artifact.schemaVersion,
    contentHash: artifact.contentHash,
    app,
    appDisplayName: displayNameFor(app),
    baseUrl: artifact.target.baseUrl,
    requiredRole: artifact.preconditions.requiredRole ?? null,
    // One irreversible step is enough to make the whole call one that may stop
    // and wait for a human, which is what a caller needs to know up front.
    irreversible: artifact.steps.some((step) => step.irreversible),
    inputParams: artifact.inputParams,
    outputs: artifact.outputs,
    knownOutcomes: artifact.knownOutcomes.map((outcome) => ({
      id: outcome.id,
      classification: outcome.classification,
      description: outcome.description,
      ...(outcome.classification === "business"
        ? { code: outcome.outcome.code, message: outcome.outcome.message }
        : {}),
    })),
    artifact,
  };
}

/**
 * An artifact recorded against an app this build has no adapter for is still a
 * real artifact — degrade to the raw id rather than dropping it, since the app
 * id is what the rest of the catalog keys on anyway.
 */
function displayNameFor(app: string): string {
  try {
    return getAppAdapter(app).displayName;
  } catch {
    return app;
  }
}

/** `lastRun` is left to the caller: the catalog has no view of the run registry. */
function toEntry(detail: CatalogEntryDetail): CatalogEntry {
  const { artifact: _artifact, ...entry } = detail;
  return entry;
}
