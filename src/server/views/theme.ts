/**
 * The Ledger palette, and the one place the design tokens are written down.
 *
 * The console drives a credit-union back-office mainframe, so the register is
 * financial print rather than SaaS: warm paper instead of the cool blue-grey
 * every dashboard defaults to, hairline rules instead of drop shadows, and a
 * serif for headings. `stone` is the neutral ramp throughout — the previous
 * `slate` is the single biggest reason the console read as generic.
 *
 * The accent is deep teal for a specific reason: seven hues are already spent
 * carrying meaning (emerald success, red failure, amber escalation, blue
 * in-flight, violet human, indigo discovery, stone business-outcome). An accent
 * drawn from any of those would blunt a distinction that is doing real work —
 * most importantly the deliberate choice, documented in components.ts, that a
 * business outcome is not painted as an error. Teal is unclaimed.
 */

export const COLORS = {
  /**
   * Warm manila, not off-white.
   *
   * This was `#FAFAF9` — one percent away from the `#FFFFFF` of every card sat
   * on it, which is no separation at all. Cards read as regions of the page
   * rather than as objects on it, and the whole console came across as "white",
   * which is the generic look the serif and the teal were chosen to avoid. The
   * ramp below is warmed to match: a cool grey rule on warm paper is the tell
   * that a palette was assembled rather than chosen.
   */
  paper: "#F3F0E8",
  surface: "#FFFFFF",
  rule: "#DDD7CA",
  ink: "#1C1917",
  muted: "#6E665B",
  accent: "#0F4C5C",
  accentHover: "#0B3A46",
  accentSoft: "#E6F0F2",
} as const;

/**
 * Only the weights actually used, with `display=swap`.
 *
 * Three families is more network weight than a console like this should spend,
 * so the set is deliberately thin: one serif weight, two mono, three sans. If
 * this ever reads as slow, the sans is the one to drop back to the system
 * stack — the serif and the mono are carrying the character.
 */
const FONT_HREF =
  "https://fonts.googleapis.com/css2" +
  "?family=Inter:wght@400;500;600" +
  "&family=Source+Serif+4:opsz,wght@8..60,600" +
  "&family=JetBrains+Mono:wght@400;500" +
  "&display=swap";

/**
 * Everything that belongs in `<head>`, in order: font preconnect, the Tailwind
 * CDN, then the config that extends it. The config assignment has to follow the
 * CDN script — the play CDN reads `window.tailwind.config` when it runs.
 */
export const THEME_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_HREF}">
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        paper: "${COLORS.paper}",
        surface: "${COLORS.surface}",
        rule: "${COLORS.rule}",
        ink: "${COLORS.ink}",
        muted: "${COLORS.muted}",
        accent: {
          DEFAULT: "${COLORS.accent}",
          hover: "${COLORS.accentHover}",
          soft: "${COLORS.accentSoft}",
        },
      },
      fontFamily: {
        // Quoted deliberately. Tailwind quotes a family name containing a
        // space, but "Source Serif 4" also ends in a numeral, and an unquoted
        // trailing number is not a valid CSS family token — so the browser threw
        // the whole declaration away and \`.font-serif\` came out empty, silently
        // falling every heading back to Inter.
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ['"Source Serif 4"', "ui-serif", "Georgia", "serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
};
</script>
<style>
  /* Inter's stylistic sets: straight-tailed l, open 4, disambiguated 1/I. */
  body { font-feature-settings: "cv02","cv03","cv04","cv11"; }
  details > summary { list-style: none; cursor: pointer; }
  details > summary::-webkit-details-marker { display: none; }
  details[open] > summary .chev { transform: rotate(90deg); }
</style>`;

/**
 * The type scale, five steps.
 *
 * Before this the whole console rendered at three sizes — text-sm, text-xs and
 * an 11px label — two of which differ by two pixels. That is why every page
 * read as one flat wall with nowhere for the eye to land.
 */
export const TYPE = {
  /** Page-level h1. The serif is the loudest single signal that this is not a stock dashboard. */
  pageTitle: "font-serif text-[28px] font-semibold leading-tight tracking-tight text-ink",
  /** Card and section headings. */
  sectionTitle: "text-sm font-semibold text-ink",
  /** Small-caps label above a value or a group. */
  label: "text-[11px] font-semibold uppercase tracking-wide text-muted",
  /** Default running text. */
  body: "text-sm text-stone-700",
  /** Supporting detail, timestamps, ids. */
  meta: "text-xs text-muted",
  /** The big number on a stat tile. */
  stat: "text-3xl font-semibold tabular-nums leading-none text-ink",
} as const;

/** Surfaces. Rules rather than shadows: paper stock, not floating glass. */
export const SURFACE = {
  card: "rounded-lg border border-rule bg-surface",
  /** For the one card on a page that should outrank the others. */
  cardEmphasis: "rounded-lg border border-accent/25 bg-surface ring-1 ring-inset ring-accent/10",
  inset: "rounded-lg border border-dashed border-rule bg-paper",
} as const;

/** Controls. */
export const CONTROL = {
  primary:
    "inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
  primaryDisabled:
    "inline-flex cursor-not-allowed items-center gap-1.5 rounded-md bg-stone-200 px-3.5 py-2 text-sm font-medium text-stone-400",
  secondary:
    "inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 hover:text-ink",
  link: "font-medium text-accent underline underline-offset-2 hover:text-accent-hover",
  input:
    "block w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-stone-400 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
  inputError:
    "block w-full rounded-md border border-red-400 bg-surface px-3 py-2 text-sm text-ink placeholder:text-stone-400 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500",
} as const;
