/**
 * Compact number display for tight tiles ("76.7K", "1.2M"), with the full value for the title / assistive tech.
 *
 * Numbers under `COMPACT_FROM` keep their full grouped form ("9,876"): a 4-digit count fits any tile and is exact.
 * From 10,000 up, the compact form keeps the leading digits that matter and one decimal ("76.7K"). Always en-US, like
 * the rest of the kit's number display.
 */

/** First magnitude shown compact. */
export const COMPACT_FROM = 10_000;

const FULL = new Intl.NumberFormat('en-US');
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** The whole number, grouped ("76,712"). Non-finite values read as "—". */
export function formatFull(n: number): string {
  return Number.isFinite(n) ? FULL.format(n) : '—';
}

/** Compact from `COMPACT_FROM` up ("76.7K"), full below it. Non-finite values read as "—". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) >= COMPACT_FROM ? COMPACT.format(n) : FULL.format(n);
}
