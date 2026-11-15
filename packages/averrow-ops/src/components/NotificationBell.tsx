// NotificationBell — the operator's notification entry point (ACCOUNT_DESIGN_SPEC §5.6).
// The frame (trigger, badge, live region, popover / sheet, header, filter, rows,
// footer, states) is the shared kit's NotificationBell, also used by FarmTrack.
// This wrapper feeds it ops data and adds the ops-only parts: the operator
// audience scope, the alert-triage banner (edit_alerts roles) and the snooze /
// done row actions.

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AlertTriangle, Bell, Settings, X } from 'lucide-react';
import { NotificationBell as KitNotificationBell, type ShellRenderLink } from '@averrow/shared/ui';
import { useIsMobile } from '@/hooks/useWindowWidth';
import {
  useNotifications, useMarkRead, useMarkAllRead, OPS_AUDIENCE_FILTER,
  useSnoozeNotification, useMarkDone,
} from '@/hooks/useNotifications';
import { useAlertTriageSummary } from '@/hooks/useAlerts';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import type { Notification } from '@/hooks/useNotifications';
import { SNOOZE_OPTIONS, snoozeUntilIso } from '@/lib/snooze';
import { useUnreadSummary } from './notifications/useUnreadSummary';
import { resolveNotificationLink } from '@/lib/notificationLink';

const renderLink: ShellRenderLink = (p) => (
  <Link
    to={p.href}
    className={p.className}
    onClick={p.onClick}
    aria-label={p['aria-label']}
    title={p.title}
    data-testid={p['data-testid']}
  >
    {p.children}
  </Link>
);

function TriageBanner({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  // Same gate as Home: only edit_alerts roles triage, so others never fetch it.
  const { user } = useAuth();
  const canTriage = roleHasPermission(user?.role, 'edit_alerts');
  const { data: triage } = useAlertTriageSummary({ enabled: canTriage });

  const newCount = triage?.new_count ?? 0;
  const criticalCount = triage?.critical_count ?? 0;
  if (!(canTriage && newCount > 0)) return null;
  const triageText = criticalCount > 0 ? 'var(--sev-critical-text)' : 'var(--sev-medium-text)';

  return (
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
  );
}

export function NotificationBell() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  // The list is fetched only while the panel is open (or already needed for the
  // badge colour), exactly as when the panel owned the query.
  const [open, setOpen] = useState(false);

  // N1: ops bell is scoped to operator-relevant audiences only. Tenant brand
  // events (DMARC drift, lookalike registered) ring the tenant SPA's bell, and
  // the badge counts only operator-relevant unread so it can't blink on
  // tenant-only events.
  const { data, isLoading, isError, refetch } = useNotifications(open, OPS_AUDIENCE_FILTER);
  const { count: unreadData, hasCritical } = useUnreadSummary();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const snooze = useSnoozeNotification();
  const markDone = useMarkDone();

  const handleActivate = (n: Notification, close: () => void) => {
    if (n.state === 'unread') markRead.mutate(n.id);
    if (n.link) {
      navigate(resolveNotificationLink(n.link, '/notifications'));
      close();
    }
  };

  return (
    <KitNotificationBell
      items={data?.notifications ?? []}
      unreadCount={unreadData}
      panelUnreadCount={data?.unread_count ?? 0}
      hasCritical={hasCritical}
      loading={isLoading && !data}
      error={isError}
      errorHasStaleData={!!data}
      onRetry={() => { void refetch(); }}
      onMarkAllRead={() => markAllRead.mutate()}
      onActivate={(n, { close }) => handleActivate(n, close)}
      onSnooze={(n, hours) => snooze.mutate({ id: n.id, until: snoozeUntilIso(hours) })}
      snoozeOptions={SNOOZE_OPTIONS}
      onDone={(n) => markDone.mutate(n.id)}
      rowActions="kebab"
      renderBanner={({ close }) => <TriageBanner onClose={close} />}
      footerLinks={[
        { key: 'all', label: 'View all', href: '/notifications', tone: 'primary' },
        { key: 'settings', label: 'Notification settings', href: '/settings/notifications', tone: 'secondary' },
      ]}
      settingsHref="/settings/notifications"
      renderLink={renderLink}
      compact={isMobile}
      onOpenChange={setOpen}
      icon={<Bell aria-hidden="true" className="h-5 w-5" />}
      settingsIcon={<Settings aria-hidden="true" className="h-[18px] w-[18px]" />}
      closeIcon={<X aria-hidden="true" className="h-5 w-5" />}
      emptyIcon={<Bell />}
    />
  );
}
