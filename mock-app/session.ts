import { randomBytes } from "node:crypto";
import type { Role } from "./data.js";

export interface Session {
  token: string;
  username: string;
  role: Role;
  createdAt: number;
  lastSeenAt: number;
  forcedExpired: boolean;
}

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 10 * 60_000);

const sessions = new Map<string, Session>();

export function createSession(username: string, role: Role): Session {
  const token = randomBytes(16).toString("hex");
  const now = Date.now();
  const session: Session = { token, username, role, createdAt: now, lastSeenAt: now, forcedExpired: false };
  sessions.set(token, session);
  return session;
}

/**
 * Returns the live session for a token, or null if missing/expired. Touches
 * lastSeenAt on success (sliding TTL), matching how a real session store
 * would behave.
 */
export function getSession(token: string | undefined): Session | null {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.forcedExpired || Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  session.lastSeenAt = Date.now();
  return session;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

/**
 * Dev-only lever: force a session to look expired on its next use, without
 * waiting out the real TTL. Exists purely so a replay run can reproduce the
 * "session timeout" runtime condition on demand for /evidence/ — the same
 * codepath (getSession returning null) fires either way, so this doesn't
 * introduce a separate behavior to test.
 */
export function forceExpire(token: string | undefined): void {
  if (!token) return;
  const session = sessions.get(token);
  if (session) session.forcedExpired = true;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}
