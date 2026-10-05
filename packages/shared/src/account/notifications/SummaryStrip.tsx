// "Push on this device · Email on · Quiet hours 22:00–07:00" — the at-a-glance
// state of the three things people most often wonder about.

import type { ReactElement } from 'react';
import { Card } from '../../ui';
import { hasQuietWindow } from './helpers';
import type { NotificationPrefsV2, PushState } from './types';

/** "22:00" -> "10:00 PM" / "22:00", in the same locale the time inputs render in. */
export function formatClockTime(hhmm: string | null | undefined, locale?: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  if (!m) return hhmm ?? '';
  const d = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
  try {
    const is12h = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12;
    // 24h locales pad the hour ("07:05") like the browser's time input does.
    return new Intl.DateTimeFormat(locale, { hour: is12h ? 'numeric' : '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return hhmm ?? '';
  }
}

export type PushSummaryState = 'unsupported' | 'blocked' | 'paused' | 'on' | 'off';

/**
 * The push state the strip (and Channels) agree on. Only a SUBSCRIBED device
 * with GRANTED permission is ever "on": a denied permission (even with a stale
 * subscription) is blocked, and an unsupported browser is unsupported.
 */
export function pushSummaryState(prefs: Pick<NotificationPrefsV2, 'push_severity_floor'>, push: PushState): PushSummaryState {
  if (!push.supported || push.permission === 'unsupported') return 'unsupported';
  if (push.permission === 'denied') return 'blocked';
  if (!push.subscribed || push.permission !== 'granted') return 'off';
  return prefs.push_severity_floor === 'off' ? 'paused' : 'on';
}

export function summarizeNotifications(prefs: NotificationPrefsV2, push: PushState): Array<{ id: string; text: string; on: boolean; warn?: boolean }> {
  const pushState = pushSummaryState(prefs, push);
  const pushText = pushState === 'unsupported' ? 'Push not available'
    : pushState === 'blocked' ? 'Push blocked'
    : pushState === 'paused' ? 'Push paused'
    : pushState === 'on' ? 'Push on this device'
    : 'Push off on this device';
  const emailOn = prefs.email_severity_floor !== 'off';
  const quietOn = hasQuietWindow(prefs);
  return [
    { id: 'push', text: pushText, on: pushState === 'on', warn: pushState === 'blocked' },
    { id: 'email', text: emailOn ? 'Email on' : 'Email off', on: emailOn },
    {
      id: 'quiet',
      text: quietOn
        ? `Quiet hours ${formatClockTime(prefs.quiet_hours_start)}\u2013${formatClockTime(prefs.quiet_hours_end)}`
        : 'Quiet hours off',
      on: quietOn,
    },
  ];
}

export function SummaryStrip({ prefs, push }: { prefs: NotificationPrefsV2; push: PushState }): ReactElement {
  const items = summarizeNotifications(prefs, push);
  return (
    <Card variant="flat" padding="sm" aria-label="Notification summary" role="group">
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0 text-[14px]">
        {items.map((i) => (
          <li key={i.id} className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: i.on ? 'var(--green)' : i.warn ? 'var(--amber)' : 'var(--text-muted)' }}
            />
            <span className={i.on ? 'font-semibold text-[var(--text-primary)]' : undefined}>{i.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
