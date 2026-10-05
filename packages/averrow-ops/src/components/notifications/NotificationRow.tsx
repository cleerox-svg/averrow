// One notification row, shared by the bell panel and the /notifications inbox
// so both surfaces look and behave the same (ACCOUNT_DESIGN_SPEC §5.6).
//
// - >=56px tall, severity dot + sr-only severity text, title 14/600 (2-line
//   clamp), body 13 secondary (2-line clamp), time 12 mono tertiary.
// - Unread = 3px amber left bar + bold title (never colour alone).
// - Actions are never hover-gated. `inline` shows Snooze + Done buttons (inbox);
//   `kebab` folds them into one overflow Menu (bell). Snooze durations come
//   from lib/snooze so both surfaces offer identical choices.

import { Check, Clock, MoreHorizontal } from 'lucide-react';
import { NOTIFICATION_EVENTS } from '@averrow/shared';
import {
  Menu, MenuTrigger, MenuContent, MenuItem, MenuLabel, MenuSeparator,
} from '@averrow/shared/ui';
import type { Notification } from '@/hooks/useNotifications';
import { relativeTime } from '@/lib/time';
import { SNOOZE_OPTIONS } from '@/lib/snooze';

export function typeLabel(type: string): string {
  const def = NOTIFICATION_EVENTS.find((e) => e.key === type);
  return def?.label ?? type.replace(/_/g, ' ');
}

const SEVERITY_TEXT: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

function severityKey(s: string): keyof typeof SEVERITY_TEXT {
  return s in SEVERITY_TEXT ? s : 'info';
}

export type RowActions = 'inline' | 'kebab';

export interface NotificationRowProps {
  notification: Notification;
  onActivate: () => void;
  onSnooze: (hours: number) => void;
  onDone: () => void;
  actions: RowActions;
  /** Show the event-type label under the body (inbox). */
  showType?: boolean;
  /** Show reason + recommended action lines (inbox). */
  showDetail?: boolean;
}

const ICON_BTN =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent text-[var(--text-secondary)] ' +
  'cursor-pointer transition-colors duration-[var(--dur-fast,120ms)] motion-reduce:transition-none ' +
  'hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] hover:text-[var(--text-primary)] ' +
  'data-[state=open]:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]';

function SnoozeItems({ onSnooze }: { onSnooze: (hours: number) => void }) {
  return (
    <>
      <MenuLabel>Snooze for</MenuLabel>
      {SNOOZE_OPTIONS.map((opt) => (
        <MenuItem key={opt.hours} icon={<Clock />} onSelect={() => onSnooze(opt.hours)}>
          {opt.label}
        </MenuItem>
      ))}
    </>
  );
}

export function NotificationRow({
  notification, onActivate, onSnooze, onDone, actions, showType = false, showDetail = false,
}: NotificationRowProps) {
  const isUnread = notification.state === 'unread';
  const isSnoozed = notification.state === 'snoozed';
  const isDone = notification.state === 'done';
  const sev = severityKey(notification.severity);
  const sevLabel = SEVERITY_TEXT[sev];
  const muted = isDone || (!isUnread && isSnoozed);

  return (
    <li
      data-unread={isUnread ? 'true' : 'false'}
      className="relative border-b border-[var(--border-base)] last:border-b-0"
    >
      {isUnread && (
        <span
          aria-hidden="true"
          data-testid="unread-bar"
          className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-[var(--amber)]"
        />
      )}
      <div className="flex items-start">
        <button
          type="button"
          onClick={onActivate}
          className={
            'flex min-h-[56px] min-w-0 flex-1 cursor-pointer items-start gap-3 border-0 bg-transparent py-3 pl-4 pr-2 text-left ' +
            'transition-colors duration-[var(--dur-fast,120ms)] motion-reduce:transition-none ' +
            'hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)] ' +
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]'
          }
        >
          <span className="sr-only">{sevLabel} severity. {isUnread ? 'Unread. ' : ''}</span>
          <span
            aria-hidden="true"
            className="mt-[6px] h-2 w-2 shrink-0 rounded-full"
            style={{ background: `var(--sev-${sev})` }}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-start gap-3">
              <span
                className="line-clamp-2 min-w-0 flex-1 text-[14px] leading-[1.35]"
                style={{
                  color: muted ? 'var(--text-secondary)' : 'var(--text-primary)',
                  fontWeight: isUnread ? 700 : 600,
                }}
              >
                {notification.title}
              </span>
              <span className="shrink-0 pt-px font-mono text-[12px] font-medium text-[var(--text-tertiary)]">
                {relativeTime(notification.created_at)}
              </span>
            </span>
            {notification.message && (
              <span className="mt-0.5 line-clamp-2 block text-[13px] leading-[1.45] text-[var(--text-secondary)]">
                {notification.message}
              </span>
            )}
            {showDetail && notification.reason_text && (
              <span className="mt-1 block text-[13px] italic leading-[1.45] text-[var(--text-tertiary)]">
                {notification.reason_text}
              </span>
            )}
            {showDetail && notification.recommended_action && (
              <span className="mt-1 block text-[13px] font-medium leading-[1.45] text-[var(--amber-text)]">
                {notification.recommended_action}
              </span>
            )}
            {(showType || isSnoozed || isDone) && (
              <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--text-tertiary)]">
                {showType && <span>{typeLabel(notification.type)}</span>}
                {isSnoozed && notification.snoozed_until && (
                  <span className="inline-flex items-center gap-1 text-[var(--sev-medium-text)]">
                    <Clock aria-hidden="true" className="h-3 w-3" />
                    Snoozed until {relativeTime(notification.snoozed_until)}
                  </span>
                )}
                {isDone && <span>Done</span>}
              </span>
            )}
          </span>
        </button>

        {!isDone && actions === 'inline' && (
          <div className="flex shrink-0 items-center pr-1 pt-[6px]">
            {!isSnoozed && (
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className={ICON_BTN} aria-label="Snooze notification" title="Snooze">
                    <Clock aria-hidden="true" className="h-[18px] w-[18px]" />
                  </button>
                </MenuTrigger>
                <MenuContent width={220}>
                  <SnoozeItems onSnooze={onSnooze} />
                </MenuContent>
              </Menu>
            )}
            <button type="button" className={ICON_BTN} onClick={onDone} aria-label="Mark done" title="Mark done">
              <Check aria-hidden="true" className="h-[18px] w-[18px]" />
            </button>
          </div>
        )}

        {!isDone && actions === 'kebab' && (
          <div className="flex shrink-0 items-center pr-1 pt-[6px]">
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className={ICON_BTN} aria-label="Notification actions" title="Actions">
                  <MoreHorizontal aria-hidden="true" className="h-[18px] w-[18px]" />
                </button>
              </MenuTrigger>
              <MenuContent width={220}>
                {!isSnoozed && (
                  <>
                    <SnoozeItems onSnooze={onSnooze} />
                    <MenuSeparator />
                  </>
                )}
                <MenuItem icon={<Check />} onSelect={onDone}>Mark done</MenuItem>
              </MenuContent>
            </Menu>
          </div>
        )}
      </div>
    </li>
  );
}

/** Sticky day heading used by both surfaces. Token background keeps it light-theme safe. */
export function DayHeading({ label, id }: { label: string; id: string }) {
  return (
    <h3
      id={id}
      className="sticky top-0 z-[1] m-0 border-b border-[var(--border-base)] bg-[var(--bg-sticky-deep)] px-4 py-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] backdrop-blur-sm"
    >
      {label}
    </h3>
  );
}

/** Five row-shaped placeholders (final row height, so nothing shifts on load). */
export function NotificationRowSkeletons({ count = 5 }: { count?: number }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading notifications…</span>
      <ul className="m-0 list-none p-0" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <li
            key={i}
            className="flex min-h-[72px] animate-pulse items-start gap-3 border-b border-[var(--border-base)] px-4 py-3 last:border-b-0 motion-reduce:animate-none"
          >
            <span className="mt-[6px] h-2 w-2 shrink-0 rounded-full bg-[var(--border-strong)]" />
            <span className="flex-1">
              <span className="block h-3.5 w-3/5 rounded bg-[var(--border-strong)]" />
              <span className="mt-2 block h-3 w-4/5 rounded bg-[var(--border-base)]" />
            </span>
            <span className="h-3 w-10 rounded bg-[var(--border-base)]" />
          </li>
        ))}
      </ul>
    </div>
  );
}
