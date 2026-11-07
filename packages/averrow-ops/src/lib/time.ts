// D1's datetime('now') emits "YYYY-MM-DD HH:MM:SS" — UTC, but with no
// timezone marker, so `new Date(...)` parses it as LOCAL time and every
// relative/absolute render drifts by the viewer's UTC offset. Normalize
// that bare shape to an explicit UTC ISO string; timestamps that already
// carry a zone (Z or ±hh:mm) pass through untouched. Exported so pages
// never need to hand-roll their own "+ 'Z'" fixups again.
const BARE_SQLITE_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export function parseUtc(date: string | Date | number): Date {
  if (typeof date !== 'string') return new Date(date);
  const trimmed = date.trim();
  if (BARE_SQLITE_TS.test(trimmed)) {
    return new Date(trimmed.replace(' ', 'T') + 'Z');
  }
  return new Date(trimmed);
}

/** Compact span: "3d 4h" / "5h 12m" / "38m". */
export function formatSpan(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Unsigned magnitude for relativeTime: "5m" / "3h" / "2d" / "4mo" / "1y". */
function relativeMagnitude(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * Past-only relative time: "5m ago" / "3h ago". A future timestamp (client
 * clock behind the server) reads "just now". Use for history ("created",
 * "last run"); for expiries / snoozes / mutes use relativeTimeSigned.
 */
export function relativeTime(date: string | null): string {
  if (!date) return 'Never';
  const ms = Date.now() - parseUtc(date).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  return `${relativeMagnitude(seconds)} ago`;
}

/**
 * Signed relative time for timestamps that may be in the future: past →
 * "5m ago" (same as relativeTime), future → "in 5m" / "in 3h" / "in 2d".
 * Within a minute either side reads "just now". Future values round up to
 * the minute so a fresh 7-day expiry reads "in 7d", not "in 6d".
 */
export function relativeTimeSigned(date: string | null): string {
  if (!date) return 'Never';
  const ms = Date.now() - parseUtc(date).getTime();
  if (ms >= 0) return relativeTime(date);
  const ahead = -ms;
  if (ahead < 60_000) return 'just now';
  return `in ${relativeMagnitude(Math.ceil(ahead / 60_000) * 60)}`;
}

/** True when `date` is strictly in the future. */
export function isFuture(date: string | null): boolean {
  return !!date && parseUtc(date).getTime() > Date.now();
}

export function timeAgo(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const diff = Date.now() - parseUtc(dateStr).getTime();
  if (diff < 0) return 'today';
  const days = Math.floor(diff / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function formatDuration(ms: number | null): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${((ms ?? 0) / 1000).toFixed(1)}s`;
}

// ── Canonical date formats ─────────────────────────────────────────────────
// The UI audit (M5) flagged date-format drift across Home, incident detail,
// audit log, and briefings. Use these helpers instead of inline
// toLocaleDateString / new Date().toString() / etc.
//
//   formatDate('long')   → "Wednesday, May 7, 2026"   (Home greeting band)
//   formatDate('medium') → "May 7, 2026"              (audit log, incident headers)
//   formatDate('short')  → "May 7"                    (briefings, compact rows)
//   formatDate('iso')    → "2026-05-07"               (download filenames, tooltips)
//   formatDateTime()     → "May 7, 2026 · 14:32"     (incident events, agent runs)

type DateFormat = 'long' | 'medium' | 'short' | 'iso';

export function formatDate(
  date: Date | string | number | null | undefined,
  format: DateFormat = 'medium',
): string {
  if (date === null || date === undefined) return '—';
  const d = typeof date === 'string' || typeof date === 'number' ? parseUtc(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  switch (format) {
    case 'long':
      return d.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      });
    case 'medium':
      return d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    case 'short':
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    case 'iso':
      return d.toISOString().slice(0, 10);
  }
}

export function formatDateTime(date: Date | string | number | null | undefined): string {
  if (date === null || date === undefined) return '—';
  const d = typeof date === 'string' || typeof date === 'number' ? parseUtc(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  const datePart = d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const timePart = d.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${datePart} · ${timePart}`;
}
