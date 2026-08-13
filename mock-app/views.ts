import type { Member } from "./data.js";

/**
 * Server-rendered, table-laid-out, no-test-id "legacy" markup on purpose —
 * see LEARNING_NOTES.md / REPORT.md for why. Real native form controls and
 * tables are used throughout (so the accessibility tree is genuinely
 * meaningful, per how actual legacy enterprise apps usually look), but
 * visual structure uses <table> for layout and CSS class names in the old
 * "tbl1 / fld / hdr" enterprise style, and most elements carry no
 * data-testid or semantic sectioning at all. One field (the sub-account
 * opening deposit input) is deliberately given no label/aria-label/
 * placeholder at all, to force the locator fallback chain to bottom out at
 * a structural CSS selector — see docs/artifact-schema.md's locator
 * rationale.
 */

function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escape(title)} - Meridian Core Banking</title>
<style>
  body { font-family: Verdana, sans-serif; font-size: 13px; background:#d4d0c8; }
  table.tbl1 { border-collapse: collapse; background: #fff; }
  table.tbl1 td, table.tbl1 th { border: 1px solid #808080; padding: 4px 8px; }
  table.tbl1 th { background: #c0c0c0; text-align:left; }
  .hdr { background:#000080; color:#fff; padding:6px 10px; font-weight:bold; }
  .banner-error { color:#a00; font-weight:bold; margin:8px 0; }
  .banner-info { color:#004a00; font-weight:bold; margin:8px 0; }
</style>
</head>
<body>
<div class="hdr">MERIDIAN CORE BANKING &mdash; INTERNAL USE ONLY</div>
${body}
</body>
</html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function loginPage(opts: { error?: string; expired?: boolean }): string {
  const banner = opts.error
    ? `<p class="banner-error">${escape(opts.error)}</p>`
    : opts.expired
      ? `<p class="banner-error">Your session has expired. Please log in again.</p>`
      : "";
  return layout(
    "Login",
    `
    <h1>Sign In</h1>
    ${banner}
    <form method="post" action="/login">
      <table class="tbl1">
        <tr><td><label for="username">Username</label></td><td><input type="text" id="username" name="username" /></td></tr>
        <tr><td><label for="password">Password</label></td><td><input type="password" id="password" name="password" /></td></tr>
      </table>
      <p><button type="submit">Sign In</button></p>
    </form>
  `,
  );
}

export function membersSearchPage(opts: {
  memberId?: string;
  result?: Member | null;
  searched: boolean;
}): string {
  let resultsHtml = "";
  if (opts.searched) {
    if (opts.result) {
      resultsHtml = `
        <h2>Results</h2>
        <table class="tbl1">
          <tr><th>Member ID</th><th>Name</th><th></th></tr>
          <tr>
            <td>${escape(opts.result.id)}</td>
            <td>${escape(opts.result.name)}</td>
            <td><a href="/members/${escape(opts.result.id)}">View</a></td>
          </tr>
        </table>`;
    } else {
      resultsHtml = `<p class="banner-error">No member found with that ID.</p>`;
    }
  }
  return layout(
    "Member Search",
    `
    <h1>Member Search</h1>
    <form method="get" action="/members">
      <table class="tbl1">
        <tr><td><label for="memberId">Member ID</label></td><td><input type="text" id="memberId" name="memberId" value="${escape(opts.memberId ?? "")}" /></td></tr>
      </table>
      <p><button type="submit">Search</button></p>
    </form>
    ${resultsHtml}
    <p><a href="/logout">Log out</a></p>
  `,
  );
}

export function memberDetailPage(member: Member, role: string): string {
  return layout(
    "Member Detail",
    `
    <h1>Member: ${escape(member.name)}</h1>
    <table class="tbl1">
      <tr><td>Member ID</td><td>${escape(member.id)}</td></tr>
    </table>
    <h2>Account Details</h2>
    <iframe name="account-detail" title="Account Details" src="/members/${escape(member.id)}/account-panel" width="500" height="180" style="border:1px solid #808080;"></iframe>
    <p>
      ${role === "teller" ? `<a href="/members/${escape(member.id)}/sub-account/new">Open Sub-Account</a>` : `<em>Sub-account actions require teller role.</em>`}
    </p>
    <p><a href="/members">Back to search</a> | <a href="/logout">Log out</a></p>
  `,
  );
}

export function accountPanelFragment(member: Member): string {
  // Standalone document (rendered inside an <iframe>) — deliberately a
  // separate response, not a partial injected into the parent DOM, so a
  // locator that doesn't account for frame context will silently fail to
  // find these cells.
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Verdana, sans-serif; font-size: 12px; margin:6px; }
  table.tbl1 { border-collapse: collapse; }
  table.tbl1 td { border: 1px solid #808080; padding: 3px 6px; }
</style></head>
<body>
<table class="tbl1">
  <tr><td>Savings Balance</td><td aria-label="Savings Balance">$${member.savings.toFixed(2)}</td></tr>
  <tr><td>Checking Balance</td><td aria-label="Checking Balance">$${member.checking.toFixed(2)}</td></tr>
</table>
</body></html>`;
}

export function subAccountFormPage(
  member: Member,
  opts: {
    validationError?: string | undefined;
    accountType?: string | undefined;
    openingDeposit?: string | undefined;
  },
): string {
  const error = opts.validationError ? `<p class="banner-error">${escape(opts.validationError)}</p>` : "";
  return layout(
    "New Sub-Account",
    `
    <h1>Open New Sub-Account &mdash; ${escape(member.name)} (${escape(member.id)})</h1>
    ${error}
    <form method="post" action="/members/${escape(member.id)}/sub-account/new" id="newSubAccountForm">
      <table class="tbl1">
        <tr>
          <td><label for="accountType">Account Type</label></td>
          <td>
            <select id="accountType" name="accountType">
              <option value="Youth Savings" ${opts.accountType === "Youth Savings" ? "selected" : ""}>Youth Savings</option>
              <option value="Holiday Club" ${opts.accountType === "Holiday Club" ? "selected" : ""}>Holiday Club</option>
              <option value="Standard Savings" ${opts.accountType === "Standard Savings" ? "selected" : ""}>Standard Savings</option>
            </select>
          </td>
        </tr>
        <tr>
          <td>Opening Deposit Amount ($)</td>
          <td><input type="text" name="openingDeposit" value="${escape(opts.openingDeposit ?? "")}" /></td>
        </tr>
      </table>
      <p><button type="submit" id="continueBtn">Continue</button></p>
    </form>
    <script>
      document.getElementById('newSubAccountForm').addEventListener('submit', function (e) {
        var ok = window.confirm('Opening a new sub-account is a compliance-sensitive action. Continue to review?');
        if (!ok) e.preventDefault();
      });
    </script>
    <p><a href="/members/${escape(member.id)}">Cancel</a></p>
  `,
  );
}

export function subAccountConfirmPage(
  member: Member,
  accountType: string,
  openingDeposit: number,
): string {
  return layout(
    "Confirm New Sub-Account",
    `
    <h1>Review Sub-Account Details</h1>
    <table class="tbl1">
      <tr><td>Member</td><td>${escape(member.name)} (${escape(member.id)})</td></tr>
      <tr><td>Account Type</td><td>${escape(accountType)}</td></tr>
      <tr><td>Opening Deposit</td><td>$${openingDeposit.toFixed(2)}</td></tr>
    </table>
    <form method="post" action="/members/${escape(member.id)}/sub-account/confirm">
      <input type="hidden" name="accountType" value="${escape(accountType)}" />
      <input type="hidden" name="openingDeposit" value="${openingDeposit}" />
      <p>
        <button type="submit">Confirm &amp; Open Account</button>
        <a href="/members/${escape(member.id)}">Cancel</a>
      </p>
    </form>
  `,
  );
}

export function subAccountSuccessPage(member: Member, accountNumber: string): string {
  return layout(
    "Sub-Account Opened",
    `
    <h1>Sub-Account Opened</h1>
    <p class="banner-info">Sub-account opened successfully. New account number: ${escape(accountNumber)}.</p>
    <p><a href="/members/${escape(member.id)}">Back to member</a></p>
  `,
  );
}

export function permissionDeniedPage(): string {
  return layout(
    "Permission Denied",
    `<h1>Permission Denied</h1><p class="banner-error">Permission denied: your role does not permit this action.</p>`,
  );
}

export function notFoundPage(message: string): string {
  return layout("Not Found", `<h1>Not Found</h1><p class="banner-error">${escape(message)}</p>`);
}

export function crashPage(): string {
  return layout("Error", `<h1>Internal Server Error</h1><p class="banner-error">An unexpected error occurred.</p>`);
}
