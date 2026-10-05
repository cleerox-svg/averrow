// NotificationBell — the operator's notification entry point (ACCOUNT_DESIGN_SPEC §5.6).
//
//   Trigger   44x44, count Badge (red only while an unread critical exists,
//             otherwise amber), 99+ cap, polite live region for new arrivals.
//   Desktop   ~400px popover (elevated card) anchored under the bell.
//   Mobile    full-height kit Sheet with a top bar (title, Mark all read,
//             settings, close).
//   Panel     All | Unread filter, triage banner, day-grouped rows (same row
//             component as the /notifications inbox), footer links.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Bell, Settings, X } from 'lucide-react';
import {
  Badge, Card, PageState, SegmentedControl, Sheet, SheetClose, SheetContent,
} from '@averrow/shared/ui';
import { useIsMobile } from '@/hooks/useWindowWidth';
import {
  useUnreadCount, useNotifications, useMarkRead, useMarkAllRead, OPS_AUDIENCE_FILTER,
  useSnoozeNotification, useMarkDone,
} from '@/hooks/useNotifications';
import { useAlertTriageSummary } from '@/hooks/useAlerts';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import type { Notification } from '@/hooks/useNotifications';
import { snoozeUntilIso } from '@/lib/snooze';
import { DayHeading, NotificationRow, NotificationRowSkeletons } from './notifications/NotificationRow';
import { groupByDay } from './notifications/groupByDay';

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

// ─── Panel ────────────────────────────────────────────────────────

function NotificationPanel({
  onClose,
  filter,
  setFilter,
  variant,
}: {
  onClose: () => void;
  filter: FilterKey;
  setFilter: (f: FilterKey) => void;
  variant: 'popover' | 'sheet';
}) {
  const navigate = useNavigate();
  // N1: ops bell is scoped to operator-relevant audiences only. Tenant brand
  // events (DMARC drift, lookalike registered) ring the tenant SPA's bell.
  const { data, isLoading, isError, refetch } = useNotifications(true, OPS_AUDIENCE_FILTER);
  // Same gate as Home: only edit_alerts roles triage, so others never fetch it.
  const { user } = useAuth();
  const canTriage = roleHasPermission(user?.role, 'edit_alerts');
  const { data: triage } = useAlertTriageSummary({ enabled: canTriage });
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const snooze = useSnoozeNotification();
  const markDone = useMarkDone();

  const notifications = useMemo(() => data?.notifications ?? [], [data]);
  const unreadCount = data?.unread_count ?? 0;
  const visible = useMemo(
    () => (filter === 'unread' ? notifications.filter((n) => n.state === 'unread') : notifications),
    [notifications, filter],
  );
  const groups = useMemo(() => groupByDay(visible), [visible]);

  const handleActivate = (n: Notification) => {
    if (n.state === 'unread') markRead.mutate(n.id);
    if (n.link) {
      navigate(n.link);
      onClose();
    }
  };

  const newCount = triage?.new_count ?? 0;
  const criticalCount = triage?.critical_count ?? 0;
  const showTriage = canTriage && newCount > 0;
  const triageText = criticalCount > 0 ? 'var(--sev-critical-text)' : 'var(--sev-medium-text)';
  const isSheet = variant === 'sheet';
  const showSkeleton = isLoading && !data;
  const showError = isError;

  return (
    <div className="flex min-h-full flex-col">
      {/* Header — pinned while the list scrolls */}
      <div
        className="sticky top-0 z-[2] border-b border-[var(--border-base)] bg-[var(--bg-elevated)]"
        style={isSheet ? { paddingTop: 'env(safe-area-inset-top, 0px)' } : undefined}
      >
        <div className="flex items-center gap-1 py-1 pl-4 pr-1.5">
          <div className="min-w-0 flex-1">
            <h2 id={PANEL_TITLE_ID} className="m-0 text-[16px] font-bold leading-tight tracking-[-0.2px] text-[var(--text-primary)]">
              Notifications
            </h2>
            {unreadCount > 0 && (
              <p className="m-0 font-mono text-[12px] text-[var(--text-tertiary)]">{unreadCount} unread</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => markAllRead.mutate()}
            disabled={unreadCount === 0}
            className={`${TEXT_LINK} cursor-pointer border-0 bg-transparent text-[var(--amber-text)] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] disabled:cursor-not-allowed disabled:text-[var(--text-tertiary)] disabled:hover:bg-transparent`}
          >
            Mark all read
          </button>
          <Link
            to="/settings/notifications"
            onClick={onClose}
            aria-label="Notification settings"
            title="Notification settings"
            className={ICON_LINK}
          >
            <Settings aria-hidden="true" className="h-[18px] w-[18px]" />
          </Link>
          {isSheet && (
            <SheetClose asChild>
              <button
                type="button"
                aria-label="Close notifications"
                className={`${ICON_LINK} cursor-pointer border-0 bg-transparent`}
              >
                <X aria-hidden="true" className="h-5 w-5" />
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

      {/* Triage row — only when alerts are waiting */}
      {showTriage && (
        <button
          type="button"
          onClick={() => { navigate('/console?tab=alerts&status=new'); onClose(); }}
          className="mx-4 mt-3 flex min-h-[44px] cursor-pointer items-center justify-between gap-2 rounded-[10px] px-3 text-left"
          style={{
            background: criticalCount > 0 ? 'var(--sev-critical-bg)' : 'var(--sev-medium-bg)',
            border: `1px solid ${criticalCount > 0 ? 'var(--sev-critical-border)' : 'var(--sev-medium-border)'}`,
            color: triageText,
          }}
        >
          <span className="flex min-w-0 items-center gap-2">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="truncate text-[13px] font-semibold">
              {newCount.toLocaleString()} alert{newCount === 1 ? '' : 's'} awaiting triage
            </span>
            {criticalCount > 0 && (
              <span
                className="dot-pulse-red h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sev-critical)]"
                role="img"
                aria-label={`${criticalCount} critical`}
              />
            )}
          </span>
          <span aria-hidden="true" className="shrink-0 text-[13px]">→</span>
        </button>
      )}

      {/* Body */}
      <div className="flex-1">
        {showError && (
          <div className="px-4 pt-3">
            <PageState
              kind="error"
              layout="inline"
              compact
              assertive={!data}
              title="Couldn't load notifications"
              description={data ? 'Showing the last loaded list.' : 'Check your connection and try again.'}
              onRetry={() => { void refetch(); }}
            />
          </div>
        )}
        {showSkeleton ? (
          <NotificationRowSkeletons />
        ) : visible.length === 0 ? (
          !(showError && !data) && (
            <PageState
              kind="clear"
              layout="page"
              compact
              icon={<Bell />}
              title={filter === 'unread' && notifications.length > 0 ? 'No unread notifications' : "You're all caught up"}
              description="New notifications will show up here."
              action={
                <Link
                  to="/settings/notifications"
                  onClick={onClose}
                  className={`${TEXT_LINK} text-[var(--amber-text)]`}
                >
                  Notification settings
                </Link>
              }
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
                    actions="kebab"
                    onActivate={() => handleActivate(n)}
                    onSnooze={(hours) => snooze.mutate({ id: n.id, until: snoozeUntilIso(hours) })}
                    onDone={() => markDone.mutate(n.id)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {/* Footer — pinned */}
      <div
        className="sticky bottom-0 z-[2] flex items-center justify-between gap-2 border-t border-[var(--border-base)] bg-[var(--bg-elevated)] px-2"
        style={isSheet ? { paddingBottom: 'env(safe-area-inset-bottom, 0px)' } : undefined}
      >
        <Link to="/notifications" onClick={onClose} className={`${TEXT_LINK} text-[var(--amber-text)]`}>
          View all
        </Link>
        <Link to="/settings/notifications" onClick={onClose} className={`${TEXT_LINK} text-[var(--text-secondary)] hover:text-[var(--text-primary)]`}>
          Notification settings
        </Link>
      </div>
    </div>
  );
}

// ─── Bell ─────────────────────────────────────────────────────────

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [announcement, setAnnouncement] = useState('');
  const isMobile = useIsMobile();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // N1: unread badge counts only operator-relevant unread, mirroring the
  // bell's scoped fetch so the badge can't blink on tenant-only events.
  const { data: unreadData } = useUnreadCount(OPS_AUDIENCE_FILTER);
  const unreadCount = unreadData ?? 0;

  // Whether an unread critical exists comes from the same list the panel
  // shows (no new endpoint). Only fetched while something is unread, and
  // re-fetched when the count moves so a fresh critical turns the badge red.
  const { data: feed, refetch: refetchFeed } = useNotifications(unreadCount > 0, OPS_AUDIENCE_FILTER);
  useEffect(() => {
    if (unreadCount > 0) void refetchFeed();
  }, [unreadCount, refetchFeed]);
  const hasCritical = (feed?.notifications ?? []).some((n) => n.state === 'unread' && n.severity === 'critical');

  // Polite announcement of new arrivals, debounced so a burst reads once.
  const baseline = useRef<number | null>(null);
  const flip = useRef(false);
  useEffect(() => {
    if (unreadData === undefined) return;
    if (baseline.current === null || unreadData < baseline.current) {
      baseline.current = unreadData;
      return;
    }
    if (unreadData === baseline.current) return;
    const t = window.setTimeout(() => {
      const added = unreadData - (baseline.current ?? unreadData);
      baseline.current = unreadData;
      if (added <= 0) return;
      flip.current = !flip.current;
      setAnnouncement(`${added} new notification${added === 1 ? '' : 's'}${flip.current ? '' : '​'}`);
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [unreadData]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setFilter('all');
  }, []);

  // Desktop popover: outside click + Esc. Row menus are portaled, so they are
  // ignored here (their own Esc / outside handling closes them first).
  useEffect(() => {
    if (!open || isMobile) return;
    const onDown = (e: MouseEvent) => {
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

  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-[10px] border border-[var(--border-base)] bg-transparent text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Bell aria-hidden="true" className="h-5 w-5" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            data-testid="bell-count"
            data-tone={hasCritical ? 'critical' : 'amber'}
            className="absolute -right-1.5 -top-1.5 rounded-full bg-[var(--bg-page)]"
          >
            <Badge
              {...(hasCritical ? { severity: 'critical' } : { status: 'warning' as const })}
              size="md"
              className="!h-5 !min-w-[20px] !justify-center !px-1.5 !py-0"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          </span>
        )}
      </button>

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>

      {isMobile ? (
        <Sheet open={open} onOpenChange={(next) => { if (next) setOpen(true); else handleClose(); }}>
          <SheetContent title="Notifications" labelledBy={PANEL_TITLE_ID} hideHandle fullHeight bodyClassName="p-0">
            <NotificationPanel onClose={handleClose} filter={filter} setFilter={setFilter} variant="sheet" />
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
              <NotificationPanel onClose={handleClose} filter={filter} setFilter={setFilter} variant="popover" />
            </div>
          </Card>
        )
      )}
    </div>
  );
}
