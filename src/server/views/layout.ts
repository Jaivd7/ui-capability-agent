/**
 * The page shell: one `<html>` document, one nav, one place where the
 * fault-injection banner lives.
 *
 * Everything in `src/server/views/` is a pure function from data to an HTML
 * string — no express, no data access, no I/O. That is what makes the view
 * layer testable on its own (see views.test.ts) and buildable in parallel with
 * the server that will eventually call it.
 */

/**
 * Escapes a value for interpolation into HTML text or a double/single quoted
 * attribute. Applied to *every* interpolated value in this package, without
 * exception: the strings flowing through here include text scraped from a live
 * banking UI, operator free text typed into an escalation console, and error
 * messages that quote page content back at us.
 *
 * `&` is replaced first so the entity prefixes introduced below are not
 * double-escaped. Both quote characters are escaped, so an interpolated value
 * cannot break out of an attribute — every attribute this package emits is
 * quoted, which is what makes that sufficient.
 */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes a value for interpolation into a URL path or query segment. */
export function escapeUrl(s: string): string {
  return escapeHtml(encodeURIComponent(String(s)));
}

interface NavItem {
  key: string;
  label: string;
  href: string;
}

const NAV: NavItem[] = [
  { key: "overview", label: "Overview", href: "/" },
  { key: "capabilities", label: "Capabilities", href: "/capabilities" },
  { key: "runs", label: "Runs", href: "/runs" },
  { key: "faults", label: "Faults", href: "/faults" },
];

export interface LayoutOptions {
  title: string;
  /** Already-rendered HTML for the page body. */
  body: string;
  /** `key` of the NAV entry to highlight. */
  activeNav?: string;
  /**
   * Set to a human description of the armed fault when any fault injection is
   * active. Rendered persistently, on every page, because the single most
   * likely way a demo of this system goes wrong is a reviewer arming a fault,
   * forgetting, and then watching every subsequent run "mysteriously" fail.
   */
  faultBanner?: string;
  /** Inline `<script>` markup appended before `</body>`. */
  pollScript?: string;
}

export function layout(opts: LayoutOptions): string {
  const { title, body, activeNav, faultBanner, pollScript } = opts;

  const nav = NAV.map((item) => {
    const active = item.key === activeNav;
    const cls = active
      ? "text-slate-900 bg-white shadow-sm ring-1 ring-slate-200"
      : "text-slate-500 hover:text-slate-900 hover:bg-slate-100";
    return `<a href="${escapeHtml(item.href)}" class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${cls}"${
      active ? ' aria-current="page"' : ""
    }>${escapeHtml(item.label)}</a>`;
  }).join("");

  const banner = faultBanner
    ? `<div class="border-b border-amber-300 bg-amber-50">
        <div class="mx-auto max-w-6xl px-6 py-2.5 flex items-start gap-2.5 text-sm text-amber-900">
          <span aria-hidden="true" class="mt-px font-semibold">&#9888;</span>
          <p class="flex-1"><span class="font-semibold">Fault injection armed.</span> ${escapeHtml(
            faultBanner,
          )} Runs may fail by design until this is cleared.</p>
          <a href="/faults" class="shrink-0 font-medium underline underline-offset-2 hover:no-underline">Manage faults</a>
        </div>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} &middot; Capability Console</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-feature-settings: "cv02","cv03","cv04","cv11"; }
  details > summary { list-style: none; cursor: pointer; }
  details > summary::-webkit-details-marker { display: none; }
  details[open] > summary .chev { transform: rotate(90deg); }
</style>
</head>
<body class="h-full bg-slate-50 text-slate-800 antialiased">
<header class="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200">
  <div class="mx-auto max-w-6xl px-6 h-14 flex items-center gap-6">
    <a href="/" class="flex items-center gap-2 shrink-0">
      <span class="inline-flex h-6 w-6 items-center justify-center rounded bg-slate-900 text-[11px] font-bold text-white">UC</span>
      <span class="text-sm font-semibold tracking-tight text-slate-900">Capability Console</span>
    </a>
    <nav class="flex items-center gap-1 rounded-lg bg-slate-50 p-1 ring-1 ring-slate-200/70">${nav}</nav>
  </div>
  ${banner}
</header>
<main class="mx-auto max-w-6xl px-6 py-8">
${body}
</main>
<footer class="mx-auto max-w-6xl px-6 pb-10 pt-2 text-xs text-slate-400">
  Server-rendered. Every result on this page was rendered by the server; the browser only polls for liveness.
</footer>
${pollScript ?? ""}
</body>
</html>`;
}
