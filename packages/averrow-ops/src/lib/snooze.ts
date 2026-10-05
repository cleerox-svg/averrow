// Snooze choices for notifications. The bell and the inbox page both read
// this list so they can never offer different durations.

export interface SnoozeOption {
  hours: number;
  /** Menu label, sentence case ("1 hour"). */
  label: string;
}

export const SNOOZE_OPTIONS: readonly SnoozeOption[] = [
  { hours: 1, label: '1 hour' },
  { hours: 4, label: '4 hours' },
  { hours: 24, label: '1 day' },
  { hours: 168, label: '1 week' },
] as const;

/** ISO timestamp `hours` from `now` (ms epoch, injectable for tests). */
export function snoozeUntilIso(hours: number, now: number = Date.now()): string {
  return new Date(now + hours * 60 * 60 * 1000).toISOString();
}
