// parseUtc / relative-time helpers live in the shared kit (single source, also
// used by FarmTrack); re-exported so ops imports are unchanged.
import { parseUtc, relativeMagnitude, relativeTime, relativeTimeSigned, isFuture } from '@averrow/shared/ui';
export { parseUtc, relativeMagnitude, relativeTime, relativeTimeSigned, isFuture };

/** Compact span: "3d 4h" / "5h 12m" / "38m". */
export function formatSpan(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
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
