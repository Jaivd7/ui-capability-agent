/**
 * The page shell: one `<html>` document, one nav, one place where the
 * fault-injection banner lives.
 *
 * The header is a solid accent band rather than another white surface. It is
 * the only structural use of the accent in the console — everywhere else teal
 * is a button or a link — and it exists so the page has a top edge instead of
 * white chrome dissolving into a white body. The seven semantic hues are
 * untouched by it: nothing in the band carries meaning, so it cannot compete
 * with the status colours, which is the constraint theme.ts sets out.
 *
 * Everything in `src/server/views/` is a pure function from data to an HTML
 * string — no express, no data access, no I/O. That is what makes the view
 * layer testable on its own (see views.test.ts) and buildable in parallel with
 * the server that will eventually call it.
 */

import { icon } from "./icons.js";
import { THEME_HEAD } from "./theme.js";

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

/**
 * Four items, and the catalog is the root.
 *
 * There was a fifth — an Overview at `/` — and three of its five cards were
 * digests of pages you would rather just open: recent runs (all of them are at
 * `/runs`), target apps (the catalog prints each app's base URL in its group
 * header), and runner state (already on the two pages where it changes what you
 * can do). An index page for a four-page console is a hop, not a summary. The
 * two cards that were not duplicates — the status counts and the demo links —
 * moved onto the catalog, which is where the work starts anyway.
 */
const NAV: NavItem[] = [
  { key: "capabilities", label: "Capabilities", href: "/" },
  { key: "discovery", label: "Discovery", href: "/discovery" },
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
    // On the accent band the underline cannot also be the accent, so the active
    // item is marked in white and the rest are held back rather than greyed:
    // stone-400 on teal is legible where `muted` (tuned for paper) is not.
    const cls = active
      ? "text-white after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-white"
      : "text-stone-300 hover:text-white";
    return `<a href="${escapeHtml(
      item.href,
    )}" class="relative px-2 py-4 text-sm font-medium transition-colors ${cls}"${
      active ? ' aria-current="page"' : ""
    }>${escapeHtml(item.label)}</a>`;
  }).join("");

  const banner = faultBanner
    ? `<div class="border-b border-amber-300 bg-amber-50">
        <div class="mx-auto flex max-w-6xl items-start gap-2.5 px-6 py-2.5 text-sm text-amber-900">
          <span class="mt-0.5 text-amber-700">${icon("warning")}</span>
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
${THEME_HEAD}
</head>
<body class="h-full bg-paper font-sans text-stone-800 antialiased">
<header class="sticky top-0 z-20 bg-accent">
  <div class="mx-auto flex max-w-6xl items-center gap-8 px-6">
    <a href="/" class="flex shrink-0 items-center gap-2.5 py-3.5">
      <span class="inline-flex h-6 w-6 items-center justify-center rounded bg-white font-serif text-[13px] font-semibold text-accent">C</span>
      <span class="font-serif text-[15px] font-semibold tracking-tight text-white">Capability Console</span>
    </a>
    <nav class="flex items-center gap-5">${nav}</nav>
  </div>
  ${banner}
</header>
<main class="mx-auto max-w-6xl px-6 py-10">
${body}
</main>
<footer class="mx-auto max-w-6xl px-6 pb-10 pt-2 text-[11px] text-stone-400">
  Server-rendered &middot; the browser only polls for liveness
</footer>
${pollScript ?? ""}
</body>
</html>`;
}
