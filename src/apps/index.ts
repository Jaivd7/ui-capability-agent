import type { AppAdapter, Credentials } from "./types.js";
import { LEGACY_CORE_BANKING } from "./legacy-core-banking.js";
import { MERIDIAN_CORE } from "./meridian-core.js";

export type { AppAdapter, Credentials, RecoveryActionImpl, RecoveryContext, RecoveryScope } from "./types.js";

const ADAPTERS: Record<string, AppAdapter> = {
  [LEGACY_CORE_BANKING.id]: LEGACY_CORE_BANKING,
  [MERIDIAN_CORE.id]: MERIDIAN_CORE,
};

/** The app the CLIs assume when `--app` is omitted. */
export const DEFAULT_APP_ID = MERIDIAN_CORE.id;

export function getAppAdapter(app: string): AppAdapter {
  const adapter = ADAPTERS[app];
  if (!adapter) {
    throw new Error(`Unknown app "${app}". Known apps: ${listAppIds().join(", ")}.`);
  }
  return adapter;
}

export function listAppIds(): string[] {
  return Object.keys(ADAPTERS);
}

export function listAppAdapters(): AppAdapter[] {
  return Object.values(ADAPTERS);
}

export function isKnownApp(app: string): boolean {
  return app in ADAPTERS;
}

/**
 * Credentials for a role on an app. Replaces the old two-member `SessionRole`
 * union: role vocabularies are a property of the target, not of the engine.
 */
export function credentialsFor(app: string, role: string): Credentials {
  const adapter = getAppAdapter(app);
  const creds = adapter.roles[role];
  if (!creds) {
    throw new Error(
      `Unknown role "${role}" for app "${app}". Known roles: ${listRoles(app).join(", ")}.`,
    );
  }
  return creds;
}

export function listRoles(app: string): string[] {
  return Object.keys(getAppAdapter(app).roles);
}

export function isKnownRole(app: string, role: string): boolean {
  return role in getAppAdapter(app).roles;
}

/** Resolves an app's target from the current environment. */
export function resolveTargetFor(app: string): ReturnType<AppAdapter["target"]> {
  return getAppAdapter(app).target(process.env);
}
