/**
 * R3 brand assets + facelift palette for the Worker's server-rendered
 * pages and emails (facelift Phase 4, BRAND_BRIEF §9–§11).
 *
 * The geometry is copied verbatim from docs/brand/logo/ (the same strings
 * as packages/shared/src/ui/brand/paths.ts, which the Worker can't import
 * without pulling React). test/brand-r3-surfaces.test.ts pins these
 * strings to the SVG sources so they cannot drift.
 *
 * Rules (AVERROW_UI_STANDARD.md "Appearance & theme model"):
 *   - the mark is always red #C83C3C; tile #121B31, radius 7/32, no rim;
 *   - primary (CTAs, links, active states) is indigo — #4c5cf8 dark /
 *     #3250f0 light, with #96acff / #2a44d3 for AA primary-coloured text;
 *   - amber is a status colour only (warning / medium), never a CTA.
 */

/** The R3 mark, bounding box x 5.5..26.5, y 4..27.5 (viewBox "3.5 2 25 27.5"). */
export const R3_MARK_PATH =
  "M19.76 4L26.5 27.5L18.9 25L17.39 23.5L19.74 23.5L17.84 16L13.54 23.5L15.89 23.5L13.9 25L5.5 27.5Z";

/** The AVERROW wordmark, drawn at scale 0.01007 from a baseline at y=0. */
export const R3_WORDMARK_PATH =
  "M9 0H341L449 -325H1006L1110 0H1451L928 -1490H532ZM532 -571 583 -725C631 -877 677 -1029 731 -1214C784 -1029 830 -877 876 -725L926 -571ZM2074.9 0H2466.9L2978.9 -1490H2647.9L2414.9 -765C2371.9 -623 2325.9 -463 2273.9 -280C2219.9 -463 2172.9 -623 2127.9 -765L1886.9 -1490H1551.9ZM3242.3 0H4311.3V-264H3550.3V-624H4254.3V-881H3550.3V-1226H4311.3V-1490H3242.3ZM4630.6 0H4938.6V-521H5208.6C5209.6 -521 5210.6 -521 5211.6 -521L5475.6 0H5805.6L5506.6 -579C5673.6 -656 5772.6 -804 5772.6 -1001C5772.6 -1301 5562.6 -1490 5226.6 -1490H4630.6ZM4938.6 -768V-1234H5207.6C5370.6 -1234 5471.6 -1143 5471.6 -1001C5471.6 -859 5370.6 -768 5208.6 -768ZM6106 0H6414V-521H6684C6685 -521 6686 -521 6687 -521L6951 0H7281L6982 -579C7149 -656 7248 -804 7248 -1001C7248 -1301 7038 -1490 6702 -1490H6106ZM6414 -768V-1234H6683C6846 -1234 6947 -1143 6947 -1001C6947 -859 6846 -768 6684 -768ZM8235.4 24C8636.4 24 8938.4 -270 8938.4 -744C8938.4 -1219 8636.4 -1514 8235.4 -1514C7834.4 -1514 7533.4 -1219 7533.4 -744C7533.4 -272 7834.4 24 8235.4 24ZM8235.4 -248C8005.4 -248 7843.4 -428 7843.4 -744C7843.4 -1062 8005.4 -1242 8235.4 -1242C8465.4 -1242 8628.4 -1062 8628.4 -744C8628.4 -428 8465.4 -248 8235.4 -248ZM9533.2 0H9878.2L10088.2 -813C10107.2 -886 10124.2 -968 10144.2 -1062C10164.2 -968 10182.2 -886 10200.2 -813L10412.2 0H10755.2L11156.2 -1490H10827.2L10652.2 -750C10623.2 -620 10596.2 -490 10571.2 -361C10545.2 -490 10516.2 -620 10485.2 -750L10302.2 -1490H9988.2L9803.2 -750C9772.2 -619 9743.2 -488 9717.2 -357C9692.2 -488 9665.2 -619 9636.2 -750L9461.2 -1490H9133.2Z";

export const R3_MARK_RED = "#C83C3C";
export const R3_TILE_FILL = "#121B31";

/** Hosted R3 mark for emails: 144x144 transparent PNG, shown at 38x38.
 *  Lives in packages/averrow-ops/public/email/ (Vite copies it to
 *  public/v2/email/, served by the Worker's static assets). New filename
 *  so mail-proxy caches of the old /logo-email-mark.png don't apply. */
export const EMAIL_LOGO_URL = "https://averrow.com/v2/email/averrow-mark-r3.png";

/** Facelift palette (docs/brand/palettes/indigo.css, graphite + light). */
export const FACELIFT = {
  // indigo primary
  primary: "#4c5cf8",
  primaryHover: "#4f60ff",
  primaryText: "#96acff",
  primaryLight: "#3250f0",
  primaryHoverLight: "#2941d9",
  primaryTextLight: "#2a44d3",
  // graphite (dark)
  bgPage: "#0a0b0e",
  bgCard: "#151619",
  bgCardDeep: "#0f1013",
  bgElevated: "#1f2024",
  textPrimary: "#f6f7f7",
  textSecondary: "#c2c2c4",
  textTertiary: "#a1a1a3",
  textMuted: "#8b8c8d",
  // light
  bgPageLight: "#f0f2f8",
  textPrimaryLight: "#0f1216",
  textSecondaryLight: "#383b40",
  textTertiaryLight: "#4c4e54",
  textMutedLight: "#606369",
} as const;

/** System stacks: the self-hosted Geist woff2 ships with hashed names, so
 *  these pages name Geist first (used when installed) and fall back to the
 *  platform UI font. No Google Fonts. */
export const FONT_SANS_STACK =
  "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const FONT_MONO_STACK =
  "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export interface R3MarkOptions {
  /** Rendered height in px (>= 16). */
  size: number;
  /** Draw the #121B31 tile (app icon) behind the mark. Default true. */
  tile?: boolean;
  className?: string;
  /** Hide from assistive tech when a visible name sits next to it. */
  decorative?: boolean;
}

/** Inline R3 mark SVG — tile (app-icon.svg) or bare (mark-red.svg). */
export function r3MarkSvg(opts: R3MarkOptions): string {
  const h = Math.max(16, opts.size);
  const cls = opts.className ? ` class="${opts.className}"` : "";
  const a11y = opts.decorative ? ` aria-hidden="true" focusable="false"` : ` role="img" aria-label="Averrow"`;
  if (opts.tile ?? true) {
    return `<svg width="${h}" height="${h}" viewBox="0 0 32 32" fill="none" style="flex-shrink:0"${cls} data-logo="r3"${a11y}><rect width="32" height="32" rx="7" fill="${R3_TILE_FILL}"/><path transform="translate(1.02 0.86) scale(0.94)" d="${R3_MARK_PATH}" fill="${R3_MARK_RED}"/></svg>`;
  }
  const w = +(h * 25 / 27.5).toFixed(2);
  return `<svg width="${w}" height="${h}" viewBox="3.5 2 25 27.5" fill="none" style="flex-shrink:0"${cls} data-logo="r3"${a11y}><path d="${R3_MARK_PATH}" fill="${R3_MARK_RED}"/></svg>`;
}

/** Inline R3 wordmark SVG; `fill` defaults to currentColor so it follows
 *  the page's text colour in dark and light themes. */
export function r3WordmarkSvg(height: number, fill = "currentColor", className?: string): string {
  const w = +(height * 116.4 / 21).toFixed(2);
  const cls = className ? ` class="${className}"` : "";
  return `<svg width="${w}" height="${height}" viewBox="0 0 116.4 21"${cls} data-logo="r3-wordmark" role="img" aria-label="Averrow"><path transform="translate(2 18) scale(0.01007)" d="${R3_WORDMARK_PATH}" fill="${fill}"/></svg>`;
}

/** Inline favicon (docs/brand/logo/favicon.svg) as a data URI, so the
 *  pages don't depend on the frozen legacy /favicon.svg. */
export const R3_FAVICON_DATA_URI =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${R3_TILE_FILL}"/><path transform="translate(-1.02 -0.86) scale(1.06)" d="${R3_MARK_PATH}" fill="${R3_MARK_RED}"/></svg>`,
  );
