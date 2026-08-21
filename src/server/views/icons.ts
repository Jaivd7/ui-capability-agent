/**
 * The icon set: inline SVG, one 24×24 grid, drawn in `currentColor`.
 *
 * This replaces the HTML entities the console used to draw with — `&#9995;`,
 * `&#128100;`, `&#128274;` and friends. Those are emoji codepoints, so they
 * rendered as full-colour Apple glyphs on a Mac, flat monochrome on Linux, and
 * tofu wherever the font lacked them: three different consoles depending on who
 * opened it, and none of them matching the surrounding type.
 *
 * Inline rather than a sprite sheet or an icon font. There is no build step
 * here and no asset pipeline to hang one off, and at this count the bytes are
 * not worth a second request.
 */

interface IconDef {
  /** Path data, or several paths, drawn as strokes unless `fill` is set. */
  d: string[];
  /** Circles as [cx, cy, r]; stroked unless `fill` is set. */
  circles?: Array<[number, number, number]>;
  /** Rects as [x, y, w, h, rx]. */
  rects?: Array<[number, number, number, number, number]>;
  /** Solid shapes — the few glyphs that read better filled at 14px. */
  fill?: boolean;
}

const ICONS = {
  check: { d: ["M20 6 9 17l-5-5"] },
  x: { d: ["M18 6 6 18", "M6 6l12 12"] },
  warning: { d: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z", "M12 9v4", "M12 17h.01"] },
  hand: {
    d: [
      "M18 11V6a2 2 0 0 0-4 0",
      "M14 10V4a2 2 0 0 0-4 0v2",
      "M10 10.5V6a2 2 0 0 0-4 0v8",
      "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
    ],
  },
  user: { d: ["M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"], circles: [[12, 7, 4]] },
  lock: { d: ["M7 11V7a5 5 0 0 1 10 0v4"], rects: [[3, 11, 18, 11, 2]] },
  chevronRight: { d: ["m9 18 6-6-6-6"] },
  retry: { d: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"] },
  restart: { d: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"] },
  flag: { d: ["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", "M4 22v-7"] },
  target: { d: [], circles: [[12, 12, 10], [12, 12, 6], [12, 12, 2]] },
  download: { d: ["M12 5v14", "m19 12-7 7-7-7"] },
  model: { d: [], circles: [[12, 12, 10], [12, 12, 3]] },
  eye: { d: ["M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"], circles: [[12, 12, 3]] },
  ban: { d: ["m4.9 4.9 14.2 14.2"], circles: [[12, 12, 10]] },
  star: {
    d: [
      "M11.5 2.6a.6.6 0 0 1 1 0l2.4 5 5.4.8a.6.6 0 0 1 .3 1l-3.9 3.8.9 5.4a.6.6 0 0 1-.9.6l-4.8-2.5-4.8 2.5a.6.6 0 0 1-.9-.6l.9-5.4-3.9-3.8a.6.6 0 0 1 .3-1l5.4-.8z",
    ],
  },
  play: { d: ["m6 3 14 9-14 9V3z"], fill: true },
  stop: { d: [], rects: [[5, 5, 14, 14, 1]], fill: true },
  dot: { d: [], circles: [[12, 12, 3]], fill: true },
  info: { d: ["M12 16v-4", "M12 8h.01"], circles: [[12, 12, 10]] },
  book: { d: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"] },
  externalLink: { d: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"] },
  arrowRight: { d: ["M5 12h14", "m12 5 7 7-7 7"] },
  arrowLeft: { d: ["M19 12H5", "m12 19-7-7 7-7"] },
} satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;

export interface IconOptions {
  /** Tailwind sizing/colour classes. Defaults to a 14px glyph inheriting colour. */
  class?: string;
  /**
   * An accessible name. Omitted by default: nearly every icon here sits beside
   * its own text label, where a duplicate announcement is noise rather than
   * help. Pass one only where the glyph is the whole message.
   */
  label?: string;
}

/**
 * `stroke-width` is 2 on a 24-grid, which at the 14px these render is a hair
 * heavy — but a 1.5 stroke goes muddy against warm paper at that size, and
 * these sit next to 500-weight Inter rather than a light face.
 */
export function icon(name: IconName, opts?: IconOptions): string {
  const def: IconDef = ICONS[name];
  const cls = opts?.class ?? "h-3.5 w-3.5";
  const a11y = opts?.label
    ? `role="img" aria-label="${escapeAttr(opts.label)}"`
    : `aria-hidden="true" focusable="false"`;

  const paths = def.d.map((d) => `<path d="${d}"/>`).join("");
  const circles = (def.circles ?? []).map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join("");
  const rects = (def.rects ?? [])
    .map(([x, y, w, h, rx]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`)
    .join("");

  const paint = def.fill
    ? `fill="currentColor" stroke="none"`
    : `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

  return `<svg ${a11y} class="${escapeAttr(cls)} inline-block shrink-0" viewBox="0 0 24 24" ${paint}>${paths}${circles}${rects}</svg>`;
}

/** Local rather than imported from layout.ts, which imports nothing and should stay that way. */
function escapeAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
