// Timestamp helpers. The worker stores D1 `datetime('now')` values
// ("2026-10-04 13:05:09", UTC, no zone marker) next to ISO strings; both must
// be read as UTC or relative times drift by the viewer's offset.

export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const s = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "just now", "5 min ago", "3 hours ago", "2 days ago", then a short date. */
export function formatRelative(date: Date, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - date.getTime());
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${plural(Math.floor(diff / HOUR), 'hour')} ago`;
  if (diff < 30 * DAY) return `${plural(Math.floor(diff / DAY), 'day')} ago`;
  return formatShortDate(date, nowMs);
}

/** "Mar 3", or "Mar 3, 2025" when not in the current year. */
export function formatShortDate(date: Date, nowMs: number = Date.now()): string {
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? null : { year: 'numeric' }),
  }).format(date);
}

/** Full local date-time for `title` tooltips. */
export function formatAbsolute(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** True when the timestamp is within the "active now" window (5 minutes). */
export function isActiveNow(date: Date, nowMs: number = Date.now()): boolean {
  return nowMs - date.getTime() < 5 * MIN;
}
