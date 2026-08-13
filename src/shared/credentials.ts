/**
 * Dev-only credentials for the mock app's two roles. These are fake, local,
 * non-production values (see mock-app/data.ts) — never real secrets — but
 * are still kept out of the LLM conversation and the artifact entirely: the
 * discovery harness logs in programmatically via Playwright *before* the
 * LLM loop starts (see browser-session.ts), so the model never sees, types,
 * or reasons about a credential, and no login step or credential value ever
 * has a chance to land in a recorded artifact or the discovery transcript.
 * This is a structural guarantee, not a redaction rule applied after the fact.
 */
export interface MockCredentials {
  username: string;
  password: string;
}

export function tellerCredentials(): MockCredentials {
  return {
    username: process.env.MOCK_TELLER_USERNAME ?? "teller1",
    password: process.env.MOCK_TELLER_PASSWORD ?? "bankdemo123",
  };
}

export function readonlyCredentials(): MockCredentials {
  return {
    username: process.env.MOCK_READONLY_USERNAME ?? "viewer1",
    password: process.env.MOCK_READONLY_PASSWORD ?? "bankdemo123",
  };
}
