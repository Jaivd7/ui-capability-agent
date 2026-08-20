import { describe, expect, it } from "vitest";
import { baseArtifact } from "../../artifact/test-fixtures.js";
import type { InputParam } from "../../artifact/schema.js";
import type { HumanAction } from "../../escalation/types.js";
import type {
  CatalogEntry,
  CatalogEntryDetail,
  EvidenceFile,
  RunEvent,
  RunRecord,
  RunStatus,
  RunSummary,
} from "../types.js";
import { escapeHtml, layout } from "./layout.js";
import { duration, statusChip, table, timeAgo } from "./components.js";
import { catalogPage } from "./pages/catalog.js";
import { invokePage } from "./pages/invoke.js";
import { overviewPage } from "./pages/overview.js";
import { runDetailPage } from "./pages/run-detail.js";
import { runsPage } from "./pages/runs.js";
import { pollScript, runnerPollScript } from "./poll-script.js";

/**
 * The view layer is pure functions from data to strings, which is exactly what
 * makes it worth testing at this level: no server, no browser, no fixtures on
 * disk. Two things get asserted hardest — that nothing interpolated can escape
 * into markup, and that a business outcome never renders as a failure.
 */

const XSS = `<script>alert("pwn")</script>`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "lookup-member-balance",
    name: "Look up member and read savings balance",
    description: "Searches for a member by ID and extracts their savings balance.",
    version: 3,
    schemaVersion: "1.1.0",
    contentHash: "0123456789abcdef0123456789abcdef",
    app: "legacy-core-banking",
    appDisplayName: "Legacy Core Banking",
    baseUrl: "http://localhost:4000",
    requiredRole: "teller",
    irreversible: false,
    inputParams: [{ name: "memberId", type: "string", required: true, sensitive: false, example: "1001" }],
    outputs: [{ name: "savingsBalance", type: "currency", sensitive: true }],
    knownOutcomes: [
      {
        id: "member-not-found",
        classification: "business",
        code: "MEMBER_NOT_FOUND",
        message: "No member found with the given ID.",
        description: "Search returns no matching member",
      },
    ],
    lastRun: { runId: "run-1", status: "succeeded", finishedAt: new Date().toISOString() },
    ...overrides,
  };
}

function detailEntry(params: InputParam[], overrides: Partial<CatalogEntryDetail> = {}): CatalogEntryDetail {
  const artifact = baseArtifact();
  return {
    ...catalogEntry({ inputParams: params }),
    artifact,
    ...overrides,
  };
}

/** `exactOptionalPropertyTypes` makes `{ result: undefined }` illegal in a `Partial`; tests need it. */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

function runSummary(overrides: Overrides<RunSummary> = {}): RunSummary {
  return {
    runId: "lookup-member-balance-1787246804295",
    kind: "replay",
    capabilityId: "lookup-member-balance",
    capabilityVersion: 3,
    app: "legacy-core-banking",
    role: "teller",
    status: "succeeded",
    escalated: false,
    startedAt: "2026-08-20T10:00:00.000Z",
    finishedAt: "2026-08-20T10:00:07.400Z",
    durationMs: 7400,
    ...overrides,
  } as RunSummary;
}

function runRecord(overrides: Overrides<RunRecord> = {}): RunRecord {
  return {
    ...runSummary(),
    baseUrl: "http://localhost:4000",
    evidenceDir: "evidence/legacy-core-banking/run-1",
    logPath: "evidence/legacy-core-banking/run-1/run.jsonl",
    updatedAt: "2026-08-20T10:00:07.400Z",
    params: { memberId: "1001" },
    progress: { stepsTotal: 3, stepsCompleted: 3 },
    result: {
      status: "success",
      outputs: { savingsBalance: "$3,482.10" },
      checkpointsPassed: ["Savings balance panel is visible"],
      stepsExecuted: 3,
    },
    ...overrides,
  } as RunRecord;
}

const EVENTS: RunEvent[] = [
  { index: 0, timestamp: "2026-08-20T10:00:00.000Z", type: "run_start", capabilityId: "lookup-member-balance" },
  { index: 1, timestamp: "2026-08-20T10:00:01.200Z", type: "step_result", stepId: "step-1", ok: true, attempt: 1 },
  {
    index: 2,
    timestamp: "2026-08-20T10:00:02.000Z",
    type: "locator_resolved",
    stepId: "step-2",
    candidateIndex: 1,
    strategy: "text",
    matchCount: 1,
    usedFallback: true,
  },
  { index: 3, timestamp: "2026-08-20T10:00:03.000Z", type: "step_retry", stepId: "step-2", reason: "recovery" },
  { index: 4, timestamp: "2026-08-20T10:00:03.500Z", type: "flow_restart", attempt: 2 },
  {
    index: 5,
    timestamp: "2026-08-20T10:00:04.000Z",
    type: "known_outcome",
    outcomeId: "session-expired",
    classification: "recoverable",
    action: "reauth",
  },
  { index: 6, timestamp: "2026-08-20T10:00:05.000Z", type: "checkpoint_passed", description: "Savings balance panel is visible" },
  { index: 7, timestamp: "2026-08-20T10:00:05.500Z", type: "checkpoint_failed", description: "Receipt shown", observed: "nothing" },
  {
    index: 8,
    timestamp: "2026-08-20T10:00:06.000Z",
    type: "escalation_raised",
    kind: "replay_hard_failure",
    reason: "Confirm button never appeared",
  },
  { index: 9, timestamp: "2026-08-20T10:00:06.500Z", type: "human_action", actionType: "click", detail: "Clicked Confirm" },
  { index: 10, timestamp: "2026-08-20T10:00:07.000Z", type: "extracted", stepId: "step-3", outputName: "savingsBalance", value: "$3,482.10" },
];

const ALL_EVIDENCE: EvidenceFile[] = ["jsonl", "result.json", "failure.png", "failure.dom.html"];

const COUNTS: Record<RunStatus, number> = {
  running: 1,
  escalation_pending: 0,
  succeeded: 4,
  business_outcome: 2,
  failed: 1,
  crashed: 0,
};

/** Everything in a rendered page that a hostile string could have escaped into. */
function assertNoRawScript(html: string): void {
  expect(html).not.toContain("<script>alert");
  expect(html).not.toContain('alert("pwn")');
}

// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("neutralizes a script tag", () => {
    const escaped = escapeHtml(XSS);
    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("</script>");
    expect(escaped).toBe("&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;");
  });

  it("escapes quotes so an attribute cannot be broken out of", () => {
    expect(escapeHtml(`" onerror="alert(1)`)).toBe("&quot; onerror=&quot;alert(1)");
    expect(escapeHtml(`' onload='x`)).toBe("&#39; onload=&#39;x");
  });

  it("escapes ampersands first so entities are not doubled", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("layout", () => {
  it("renders a document with the nav and highlights the active item", () => {
    const html = layout({ title: "Runs", body: "<p>hello</p>", activeNav: "runs" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("https://cdn.tailwindcss.com");
    expect(html).toContain("<p>hello</p>");
    for (const label of ["Overview", "Capabilities", "Runs", "Faults"]) expect(html).toContain(label);
    expect(html).toContain('aria-current="page"');
  });

  it("escapes the title", () => {
    const html = layout({ title: XSS, body: "" });
    assertNoRawScript(html);
  });

  it("renders the fault banner only when armed, and escapes it", () => {
    expect(layout({ title: "t", body: "" })).not.toContain("Fault injection armed");
    const armed = layout({ title: "t", body: "", faultBanner: `slow responses ${XSS}` });
    expect(armed).toContain("Fault injection armed");
    expect(armed).toContain("bg-amber-50");
    assertNoRawScript(armed);
  });

  it("appends the poll script when given one", () => {
    expect(layout({ title: "t", body: "", pollScript: "<script>/*x*/</script>" })).toContain("<script>/*x*/</script>");
  });
});

describe("components", () => {
  it("renders a business outcome without any danger styling, unlike a failure", () => {
    const business = statusChip("business_outcome");
    expect(business).toContain("Business outcome");
    expect(business).not.toMatch(/red|danger|rose/);

    const failed = statusChip("failed");
    expect(failed).toMatch(/red/);
    expect(statusChip("crashed")).toMatch(/red/);
    expect(statusChip("succeeded")).toMatch(/emerald|green/);
  });

  it("appends a human badge when escalated", () => {
    expect(statusChip("succeeded", true)).toContain("Human");
    expect(statusChip("succeeded", false)).not.toContain("Human");
  });

  it("escapes plain table cells but passes composed markup through", () => {
    const html = table(["Header"], [[XSS], [{ html: "<b>bold</b>" }]]);
    assertNoRawScript(html);
    expect(html).toContain("<b>bold</b>");
  });

  it("formats durations and relative times", () => {
    expect(duration(840)).toBe("840ms");
    expect(duration(7400)).toBe("7.4s");
    expect(duration(125000)).toBe("2m 05s");
    const now = Date.parse("2026-08-20T10:00:00.000Z");
    expect(timeAgo("2026-08-20T09:58:00.000Z", now)).toBe("2m ago");
    expect(timeAgo("not-a-date", now)).toBe("not-a-date");
  });
});

describe("catalogPage", () => {
  it("groups by app and renders the call contract plus an invoke link", () => {
    const html = catalogPage([
      catalogEntry(),
      catalogEntry({ id: "transfer-funds", name: "Transfer funds", irreversible: true, app: "meridian-core", appDisplayName: "Meridian Core" }),
    ]);
    expect(html).toContain("Legacy Core Banking");
    expect(html).toContain("Meridian Core");
    expect(html).toContain("Look up member and read savings balance");
    expect(html).toContain("memberId");
    expect(html).toContain("savingsBalance");
    expect(html).toContain("MEMBER_NOT_FOUND");
    expect(html).toContain("v3");
    expect(html).toContain("0123456789ab");
    expect(html).toContain("teller");
    expect(html).toContain("Irreversible");
    expect(html).toContain('href="/capabilities/lookup-member-balance/invoke"');
  });

  it("folds the recorded recipe into a details element when the artifact is present", () => {
    const html = catalogPage([detailEntry(baseArtifact().inputParams)]);
    expect(html).toContain("<details");
    expect(html).toContain("Fill member ID search box");
    expect(html).toContain("Savings balance panel is visible");
    expect(html).toContain("member-not-found");
    expect(html).toContain("role(textbox");
  });

  it("renders an empty state with no capabilities", () => {
    expect(catalogPage([])).toContain("No capabilities recorded yet");
  });

  it("escapes hostile capability metadata", () => {
    assertNoRawScript(catalogPage([catalogEntry({ name: XSS, description: XSS, appDisplayName: XSS })]));
  });
});

describe("invokePage", () => {
  const params: InputParam[] = [
    { name: "memberId", type: "string", required: true, sensitive: false, example: "1001" },
    { name: "amount", type: "currency", required: true, sensitive: false, example: "25.00" },
    { name: "count", type: "number", required: false, sensitive: false },
    { name: "effectiveDate", type: "date", required: true, sensitive: false, example: "2026-08-20" },
    { name: "confirmed", type: "boolean", required: false, sensitive: false, example: true },
    { name: "pin", type: "string", required: true, sensitive: true },
  ];

  it("emits exactly one control per declared param, with the right type", () => {
    const html = invokePage(detailEntry(params), { roles: ["teller", "supervisor"] });

    const controls = [...html.matchAll(/<(input|select)\b[^>]*name="([^"]+)"[^>]*>/g)]
      .map((m) => ({ tag: m[1], name: m[2], markup: m[0] }))
      // the hidden companion of a checkbox is not a control
      .filter((c) => !/type="hidden"/.test(c.markup));

    const named = controls.filter((c) => params.some((p) => p.name === c.name));
    expect(named.map((c) => c.name).sort()).toEqual(params.map((p) => p.name).sort());
    expect(named).toHaveLength(params.length);

    const byName = new Map(named.map((c) => [c.name, c.markup]));
    expect(byName.get("memberId")).toContain('type="text"');
    expect(byName.get("memberId")).toContain('placeholder="1001"');
    expect(byName.get("memberId")).toContain("required");
    expect(byName.get("amount")).toContain('type="number"');
    expect(byName.get("amount")).toContain('step="0.01"');
    expect(byName.get("count")).toContain('type="number"');
    expect(byName.get("count")).toContain('step="0.01"');
    expect(byName.get("count")).not.toContain("required");
    expect(byName.get("effectiveDate")).toContain('type="date"');
    expect(byName.get("confirmed")).toContain('type="checkbox"');
    expect(byName.get("confirmed")).toContain("checked");
    expect(byName.get("pin")).toContain('type="password"');
  });

  it("renders a select when a param declares options", () => {
    const withOptions = [
      { name: "accountType", type: "string", required: true, sensitive: false, options: ["checking", "savings"] },
    ] as unknown as InputParam[];
    const html = invokePage(detailEntry(withOptions), { roles: ["teller"] });
    expect(html).toMatch(/<select[^>]*name="accountType"/);
    expect(html).toContain(">checking<");
    expect(html).toContain(">savings<");
  });

  it("shows the declared type next to every label and posts to the capability", () => {
    const html = invokePage(detailEntry(params), { roles: ["teller"] });
    expect(html).toContain('action="/capabilities/lookup-member-balance/invoke"');
    expect(html).toContain('method="post"');
    for (const type of ["string", "currency", "number", "date", "boolean"]) {
      expect(html).toContain(`>${type}</span>`);
    }
    for (const param of params) expect(html).toContain(`for="param-${param.name}"`);
  });

  it("defaults the role select to the capability's required role", () => {
    const html = invokePage(detailEntry(params), { roles: ["teller", "supervisor"] });
    expect(html).toMatch(/<option value="teller" selected/);
  });

  it("keeps the escalate checkbox checked by default", () => {
    const html = invokePage(detailEntry(params), { roles: ["teller"] });
    expect(html).toMatch(/id="escalate"[^>]*checked/);
    const unchecked = invokePage(detailEntry(params), { roles: ["teller"], values: { escalate: "false" } });
    expect(unchecked).not.toMatch(/id="escalate"[^>]*checked/);
  });

  it("disables submit and names the active run when the runner is busy", () => {
    const busy = runSummary({ runId: "busy-run", status: "running" });
    const html = invokePage(detailEntry(params), { roles: ["teller"], busyWith: busy });
    expect(html).toContain("The runner is busy");
    expect(html).toContain('href="/runs/busy-run"');
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("re-renders with per-field errors and preserved values", () => {
    const html = invokePage(detailEntry(params), {
      roles: ["teller"],
      values: { memberId: "not-a-member", amount: "12.50" },
      errors: [{ name: "memberId", problem: "must be numeric" }],
    });
    expect(html).toContain('value="not-a-member"');
    expect(html).toContain('value="12.50"');
    expect(html).toContain("must be numeric");
    expect(html).toContain("ring-red-400");
  });

  it("escapes hostile submitted values", () => {
    const html = invokePage(detailEntry(params), {
      roles: [XSS],
      values: { memberId: XSS },
      errors: [{ name: "memberId", problem: XSS }],
    });
    assertNoRawScript(html);
  });
});

describe("runsPage", () => {
  it("renders a row per run with a link, status and duration", () => {
    const html = runsPage([runSummary(), runSummary({ runId: "run-2", status: "business_outcome", escalated: true })]);
    expect(html).toContain('href="/runs/lookup-member-balance-1787246804295"');
    expect(html).toContain('href="/runs/run-2"');
    expect(html).toContain("replay");
    expect(html).toContain("teller");
    expect(html).toContain("Business outcome");
    expect(html).toContain("Human");
    expect(html).toContain("7.4s");
  });

  it("renders an empty state and escapes hostile ids", () => {
    expect(runsPage([])).toContain("No runs recorded yet");
    assertNoRawScript(runsPage([runSummary({ capabilityId: XSS, role: XSS })]));
  });
});

describe("overviewPage", () => {
  it("shows an idle runner, the apps, counts, recent runs and the demo script", () => {
    const html = overviewPage({
      apps: [{ id: "legacy-core-banking", displayName: "Legacy Core Banking", baseUrl: "http://localhost:4000" }],
      recent: [runSummary(), runSummary({ runId: "r2" })],
      counts: COUNTS,
      demoLinks: [
        { label: "Happy path", description: "member 1001", href: "/capabilities/lookup-member-balance/invoke?memberId=1001" },
        { label: "Business outcome", description: "member 9999", href: "/capabilities/lookup-member-balance/invoke?memberId=9999" },
        { label: "Injected fault", description: "arm the slow lever first", href: "/faults" },
      ],
    });
    expect(html).toContain("Runner idle");
    expect(html).toContain("Legacy Core Banking");
    expect(html).toContain("Demo script");
    expect(html).toContain("Happy path");
    expect(html).toContain("memberId=1001");
    expect(html).toContain("Recent runs");
    expect(html).toContain("Success");
  });

  it("caps recent runs at five", () => {
    const many = Array.from({ length: 9 }, (_, i) => runSummary({ runId: `run-${i}` }));
    const html = overviewPage({ apps: [], recent: many, counts: COUNTS });
    expect(html).toContain("run-0");
    expect(html).toContain("run-4");
    expect(html).not.toContain("run-5");
  });

  it("makes a paused runner prominent with a link to the escalation", () => {
    const html = overviewPage({
      apps: [],
      active: runSummary({ runId: "paused-run", status: "escalation_pending", escalated: true }),
      recent: [],
      counts: COUNTS,
    });
    expect(html).toContain("awaiting you");
    expect(html).toContain('href="/runs/paused-run/escalation"');
    expect(html).toContain("bg-amber-50");
  });

  it("names the running capability", () => {
    const html = overviewPage({
      apps: [],
      active: runSummary({ runId: "live-run", status: "running" }),
      recent: [],
      counts: COUNTS,
    });
    expect(html).toContain("Running lookup-member-balance");
    expect(html).toContain('href="/runs/live-run"');
  });
});

describe("runDetailPage", () => {
  it("renders the header, inputs, timeline and a success result", () => {
    const html = runDetailPage(runRecord(), EVENTS, { evidence: ALL_EVIDENCE, live: false });
    expect(html).toContain("lookup-member-balance");
    expect(html).toContain("Success");
    expect(html).toContain("$3,482.10");
    expect(html).toContain("Savings balance panel is visible");
    expect(html).toContain("Re-invoke with these");
    expect(html).toContain("/capabilities/lookup-member-balance/invoke?memberId=1001");
    expect(html).toContain("Run log (JSONL)");
    expect(html).toContain('href="/runs/lookup-member-balance-1787246804295/evidence/jsonl"');
  });

  it("renders every interesting event kind in the timeline with elapsed times", () => {
    const html = runDetailPage(runRecord(), EVENTS, { evidence: [], live: false });
    expect(html).toContain("step-1");
    expect(html).toContain("FELL BACK");
    expect(html).toContain("retrying");
    expect(html).toContain("whole flow restarted");
    expect(html).toContain("session-expired");
    expect(html).toContain("Receipt shown");
    expect(html).toContain("Clicked Confirm");
    expect(html).toContain("savingsBalance = $3,482.10");
    expect(html).toContain("+1.2s");
    expect(html).toContain('data-event-index="10"');
  });

  it("shows a live screenshot only while the run is not terminal", () => {
    const live = runDetailPage(
      runRecord({ status: "running", result: undefined, durationMs: undefined }),
      EVENTS,
      { evidence: [], live: true },
    );
    expect(live).toContain('src="/runs/lookup-member-balance-1787246804295/screenshot"');
    expect(live).toContain('id="live-screenshot"');

    const archived = runDetailPage(runRecord(), EVENTS, { evidence: [], live: true });
    expect(archived).not.toContain("live-screenshot");
  });

  it("renders a business outcome neutrally, and a hard failure as a danger", () => {
    const business = runDetailPage(
      runRecord({
        status: "business_outcome",
        result: {
          status: "business_outcome",
          code: "MEMBER_NOT_FOUND",
          message: "No member found with the given ID.",
          outcomeId: "member-not-found",
        },
      }),
      [],
      { evidence: [], live: false },
    );
    expect(business).toContain("MEMBER_NOT_FOUND");
    expect(business).toContain("legitimate, expected result");
    // Token-level, not substring: prose like "the app answered" contains "red".
    const businessResult = section(business, "Business outcome");
    expect(businessResult).not.toMatch(/(?:bg|text|ring|border|from|to)-(?:red|rose)-/);
    expect(businessResult).not.toMatch(/danger/);

    const failure = runDetailPage(
      runRecord({
        status: "failed",
        result: {
          status: "hard_failure",
          stepId: "step-2",
          stepDescription: "Click search",
          reason: "Locator never resolved",
          expected: "Search button",
          observed: "nothing matched",
        },
      }),
      [],
      { evidence: ["failure.png", "failure.dom.html"], live: false },
    );
    expect(failure).toContain("Hard failure");
    expect(failure).toContain("step-2");
    expect(failure).toContain("Locator never resolved");
    expect(failure).toContain("Search button");
    expect(failure).toContain("nothing matched");
    expect(failure).toMatch(/ring-red-300/);
    expect(failure).toContain("/evidence/failure.png");
    expect(failure).toContain("/evidence/failure.dom.html");
  });

  it("banners a pending escalation", () => {
    const html = runDetailPage(
      runRecord({
        status: "escalation_pending",
        result: undefined,
        escalationPending: {
          kind: "replay_hard_failure",
          reason: "Confirm button never appeared",
          raisedAt: "2026-08-20T10:00:06.000Z",
          consoleUrl: "/runs/lookup-member-balance-1787246804295/escalation",
        },
      }),
      EVENTS,
      { evidence: [], live: true },
    );
    expect(html).toContain("waiting for you");
    expect(html).toContain("Confirm button never appeared");
    expect(html).toContain('href="/runs/lookup-member-balance-1787246804295/escalation"');
    expect(html).toContain("bg-amber-50");
  });

  it("drops the banner once nobody is waiting, whatever escalationPending still holds", () => {
    // escalationPending is never cleared -- it is the record of what was asked
    // for. Rendering its call to action against a finished run invites an
    // operator to take control of a session that no longer exists.
    const resolved = runRecord({
      status: "succeeded",
      escalated: true,
      escalationPending: {
        kind: "replay_hard_failure",
        reason: "Confirm button never appeared",
        raisedAt: "2026-08-20T10:00:06.000Z",
        consoleUrl: "/runs/lookup-member-balance-1787246804295/escalation",
      },
      humanIntervention: {
        raisedAt: "2026-08-20T10:00:06.000Z",
        resolvedAt: "2026-08-20T10:00:20.000Z",
        kind: "replay_hard_failure",
        reason: "Confirm button never appeared",
        decision: "resumed",
        actions: [],
      },
    });

    const html = runDetailPage(resolved, EVENTS, { evidence: [], live: false });

    expect(html).not.toContain("waiting for you");
    expect(html).not.toContain("Take control");
    // The history is still on the page, in the section that reports outcomes.
    expect(html).toContain("Human intervention");
    expect(html).toContain("Confirm button never appeared");
  });

  it("gives the live view the full content width rather than the sidebar", () => {
    // A 1280px capture rendered in a third-width column is unreadable, and
    // reading it is the entire point while a run is in flight.
    const html = runDetailPage(runRecord({ status: "running", result: undefined }), EVENTS, {
      evidence: [],
      live: true,
    });

    expect(html).toContain('id="live-screenshot"');
    expect(html.indexOf('id="live-screenshot"')).toBeLessThan(html.indexOf("lg:grid-cols-3"));
  });

  it("lists human actions and strikes blocked ones through in red", () => {
    const html = runDetailPage(
      runRecord({
        escalated: true,
        humanIntervention: {
          raisedAt: "2026-08-20T10:00:06.000Z",
          resolvedAt: "2026-08-20T10:00:20.000Z",
          kind: "replay_hard_failure",
          reason: "Confirm button never appeared",
          decision: "resumed",
          // `blocked` is not on HumanAction yet — see the report. The view
          // reads it defensively, so the test supplies it the same way.
          actions: [
            { timestamp: "2026-08-20T10:00:07.000Z", type: "click", detail: "Clicked Confirm" },
            { timestamp: "2026-08-20T10:00:08.000Z", type: "navigate", detail: "/settings", blocked: true },
          ] as HumanAction[],
        },
      }),
      [],
      { evidence: [], live: false },
    );
    expect(html).toContain("Human intervention");
    expect(html).toContain("Clicked Confirm");
    expect(html).toContain('class="line-through text-red-700">/settings');
    expect(html).toContain("blocked by guardrails");
  });

  it("explains a crashed run that never produced a result", () => {
    const html = runDetailPage(
      runRecord({ status: "crashed", result: undefined, error: "process exited" }),
      [],
      { evidence: [], live: false },
    );
    expect(html).toContain("died before it could record a result");
    expect(html).toContain("process exited");
  });

  it("escapes hostile scraped text from the target app", () => {
    const html = runDetailPage(
      runRecord({
        params: { memberId: XSS },
        result: {
          status: "hard_failure",
          stepId: XSS,
          stepDescription: XSS,
          reason: XSS,
          observed: XSS,
        },
      }),
      [{ index: 0, timestamp: "2026-08-20T10:00:00.000Z", type: "step_result", stepId: XSS, ok: false, error: XSS }],
      { evidence: [], live: false },
    );
    assertNoRawScript(html);
  });
});

describe("poll scripts", () => {
  it("polls status and events, cache-busts the screenshot and reloads once when terminal", () => {
    const html = pollScript({ runId: "run-1", pollMs: 900 });
    expect(html.startsWith("<script>")).toBe(true);
    expect(html.trim().endsWith("</script>")).toBe(true);
    expect(html).toContain("/api/runs/");
    expect(html).toContain("/status");
    expect(html).toContain("/events");
    expect(html).toContain("since=");
    expect(html).toContain("/screenshot?t=");
    expect(html).toContain("location.reload()");
    expect(html).toContain("if (reloaded) return;");
    expect(html).toContain("900");
  });

  it("cannot be broken out of by a hostile run id", () => {
    const html = pollScript({ runId: `x"</script><script>alert(1)//` });
    expect(html).not.toContain("</script><script>");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003C");
  });

  it("re-enables invoke controls when the runner frees up", () => {
    const html = runnerPollScript();
    expect(html).toContain("/api/runner");
    expect(html).toContain("data-runner-lock");
    expect(html).toContain("removeAttribute(\"disabled\")");
    expect(html).toContain("data-runner-banner");
  });
});

/** The rendered card whose heading is `title`, up to the start of the next card. */
function section(html: string, title: string): string {
  const start = html.indexOf(`>${title}</h2>`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf("</section>", start);
  return html.slice(start, next === -1 ? undefined : next);
}
