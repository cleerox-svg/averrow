// Small date/UA formatting helpers for the account pages. Pure, no I/O.
// (ops has lib/time.ts, but the shared package cannot import from an app.)

// D1's datetime('now') emits "YYYY-MM-DD HH:MM:SS" — UTC with no zone marker,
// which `new Date()` would read as LOCAL time. Normalise that shape to UTC.
const BARE_SQLITE_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export function parseTimestamp(value: string | number | Date): Date {
  if (typeof value !== 'string') return new Date(value);
  const trimmed = value.trim();
  return BARE_SQLITE_TS.test(trimmed) ? new Date(`${trimmed.replace(' ', 'T')}Z`) : new Date(trimmed);
}

/** "Sep 28" (same year) or "Sep 28, 2025". Empty string for an unparseable value. */
export function formatShortDate(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return '';
  const d = parseTimestamp(value);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Mar 3, 2025" — full date for facts like "Member since". */
export function formatFullDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = parseTimestamp(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "2 h ago", "3 days ago", "just now". Empty string for an unparseable value. */
export function formatRelativeTime(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '';
  const t = parseTimestamp(value).getTime();
  if (Number.isNaN(t)) return '';
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`;
  const months = Math.floor(days / 30);
  if (days < 365) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

export interface ParsedDevice {
  browser: string | null;
  os: string | null;
  /** Coarse class for picking a glyph. */
  kind: 'phone' | 'tablet' | 'desktop';
}

/** Best-effort browser / OS / form factor from a user-agent string. Never throws. */
export function describeUserAgent(ua: string | null | undefined): ParsedDevice {
  const s = ua ?? '';
  let os: string | null = null;
  if (/iPhone/.test(s)) os = 'iPhone';
  else if (/iPad/.test(s)) os = 'iPad';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';

  let browser: string | null = null;
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/.test(s)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/.test(s)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';

  const kind: ParsedDevice['kind'] =
    os === 'iPad' ? 'tablet'
      : os === 'iPhone' || (os === 'Android' && /Mobile/.test(s)) ? 'phone'
        : os === 'Android' ? 'tablet'
          : 'desktop';
  return { browser, os, kind };
}
