import { credentialsFor, getAppAdapter } from "../../apps/index.js";

/**
 * Arms and disarms the target's own fault injection, so a reviewer can watch
 * the error taxonomy work instead of being told it does.
 *
 * **This deliberately does not use the capability browser context.**
 * `/settings` is absent from the guardrail allowlist on purpose — it is the
 * target's global fault configuration, and a capability replay must never be
 * able to reach it. Driving it through the run's context with a
 * just-this-once exemption would be exactly the bypass the brief warns about;
 * the cleanest way to not have an exemption is to not use that context. So
 * this opens its own short-lived session with its own cookie jar, which is
 * also the more honest model: arming a fault is an administrator acting on the
 * system, not the automation acting within it.
 */

export const INJECT_KINDS = [
  "validation",
  "notfound",
  "permission",
  "timeout",
  "maintenance",
  "server",
] as const;
export type InjectKind = (typeof INJECT_KINDS)[number];

export interface FaultSettings {
  forcedInject: InjectKind | "none";
  /** Probability in [0,1] that a posting action fails at random. */
  errorRate: number;
}

/** What each kind models, shown next to the control so a reviewer knows what they are arming. */
export const INJECT_DESCRIPTIONS: Record<InjectKind, string> = {
  validation: "400 — field or transaction rejection",
  notfound: "404 — member record not found",
  permission: "403 — supervisor override required",
  timeout: "440 — session expired mid-flow",
  maintenance: "503 — maintenance interstitial",
  server: "500 — hard application error",
};

export class FaultInjectionError extends Error {}

/** Only apps that actually expose a settings screen can be armed. */
export function supportsFaultInjection(app: string): boolean {
  return app === "meridian-core";
}

interface Session {
  cookie: string;
  baseUrl: string;
}

async function signOn(app: string): Promise<Session> {
  const adapter = getAppAdapter(app);
  const target = adapter.target(process.env);
  const creds = credentialsFor(app, "teller");
  const body = new URLSearchParams({
    operator: creds.username,
    password: creds.password,
    ...(creds.extra?.branch ? { branch: creds.extra.branch } : {}),
  });

  const res = await fetch(`${target.baseUrl}/signon`, {
    method: "POST",
    body,
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new FaultInjectionError("Could not sign on to the target to read its settings.");
  return { cookie: setCookie.split(";")[0] ?? "", baseUrl: target.baseUrl };
}

export async function readFaultSettings(app: string): Promise<FaultSettings> {
  const session = await signOn(app);
  const html = await (await fetch(`${session.baseUrl}/settings`, { headers: { cookie: session.cookie } })).text();

  const selected = /<option value="([^"]*)"\s+selected/.exec(html)?.[1] ?? "";
  const rate = /name="errorRate"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? "0";
  return {
    forcedInject: (INJECT_KINDS as readonly string[]).includes(selected) ? (selected as InjectKind) : "none",
    errorRate: Number(rate) || 0,
  };
}

export async function applyFaultSettings(app: string, settings: FaultSettings): Promise<void> {
  // Validated here rather than proxied: this posts to a real system, and
  // forwarding an arbitrary form body would make the dashboard a relay.
  if (settings.forcedInject !== "none" && !(INJECT_KINDS as readonly string[]).includes(settings.forcedInject)) {
    throw new FaultInjectionError(`"${settings.forcedInject}" is not an injectable fault.`);
  }
  if (!Number.isFinite(settings.errorRate) || settings.errorRate < 0 || settings.errorRate > 1) {
    throw new FaultInjectionError("Error rate must be between 0 and 1.");
  }

  const session = await signOn(app);
  // The settings form carries the same per-session token every other form on
  // this app does, and the browser submits it for us everywhere else. Here we
  // are the client, so we read it first.
  const html = await (await fetch(`${session.baseUrl}/settings`, { headers: { cookie: session.cookie } })).text();
  const token = /name="_token"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? "";

  const body = new URLSearchParams({
    _token: token,
    forcedInject: settings.forcedInject === "none" ? "" : settings.forcedInject,
    errorRate: String(settings.errorRate),
  });
  const res = await fetch(`${session.baseUrl}/settings`, {
    method: "POST",
    body,
    redirect: "manual",
    headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
  });
  if (res.status >= 400) {
    throw new FaultInjectionError(`The target refused the settings change (HTTP ${res.status}).`);
  }
}

/** One line for the persistent header banner, or undefined when nothing is armed. */
export function describeArmedFault(settings: FaultSettings | undefined): string | undefined {
  if (!settings) return undefined;
  const parts: string[] = [];
  if (settings.forcedInject !== "none") {
    parts.push(`every request returns ${settings.forcedInject} (${INJECT_DESCRIPTIONS[settings.forcedInject]})`);
  }
  if (settings.errorRate > 0) parts.push(`${Math.round(settings.errorRate * 100)}% of posting actions fail at random`);
  if (parts.length === 0) return undefined;
  return `Fault injection is armed on the target: ${parts.join(", ")}. Runs will fail until you disarm it.`;
}
