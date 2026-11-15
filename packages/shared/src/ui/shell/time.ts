// Time helpers for the shell notification surfaces. Copy of the ops
// `lib/time` behaviour the bell needs (the kit cannot import app code).

// D1's datetime('now') emits "YYYY-MM-DD HH:MM:SS": UTC with no zone marker, so
// `new Date(...)` would read it as local time. Normalise that bare shape to UTC;
// timestamps that already carry a zone pass through.
const BARE_SQLITE_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export function parseUtc(date: string | Date | number): Date {
  if (typeof date !== 'string') return new Date(date);
  const trimmed = date.trim();
  if (BARE_SQLITE_TS.test(trimmed)) return new Date(trimmed.replace(' ', 'T') + 'Z');
  return new Date(trimmed);
}

export function relativeMagnitude(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Past-only relative time: "5m ago". A future timestamp reads "just now". */
export function relativeTime(date: string | null): string {
  if (!date) return 'Never';
  const seconds = Math.floor((Date.now() - parseUtc(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  return `${relativeMagnitude(seconds)} ago`;
}

/** Signed relative time: past "5m ago", future "in 5m"; within a minute "just now". */
export function relativeTimeSigned(date: string | null): string {
  if (!date) return 'Never';
  const ms = Date.now() - parseUtc(date).getTime();
  if (ms >= 0) return relativeTime(date);
  const ahead = -ms;
  if (ahead < 60_000) return 'just now';
  return `in ${relativeMagnitude(Math.ceil(ahead / 60_000) * 60)}`;
}

export function isFuture(date: string | null): boolean {
  return !!date && parseUtc(date).getTime() > Date.now();
}
