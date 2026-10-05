// The single date/time formatting module for the account pages (Security,
// Devices, Profile). Pure, no I/O. (ops has lib/time.ts, but the shared package
// cannot import from an app.) User-agent parsing lives in security/userAgent.ts.

// D1's datetime('now') emits "YYYY-MM-DD HH:MM:SS" — UTC with no zone marker,
// which `new Date()` would read as LOCAL time. The "T" form without a zone
// ("2026-10-04T12:00:00") is read the same way by browsers; normalise both.
const BARE_SQLITE_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** Parse a worker timestamp as UTC when it carries no zone. May return an Invalid Date. */
export function parseTimestamp(value: string | number | Date): Date {
  if (typeof value !== 'string') return new Date(value);
  const trimmed = value.trim();
  return BARE_SQLITE_TS.test(trimmed) ? new Date(`${trimmed.replace(' ', 'T')}Z`) : new Date(trimmed);
}

/** Like parseTimestamp, but null for empty / unparseable input. */
export function toValidDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = parseTimestamp(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type DateInput = string | number | Date | null | undefined;
type NowInput = number | Date;
const nowMs = (now: NowInput): number => (now instanceof Date ? now.getTime() : now);

/** "Sep 28" (same year) or "Sep 28, 2025". Empty string for an unparseable value. */
export function formatShortDate(value: DateInput, now: NowInput = Date.now()): string {
  const d = toValidDate(value);
  if (!d) return '';
  const sameYear = d.getFullYear() === new Date(nowMs(now)).getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Mar 3, 2025" — full date for facts like "Member since". */
export function formatFullDate(value: DateInput): string {
  const d = toValidDate(value);
  if (!d) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Full local date-time for `title` tooltips. Empty string for an unparseable value. */
export function formatAbsolute(value: DateInput): string {
  const d = toValidDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "just now", "5 min ago", "3 hours ago", "2 days ago", then a short date. Empty string for an unparseable value. */
export function formatRelativeTime(value: DateInput, now: NowInput = Date.now()): string {
  const d = toValidDate(value);
  if (!d) return '';
  const n = nowMs(now);
  const diff = Math.max(0, n - d.getTime());
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${plural(Math.floor(diff / HOUR), 'hour')} ago`;
  if (diff < 30 * DAY) return `${plural(Math.floor(diff / DAY), 'day')} ago`;
  return formatShortDate(d, n);
}

/** True when the timestamp is within the "active now" window (5 minutes). */
export function isActiveNow(value: DateInput, now: NowInput = Date.now()): boolean {
  const d = toValidDate(value);
  return d ? nowMs(now) - d.getTime() < 5 * MIN : false;
}
