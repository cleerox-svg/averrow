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

export function relativeTime(date: string | null): string {
  if (!date) return 'Never';
  const ms = Date.now() - parseUtc(date).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
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
