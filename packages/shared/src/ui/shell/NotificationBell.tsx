// NotificationBell: the shell notification entry point (ACCOUNT_DESIGN_SPEC
// §5.6), as a props-driven frame. The app owns data and mutations; the kit owns
// the look, the open/close behaviour and the a11y.
//
//   Trigger   44x44, count Badge (red only while an unread critical exists,
//             otherwise amber), 99+ cap, polite live region for new arrivals.
//   Desktop   ~400px popover (elevated card) anchored under the bell.
//   Compact   full-height Sheet with a top bar (title, Mark all read,
//             settings, close).
//   Panel     All | Unread filter, optional banner slot, day-grouped rows,
//             pinned footer links, loading / error / empty states.
//
// Optional per-row actions (snooze / done) and the banner slot are what an app
// like ops adds on top; an app that only lists and opens notifications omits
// them. No router: footer links render through `renderLink`.

import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type MouseEvent,
} from 'react';
import { cn } from '../cn';
import { Badge } from '../Badge';
import { Card } from '../Card';
import { PageState } from '../PageState';
import { SegmentedControl } from '../forms/SegmentedControl';
import { Sheet, SheetClose, SheetContent } from '../overlays/Sheet';
import { useIsCompact } from '../overlays/useMediaQuery';
import { groupByDay } from './groupByDay';
import { ShellBellIcon, ShellCloseIcon, ShellSettingsIcon } from './icons';
import {
  DayHeading, NotificationRow, NotificationRowSkeletons,
  type RowActions, type ShellNotification, type SnoozeOption,
} from './NotificationRow';

type FilterKey = 'all' | 'unread';

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
];

const ANNOUNCE_DEBOUNCE_MS = 2000;
// The panel's visible heading names the Sheet / popover dialog (one heading).
const PANEL_TITLE_ID = 'bell-panel-title';

const ICON_LINK =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-[var(--text-secondary)] no-underline ' +
  'transition-colors duration-[var(--dur-fast,120ms)] motion-reduce:transition-none ' +
  'hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] hover:text-[var(--text-primary)] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]';

const TEXT_LINK =
  'inline-flex min-h-[44px] items-center rounded-[10px] px-2 text-[13px] font-semibold no-underline ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]';

/** What `renderLink` receives (a router `<Link>` in apps that have one). */
export interface ShellLinkRenderProps {
  href: string;
  className: string;
  children: ReactNode;
  'aria-label'?: string;
  title?: string;
  /** Must be forwarded: it closes the panel. */
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  'data-testid'?: string;
}

export type ShellRenderLink = (props: ShellLinkRenderProps) => ReactElement;

const defaultRenderLink: ShellRenderLink = (p) => (
  <a
    href={p.href}
    className={p.className}
    aria-label={p['aria-label']}
    title={p.title}
    onClick={p.onClick}
    data-testid={p['data-testid']}
  >
    {p.children}
  </a>
);

export interface NotificationBellFooterLink {
  key: string;
  label: string;
  href: string;
  /** `primary` (default for the first link) or `secondary`. */
  tone?: 'primary' | 'secondary';
  'data-testid'?: string;
}

export interface NotificationBellPanelContext {
  /** Close the popover / sheet (and reset the filter). */
  close: () => void;
}

export interface NotificationBellProps<T extends ShellNotification> {
  /** Newest first. */
  items: readonly T[];
  /** Badge count. `undefined` until the first response (no announcement before then). */
  unreadCount: number | undefined;
  /** Header "N unread" line and the Mark-all-read enabled state. Defaults to `unreadCount`. */
  panelUnreadCount?: number;
  /** An unread critical exists: the badge turns red instead of amber. */
  hasCritical?: boolean;
  /** Show the skeleton (first load, nothing to show yet). */
  loading?: boolean;
  error?: boolean;
  /** An error happened but a previous list is still shown ("Showing the last loaded list."). */
  errorHasStaleData?: boolean;
  onRetry?: () => void;
  onMarkAllRead: () => void;
  /** Row tapped. Call `close()` when the tap navigates away. */
  onActivate: (item: T, ctx: NotificationBellPanelContext) => void;
  /** Optional row actions. Snooze needs `onSnooze` + `snoozeOptions`; Done needs `onDone`. */
  onSnooze?: (item: T, hours: number) => void;
  snoozeOptions?: readonly SnoozeOption[];
  onDone?: (item: T) => void;
  /** Default `kebab` when a handler is supplied, else `none`. */
  rowActions?: RowActions;
  /** Slot between the header and the list (e.g. an alert-triage row). */
  renderBanner?: (ctx: NotificationBellPanelContext) => ReactNode;
  /** Pinned footer links (first is the primary one by default). */
  footerLinks?: readonly NotificationBellFooterLink[];
  /** Sheet top-bar settings icon link target. Omit to hide it. */
  settingsHref?: string;
  settingsLabel?: string;
  /** Router-aware link renderer for the footer + settings links. Default: plain anchors. */
  renderLink?: ShellRenderLink;
  /** Force compact (Sheet) presentation. Default: the kit's compact media query. */
  compact?: boolean;
  /** Trigger glyph. Default: the kit's bell. */
  icon?: ReactNode;
  /** Settings / close glyphs for the sheet top bar. */
  settingsIcon?: ReactNode;
  closeIcon?: ReactNode;
  /** Empty-state glyph. Default: the kit's bell. */
  emptyIcon?: ReactNode;
  /** Merged onto the trigger button (restyle for an always-dark bar). */
  triggerClassName?: string;
  triggerTestId?: string;
  /** Test id of the count badge wrapper. Default `bell-count`. */
  countTestId?: string;
  /** Test id of the panel root (popover card / sheet body content). */
  'data-testid'?: string;
  /** Test id on each row. */
  rowTestId?: string;
  /** Wrapper class (the wrapper is `relative`). */
  className?: string;
  /** Fires when the panel opens or closes, so an app can fetch the list lazily. */
  onOpenChange?: (open: boolean) => void;
}

// ─── Panel ────────────────────────────────────────────────────────

interface PanelProps<T extends ShellNotification> extends NotificationBellProps<T> {
  onClose: () => void;
  filter: FilterKey;
  setFilter: (f: FilterKey) => void;
  variant: 'popover' | 'sheet';
}

function NotificationPanel<T extends ShellNotification>({
  onClose, filter, setFilter, variant, items, unreadCount, panelUnreadCount, loading, error, errorHasStaleData,
  onRetry, onMarkAllRead, onActivate, onSnooze, snoozeOptions, onDone, rowActions, renderBanner,
  footerLinks, settingsHref, 'data-testid': panelTestId, settingsLabel = 'Notification settings', renderLink = defaultRenderLink,
  settingsIcon, closeIcon, emptyIcon, rowTestId,
}: PanelProps<T>) {
  const headerUnread = panelUnreadCount ?? unreadCount ?? 0;
  const visible = useMemo(
    () => (filter === 'unread' ? items.filter((n) => n.state === 'unread') : items),
    [items, filter],
  );
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const isSheet = variant === 'sheet';
  const hasActions = !!onSnooze || !!onDone;
  const actions: RowActions = rowActions ?? (hasActions ? 'kebab' : 'none');
  const staleData = !!errorHasStaleData;

  return (
    <div data-testid={panelTestId} className="flex min-h-full flex-col">
      {/* Header: pinned while the list scrolls */}
      <div
        className="sticky top-0 z-[2] border-b border-[var(--border-base)] bg-[var(--bg-elevated-solid)]"
        style={isSheet ? { paddingTop: 'env(safe-area-inset-top, 0px)' } : undefined}
      >
        <div className="flex items-center gap-1 py-1 pl-4 pr-1.5">
          <div className="min-w-0 flex-1">
            <h2 id={PANEL_TITLE_ID} className="m-0 text-[16px] font-bold leading-tight tracking-[-0.2px] text-[var(--text-primary)]">
              Notifications
            </h2>
            {headerUnread > 0 && (
              <p className="m-0 font-mono text-[12px] text-[var(--text-tertiary)]">{headerUnread} unread</p>
            )}
          </div>
          <button
            type="button"
            onClick={onMarkAllRead}
            disabled={headerUnread === 0}
            className={`${TEXT_LINK} cursor-pointer border-0 bg-transparent text-[var(--primary-text)] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] disabled:cursor-not-allowed disabled:text-[var(--text-tertiary)] disabled:hover:bg-transparent`}
          >
            Mark all read
          </button>
          {isSheet && settingsHref
            ? renderLink({
              href: settingsHref,
              className: ICON_LINK,
              onClick: onClose,
              'aria-label': settingsLabel,
              title: settingsLabel,
              children: settingsIcon ?? <ShellSettingsIcon aria-hidden="true" className="h-[18px] w-[18px]" />,
            })
            : null}
          {isSheet && (
            <SheetClose asChild>
              <button
                type="button"
                aria-label="Close notifications"
                className={`${ICON_LINK} cursor-pointer border-0 bg-transparent`}
              >
                {closeIcon ?? <ShellCloseIcon aria-hidden="true" className="h-5 w-5" />}
              </button>
            </SheetClose>
          )}
        </div>
        <div className="px-4 pb-3 pt-1">
          <SegmentedControl
            aria-label="Show notifications"
            fullWidth
            options={FILTER_OPTIONS}
            value={filter}
            onValueChange={(v) => setFilter(v as FilterKey)}
          />
        </div>
      </div>

      {renderBanner?.({ close: onClose })}

      {/* Body */}
      <div className="flex-1">
        {error && (
          <div className="px-4 pt-3">
            <PageState
              kind="error"
              layout="inline"
              compact
              assertive={!staleData}
              title="Couldn't load notifications"
              description={staleData ? 'Showing the last loaded list.' : 'Check your connection and try again.'}
              onRetry={onRetry}
            />
          </div>
        )}
        {loading ? (
          <NotificationRowSkeletons />
        ) : visible.length === 0 ? (
          !(error && !staleData) && (
            <PageState
              kind="clear"
              layout="page"
              compact
              icon={emptyIcon ?? <ShellBellIcon />}
              title={filter === 'unread' && items.length > 0 ? 'No unread notifications' : "You're all caught up"}
              description="New notifications will show up here."
            />
          )
        ) : (
          groups.map((day) => (
            <section key={day.key} aria-labelledby={`bell-day-${day.key}`}>
              <DayHeading id={`bell-day-${day.key}`} label={day.label} />
              <ul className="m-0 list-none p-0">
                {day.items.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    actions={actions}
                    data-testid={rowTestId}
                    onActivate={() => onActivate(n, { close: onClose })}
                    snoozeOptions={snoozeOptions}
                    onSnooze={onSnooze ? (hours) => onSnooze(n, hours) : undefined}
                    onDone={onDone ? () => onDone(n) : undefined}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {/* Footer: pinned */}
      {footerLinks && footerLinks.length > 0 ? (
        <div
          className="sticky bottom-0 z-[2] flex items-center justify-between gap-2 border-t border-[var(--border-base)] bg-[var(--bg-elevated-solid)] px-2"
          style={isSheet ? { paddingBottom: 'env(safe-area-inset-bottom, 0px)' } : undefined}
        >
          {footerLinks.map((link, i) => {
            const primary = (link.tone ?? (i === 0 ? 'primary' : 'secondary')) === 'primary';
            return (
              <span key={link.key} className="contents">
                {renderLink({
                  href: link.href,
                  onClick: onClose,
                  'data-testid': link['data-testid'],
                  className: `${TEXT_LINK} ${primary
                    ? 'text-[var(--primary-text)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`,
                  children: link.label,
                })}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Bell ─────────────────────────────────────────────────────────

export function NotificationBell<T extends ShellNotification>(props: NotificationBellProps<T>) {
  const {
    unreadCount, hasCritical = false, compact, icon, triggerClassName, triggerTestId,
    countTestId = 'bell-count', className, 'data-testid': panelTestId, onOpenChange,
  } = props;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [announcement, setAnnouncement] = useState('');
  const kitCompact = useIsCompact();
  const isMobile = compact ?? kitCompact;
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const count = unreadCount ?? 0;

  // Fired synchronously with the state change (not from an effect) so an app
  // gating a query on it enables it in the same commit that opens the panel.
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  // Polite announcement of new arrivals, debounced so a burst reads once.
  const baseline = useRef<number | null>(null);
  const flip = useRef(false);
  useEffect(() => {
    if (unreadCount === undefined) return;
    if (baseline.current === null || unreadCount < baseline.current) {
      baseline.current = unreadCount;
      return;
    }
    if (unreadCount === baseline.current) return;
    const t = window.setTimeout(() => {
      const added = unreadCount - (baseline.current ?? unreadCount);
      baseline.current = unreadCount;
      if (added <= 0) return;
      flip.current = !flip.current;
      // Alternate a zero-width space so an identical message still re-announces.
      setAnnouncement(`${added} new notification${added === 1 ? '' : 's'}${flip.current ? '' : '​'}`);
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [unreadCount]);

  const handleClose = useCallback(() => {
    changeOpen(false);
    setFilter('all');
  }, [changeOpen]);

  // Desktop popover: outside click + Esc. Row menus are portaled, so they are
  // ignored here (their own Esc / outside handling closes them first).
  useEffect(() => {
    if (!open || isMobile) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (wrapRef.current?.contains(target)) return;
      if (target.closest('[role="menu"]')) return;
      handleClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="menu"]')) return;
      handleClose();
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, isMobile, handleClose]);

  useEffect(() => {
    if (open && !isMobile) panelRef.current?.focus();
  }, [open, isMobile]);

  const label = count > 0 ? `Notifications, ${count} unread` : 'Notifications';

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { if (open) handleClose(); else changeOpen(true); }}
        data-testid={triggerTestId}
        className={cn(
          'relative inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-[10px] border border-[var(--border-base)] bg-transparent text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
          triggerClassName,
        )}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {icon ?? <ShellBellIcon aria-hidden="true" className="h-5 w-5" />}
        {count > 0 && (
          <span
            aria-hidden="true"
            data-testid={countTestId}
            data-tone={hasCritical ? 'critical' : 'amber'}
            className="absolute -right-1.5 -top-1.5 rounded-full bg-[var(--bg-page)]"
          >
            <Badge
              {...(hasCritical ? { severity: 'critical' } : { status: 'warning' as const })}
              size="md"
              className="!h-5 !min-w-[20px] !justify-center !px-1.5 !py-0"
            >
              {count > 99 ? '99+' : count}
            </Badge>
          </span>
        )}
      </button>

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>

      {isMobile ? (
        <Sheet open={open} onOpenChange={(next) => { if (next) changeOpen(true); else handleClose(); }}>
          <SheetContent title="Notifications" labelledBy={PANEL_TITLE_ID} hideHandle fullHeight bodyClassName="p-0">
            <NotificationPanel {...props} onClose={handleClose} filter={filter} setFilter={setFilter} variant="sheet" />
          </SheetContent>
        </Sheet>
      ) : (
        open && (
          <Card
            ref={panelRef}
            variant="elevated"
            padding="none"
            role="dialog"
            aria-labelledby={PANEL_TITLE_ID}
            tabIndex={-1}
            className="absolute right-0 top-full mt-2 outline-none"
            style={{ width: 'min(400px, calc(100vw - 24px))', zIndex: 'var(--z-dropdown)' as unknown as number }}
          >
            <div className="max-h-[min(560px,calc(100dvh-96px))] overflow-y-auto overscroll-contain">
              <NotificationPanel {...props} onClose={handleClose} filter={filter} setFilter={setFilter} variant="popover" />
            </div>
          </Card>
        )
      )}
    </div>
  );
}
