// One notification row (ACCOUNT_DESIGN_SPEC §5.6), shared by the bell panel and
// any full inbox so both surfaces look and behave the same.
//
// - >=56px tall, severity dot + sr-only severity text, title 14/600 (2-line
//   clamp), body 13 secondary (2-line clamp), time 12 mono tertiary.
// - Unread = 3px primary left bar + bold title (never colour alone).
// - Actions are never hover-gated and entirely optional: `inline` shows Snooze +
//   Done buttons, `kebab` folds them into one overflow menu, `none` (default)
//   renders no actions. Snooze needs `onSnooze` + `snoozeOptions`; Done needs
//   `onDone`.

import type { ReactNode } from 'react';
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuLabel, MenuSeparator } from '../overlays/Menu';
import { ShellCheckIcon, ShellClockIcon, ShellMoreIcon } from './icons';
import { isFuture, relativeTime, relativeTimeSigned } from './time';

/** The minimal shape the kit needs from an app's notification record. */
export interface ShellNotification {
  id: string;
  title: string;
  message?: string | null;
  /** critical | high | medium | low | info (anything else renders as info). */
  severity: string;
  /** unread | read | snoozed | done. */
  state: string;
  created_at: string;
  snoozed_until?: string | null;
  reason_text?: string | null;
  recommended_action?: string | null;
}

export interface SnoozeOption {
  hours: number;
  label: string;
}

export type RowActions = 'inline' | 'kebab' | 'none';

const SEVERITY_TEXT: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

function severityKey(s: string): string {
  return s in SEVERITY_TEXT ? s : 'info';
}

export interface NotificationRowProps {
  notification: ShellNotification;
  onActivate: () => void;
  /** Snooze for N hours. Omit (or omit `snoozeOptions`) to hide Snooze. */
  onSnooze?: (hours: number) => void;
  snoozeOptions?: readonly SnoozeOption[];
  /** Mark done. Omit to hide Done. */
  onDone?: () => void;
  actions?: RowActions;
  /** Show `typeLabel` under the body (inbox). */
  showType?: boolean;
  typeLabel?: ReactNode;
  /** Show reason + recommended action lines (inbox). */
  showDetail?: boolean;
  className?: string;
  'data-testid'?: string;
}

const ICON_BTN =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent text-[var(--text-secondary)] ' +
  'cursor-pointer transition-colors duration-[var(--dur-fast,120ms)] motion-reduce:transition-none ' +
  'hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] hover:text-[var(--text-primary)] ' +
  'data-[state=open]:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]';

function SnoozeItems({ options, onSnooze }: { options: readonly SnoozeOption[]; onSnooze: (hours: number) => void }) {
  return (
    <>
      <MenuLabel>Snooze for</MenuLabel>
      {options.map((opt) => (
        <MenuItem key={opt.hours} icon={<ShellClockIcon />} onSelect={() => onSnooze(opt.hours)}>
          {opt.label}
        </MenuItem>
      ))}
    </>
  );
}

export function NotificationRow({
  notification, onActivate, onSnooze, snoozeOptions, onDone, actions = 'none',
  showType = false, typeLabel, showDetail = false, className, 'data-testid': testId,
}: NotificationRowProps) {
  const isUnread = notification.state === 'unread';
  const isSnoozed = notification.state === 'snoozed';
  const isDone = notification.state === 'done';
  const sev = severityKey(notification.severity);
  const sevLabel = SEVERITY_TEXT[sev];
  const muted = isDone || (!isUnread && isSnoozed);
  const canSnooze = !!onSnooze && !!snoozeOptions && snoozeOptions.length > 0;
  const canDone = !!onDone;
  const hasActions = !isDone && (canSnooze || canDone);

  return (
    <li
      data-unread={isUnread ? 'true' : 'false'}
      data-testid={testId}
      className={`relative border-b border-[var(--border-base)] last:border-b-0${className ? ` ${className}` : ''}`}
    >
      {isUnread && (
        <span
          aria-hidden="true"
          data-testid="unread-bar"
          className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-[var(--primary)]"
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
              <span className="mt-1 block text-[13px] font-medium leading-[1.45] text-[var(--primary-text)]">
                {notification.recommended_action}
              </span>
            )}
            {((showType && typeLabel) || isSnoozed || isDone) && (
              <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--text-tertiary)]">
                {showType && typeLabel ? <span>{typeLabel}</span> : null}
                {isSnoozed && notification.snoozed_until && (
                  <span className="inline-flex items-center gap-1 text-[var(--sev-medium-text)]">
                    <ShellClockIcon aria-hidden="true" className="h-3 w-3" />
                    {isFuture(notification.snoozed_until)
                      ? `Snoozed · back ${relativeTimeSigned(notification.snoozed_until)}`
                      : 'Snooze ended'}
                  </span>
                )}
                {isDone && <span>Done</span>}
              </span>
            )}
          </span>
        </button>

        {hasActions && actions === 'inline' && (
          <div className="flex shrink-0 items-center pr-1 pt-[6px]">
            {canSnooze && !isSnoozed && (
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className={ICON_BTN} aria-label="Snooze notification" title="Snooze">
                    <ShellClockIcon aria-hidden="true" className="h-[18px] w-[18px]" />
                  </button>
                </MenuTrigger>
                <MenuContent width={220}>
                  <SnoozeItems options={snoozeOptions} onSnooze={onSnooze} />
                </MenuContent>
              </Menu>
            )}
            {canDone && (
              <button type="button" className={ICON_BTN} onClick={onDone} aria-label="Mark done" title="Mark done">
                <ShellCheckIcon aria-hidden="true" className="h-[18px] w-[18px]" />
              </button>
            )}
          </div>
        )}

        {hasActions && actions === 'kebab' && (
          <div className="flex shrink-0 items-center pr-1 pt-[6px]">
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className={ICON_BTN} aria-label="Notification actions" title="Actions">
                  <ShellMoreIcon aria-hidden="true" className="h-[18px] w-[18px]" />
                </button>
              </MenuTrigger>
              <MenuContent width={220}>
                {canSnooze && !isSnoozed && (
                  <>
                    <SnoozeItems options={snoozeOptions} onSnooze={onSnooze} />
                    {canDone ? <MenuSeparator /> : null}
                  </>
                )}
                {canDone ? <MenuItem icon={<ShellCheckIcon />} onSelect={onDone}>Mark done</MenuItem> : null}
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
      className="sticky top-0 z-[1] m-0 border-b border-[var(--border-base)] bg-[var(--bg-elevated-solid)] px-4 py-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]"
    >
      {label}
    </h3>
  );
}

/** Row-shaped placeholders (final row height, so nothing shifts on load). */
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
