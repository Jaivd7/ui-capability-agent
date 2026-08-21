/**
 * Known-good values to type into a target app, for whoever is driving the
 * console by hand.
 *
 * This exists because the alternative is going and reading `presets-meridian.ts`
 * to find out which member has shares worth transferring between. The values
 * here are not used by the engine — nothing replays against them — they are
 * purely what the dashboard's "Demo data" panel prints.
 *
 * Two honesty constraints shaped it:
 *
 *  - **Shares drift.** MERIDIAN CORE is a live, shared host, and
 *    `presets-meridian.ts` already warns that other people's runs accumulate
 *    holds and open new shares in the seed members. So this list carries the
 *    date it was last checked and the panel says so, rather than presenting
 *    stale state as fact.
 *  - **Passwords are never read out of the environment.** Every credential in
 *    the adapters is `env("SOME_VAR", "default")`, so on a machine where the
 *    real variable is set, printing the effective value would put a genuine
 *    password on a web page. `credentialEnv` names the variables so the panel
 *    can print the checked-in default and, when the variable is actually set,
 *    say only that — never the value.
 */

export interface DemoMember {
  id: string;
  /** Why you would reach for this one rather than the other. */
  note: string;
  /** Share codes seen on this member. Suffix-free codes are the share type itself. */
  shares: string[];
}

export interface AppDemoData {
  members: DemoMember[];
  /** Per role, the environment variables that override its credentials. */
  credentialEnv: Record<string, { username: string; password: string }>;
  /** ISO date the share list was last confirmed against the live host. */
  verifiedOn: string;
  /** Set when the target's state is shared with other people and will drift. */
  volatile: boolean;
}

export const APP_DEMO_DATA: Record<string, AppDemoData> = {
  "meridian-core": {
    members: [
      {
        id: "100234",
        note: "The default member. Ships with a hold on its Regular Shares, so transfers out are refused.",
        shares: ["S0001", "S0001-3", "S0001-6", "S0070", "MMKT-4", "MMKT-5"],
      },
      {
        id: "103001",
        note: "Two large open shares. Use this one for anything that moves money.",
        shares: ["S0001", "S0070-6", "S0070-7", "MMKT-2", "MMKT-3", "MMKT-4", "MMKT-5"],
      },
    ],
    credentialEnv: {
      teller: { username: "MERIDIAN_TELLER_USERNAME", password: "MERIDIAN_TELLER_PASSWORD" },
      supervisor: { username: "MERIDIAN_SUPERVISOR_USERNAME", password: "MERIDIAN_SUPERVISOR_PASSWORD" },
    },
    verifiedOn: "2026-08-20",
    volatile: true,
  },
  "legacy-core-banking": {
    members: [
      { id: "1001", note: "Alicia Gomez — savings and checking.", shares: [] },
      { id: "1002", note: "Marcus Webb — low balances, good for insufficient-funds paths.", shares: [] },
      { id: "1003", note: "Priya Natarajan — large balances.", shares: [] },
    ],
    credentialEnv: {},
    verifiedOn: "2026-08-20",
    volatile: false,
  },
};

export function demoDataFor(app: string): AppDemoData | undefined {
  return APP_DEMO_DATA[app];
}
