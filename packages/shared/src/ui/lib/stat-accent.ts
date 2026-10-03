/**
 * Stat-card zero-state rule (audit M2, 2026-05-06).
 *
 * When a stat's primary value is numerically 0, its accent resolves to
 * `STAT_NEUTRAL` regardless of the caller's accent, so "0 ALERTS" reads calm,
 * not alarming. Non-numeric strings ("—", "N/A") are "data missing", not
 * zero, and keep the caller's accent.
 *
 * Copied from averrow-ops design-system/tokens.ts; PR6 repoints the ops copy.
 */
export const STAT_NEUTRAL = '#5a6a85';

export function resolveStatAccent(
  value: number | string | null | undefined,
  accent: string,
): string {
  if (value === null || value === undefined) return accent;
  const numeric =
    typeof value === 'number'
      ? value
      : Number(String(value).replace(/[\s,%]/g, ''));
  return Number.isFinite(numeric) && numeric === 0 ? STAT_NEUTRAL : accent;
}
