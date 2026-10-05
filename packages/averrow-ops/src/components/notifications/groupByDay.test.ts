import { describe, it, expect } from 'vitest';
import type { Notification } from '@/hooks/useNotifications';
import { groupByDay, dayLabel } from './groupByDay';

const NOW = new Date(2026, 9, 5, 15, 0, 0); // local Oct 5 2026, 15:00

function n(id: string, d: Date): Notification {
  return { id, created_at: d.toISOString() } as Notification;
}

describe('groupByDay', () => {
  it('labels Today, Yesterday and older dates, preserving order', () => {
    const groups = groupByDay(
      [
        n('a', new Date(2026, 9, 5, 14, 0)),
        n('b', new Date(2026, 9, 5, 1, 0)),
        n('c', new Date(2026, 9, 4, 23, 0)),
        n('d', new Date(2026, 9, 1, 9, 0)),
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', expect.stringContaining('Oct')]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(['d']);
  });

  it('adds the year for dates in another year', () => {
    expect(dayLabel(new Date(2025, 11, 31, 12).toISOString(), NOW).label).toContain('2025');
  });

  it('puts unparseable dates under Earlier', () => {
    expect(dayLabel('not a date', NOW)).toEqual({ key: 'unknown', label: 'Earlier' });
  });
});
