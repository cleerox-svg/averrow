// "Push on this device · Email on · Quiet hours 22:00–07:00" — the at-a-glance
// state of the three things people most often wonder about.

import type { ReactElement } from 'react';
import { Card } from '../../ui';
import { hasQuietWindow } from './helpers';
import type { NotificationPrefsV2, PushState } from './types';

export function summarizeNotifications(prefs: NotificationPrefsV2, push: PushState): Array<{ id: string; text: string; on: boolean }> {
  const pushOn = push.subscribed && prefs.push_severity_floor !== 'off';
  const pushText = !push.supported ? 'Push not available'
    : push.permission === 'denied' ? 'Push blocked'
    : push.subscribed ? (prefs.push_severity_floor === 'off' ? 'Push paused' : 'Push on this device')
    : 'Push off on this device';
  const emailOn = prefs.email_severity_floor !== 'off';
  const quietOn = hasQuietWindow(prefs);
  return [
    { id: 'push', text: pushText, on: pushOn },
    { id: 'email', text: emailOn ? 'Email on' : 'Email off', on: emailOn },
    {
      id: 'quiet',
      text: quietOn ? `Quiet hours ${prefs.quiet_hours_start}–${prefs.quiet_hours_end}` : 'Quiet hours off',
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
              style={{ background: i.on ? 'var(--green)' : 'var(--text-muted)' }}
            />
            <span className={i.on ? 'font-semibold text-[var(--text-primary)]' : undefined}>{i.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
