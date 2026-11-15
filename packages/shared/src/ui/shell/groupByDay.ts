// Group a newest-first notification list into local-calendar-day sections
// (Today / Yesterday / "Mon, Oct 3"), preserving order.

import { parseUtc } from './time';
import type { ShellNotification } from './NotificationRow';

export interface DayGroup<T extends { created_at: string } = ShellNotification> {
  key: string;
  label: string;
  items: T[];
}

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dayLabel(iso: string, now: Date = new Date()): { key: string; label: string } {
  const d = parseUtc(iso);
  if (Number.isNaN(d.getTime())) return { key: 'unknown', label: 'Earlier' };
  const start = dayStart(d);
  const today = dayStart(now);
  const key = String(start);
  if (start === today) return { key, label: 'Today' };
  // Rounded so a DST shift (23h/25h day) still counts as one calendar day.
  const diffDays = Math.round((today - start) / 86_400_000);
  if (diffDays === 1) return { key, label: 'Yesterday' };
  const label = d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  });
  return { key, label };
}

export function groupByDay<T extends { created_at: string }>(
  items: readonly T[],
  now: Date = new Date(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  const index = new Map<string, DayGroup<T>>();
  for (const n of items) {
    const { key, label } = dayLabel(n.created_at, now);
    let g = index.get(key);
    if (!g) {
      g = { key, label, items: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.items.push(n);
  }
  return groups;
}
