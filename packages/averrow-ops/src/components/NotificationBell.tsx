import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, AlertTriangle, Clock, Check } from 'lucide-react';
import { useIsMobile } from '@/hooks/useWindowWidth';
import {
  useUnreadCount, useNotifications, useMarkRead, useMarkAllRead,
  useSnoozeNotification, useMarkDone,
} from '@/hooks/useNotifications';
import { useAlertTriageSummary } from '@/hooks/useAlerts';
import type { Notification } from '@/hooks/useNotifications';
import { relativeTime } from '@/lib/time';
import { Badge } from '@/design-system/components';
import { USER_TOGGLEABLE_EVENTS, type NotificationEventKey } from '@averrow/shared';
import { Dropdown } from './Dropdown';
import { BottomSheet } from './BottomSheet';

// Filter pills are now generated from the @averrow/shared registry —
// all 5 user-toggleable events + an "All" pill. Adding a new event in
// notification-events.ts auto-surfaces here. System events
// (email_security_change, circuit_breaker_tripped) appear in the feed
// but aren't filterable from the bell — they're not user-controllable
// in any other surface either.
type FilterType = 'all' | NotificationEventKey;

function severityToBadgeSeverity(severity: string): 'critical' | 'high' | 'medium' | 'low' | 'info' {
  switch (severity) {
    case 'critical':
    case 'high':
    case 'medium':
    case 'low':
    case 'info':
      return severity;
    default:
      return 'info';
  }
}

function severityBorderToken(severity: string): string {
  switch (severity) {
    case 'critical': return 'var(--sev-critical-border)';
    case 'high':     return 'var(--sev-high-border)';
    case 'medium':   return 'var(--sev-medium-border)';
    case 'low':      return 'var(--sev-low-border)';
    default:         return 'var(--sev-info-border)';
  }
}

function severityDotClass(severity: string): string {
  switch (severity) {
    case 'critical': return 'dot-pulse-red';
    case 'high':
    case 'medium':   return 'dot-pulse-amber';
    default:         return 'dot-pulse-afterburner';
  }
}

function NotificationItem({
  notification,
  onActivate,
  onSnooze,
  onDone,
}: {
  notification: Notification;
  onActivate: (n: Notification) => void;
  onSnooze: (id: string) => void;
  onDone: (id: string) => void;
}) {
  const isUnread = notification.state === 'unread';
  return (
    <div
      className="group relative w-full px-4 py-3 transition-colors hover:bg-white/5"
      style={{
        borderLeft: isUnread ? `2px solid ${severityBorderToken(notification.severity)}` : '2px solid transparent',
        background: isUnread ? 'rgba(255,255,255,0.03)' : 'transparent',
      }}
    >
      <div className="flex items-start gap-2">
        {isUnread && (
          <span className={`dot-pulse mt-1.5 flex-shrink-0 ${severityDotClass(notification.severity)}`} style={{ width: 6, height: 6 }} />
        )}
        <button
          onClick={() => onActivate(notification)}
          className="flex-1 min-w-0 text-left touch-target"
          aria-label={notification.link ? `Open "${notification.title}"` : notification.title}
        >
          <p className="text-[13px] leading-snug line-clamp-2" style={{ color: 'var(--text-primary)' }}>
            {notification.title}
          </p>
          <p className="text-[11px] mt-1 line-clamp-1" style={{ color: 'var(--text-tertiary)' }}>
            {notification.message}
          </p>
          {notification.recommended_action && (
            <p className="text-[11px] mt-1 font-mono line-clamp-1" style={{ color: 'var(--amber)' }}>
              {'→ '}{notification.recommended_action}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] font-mono uppercase" style={{ color: 'var(--text-secondary)' }}>
              {notification.type.replace(/_/g, ' ')}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>·</span>
            <Badge severity={severityToBadgeSeverity(notification.severity)} size="xs" />
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>·</span>
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
              {relativeTime(notification.created_at)}
            </span>
          </div>
        </button>
        {/* §7.7 row actions — appear on hover (mouse) or always (touch) */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); onSnooze(notification.id); }}
            className="p-1.5 rounded hover:bg-white/[0.06] touch-target"
            style={{ color: 'var(--text-tertiary)' }}
            aria-label="Snooze 1 hour"
            title="Snooze 1h"
          >
            <Clock className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDone(notification.id); }}
            className="p-1.5 rounded hover:bg-white/[0.06] touch-target"
            style={{ color: 'var(--text-tertiary)' }}
            aria-label="Mark done"
            title="Done"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function NotificationList({
  onClose,
  filter,
  setFilter,
}: {
  onClose: () => void;
  filter: FilterType;
  setFilter: (f: FilterType) => void;
}) {
  const navigate = useNavigate();
  const { data } = useNotifications(true);
  const { data: triage } = useAlertTriageSummary();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const snooze = useSnoozeNotification();
  const markDone = useMarkDone();

  // Filter pills generated from the registry — `all` + each
  // user-toggleable event. Adding a new event to
  // `@averrow/shared/notification-events` auto-surfaces a pill here.
  const filterOptions = useMemo(
    () => [
      { key: 'all' as const, label: 'All' },
      ...USER_TOGGLEABLE_EVENTS.map((e) => ({ key: e.key, label: e.label })),
    ],
    [],
  );

  const notifications = data?.notifications ?? [];
  const filtered = filter === 'all'
    ? notifications
    : notifications.filter(n => n.type === filter);

  // Click navigates to notification.link if present, marks as read,
  // and closes the bell. Without a link this is just a mark-as-read
  // — the dead-end behavior the audit (§4) flagged.
  const handleActivate = (n: Notification) => {
    if (n.state === 'unread') markRead.mutate(n.id);
    if (n.link) {
      navigate(n.link);
      onClose();
    }
  };

  const handleSnooze = (id: string) => {
    // 1h default snooze (§7.7). Custom durations land in N5.
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    snooze.mutate({ id, until });
  };

  const handleDone = (id: string) => {
    markDone.mutate(id);
  };

  // Triage row — surfaces unresolved alerts at the most-discoverable
  // surface (the bell). Hidden when there are no `status='new'`
  // alerts. Critical-only count gets a red pulse dot. Tap navigates
  // to /v2/alerts?status=new so the operator lands on the same
  // filter that produced the count.
  const newCount = triage?.new_count ?? 0;
  const criticalCount = triage?.critical_count ?? 0;
  const showTriage = newCount > 0;

  const handleTriageClick = () => {
    navigate('/alerts?status=new');
    onClose();
  };

  return (
    <div className="flex flex-col max-h-[520px] md:max-h-[520px]">
      {showTriage && (
        <button
          onClick={handleTriageClick}
          className="w-full flex items-center justify-between gap-2 px-4 py-2.5 transition-colors touch-target"
          style={{
            background: criticalCount > 0
              ? 'var(--sev-critical-bg)'
              : 'var(--sev-medium-bg)',
            borderBottom: '1px solid var(--border-base)',
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle
              className="w-3.5 h-3.5 flex-shrink-0"
              style={{
                color: criticalCount > 0 ? 'var(--sev-critical)' : 'var(--sev-medium)',
              }}
            />
            <span
              className="font-mono text-[11px] font-semibold uppercase tracking-wider truncate"
              style={{
                color: criticalCount > 0 ? 'var(--sev-critical)' : 'var(--sev-medium)',
              }}
            >
              {newCount} alert{newCount === 1 ? '' : 's'} need{newCount === 1 ? 's' : ''} triage
            </span>
            {criticalCount > 0 && (
              <span
                className="dot-pulse-red flex-shrink-0"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--sev-critical)',
                }}
                aria-label={`${criticalCount} critical`}
              />
            )}
          </div>
          <span
            className="font-mono text-[12px] flex-shrink-0"
            style={{
              color: criticalCount > 0 ? 'var(--sev-critical)' : 'var(--sev-medium)',
            }}
            aria-hidden
          >
            →
          </span>
        </button>
      )}

      <div className="px-4 pt-4 pb-2 flex-shrink-0">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] font-bold" style={{ color: 'var(--text-secondary)' }}>
            Notifications
          </span>
          <button
            onClick={() => markAllRead.mutate()}
            className="text-[10px] font-mono transition-colors touch-target"
            style={{ color: 'var(--amber)' }}
          >
            Mark all read
          </button>
        </div>
        <p className="text-[11px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
          {data?.unread_count ?? 0} unread
        </p>
      </div>

      <div className="flex flex-wrap gap-1 px-4 pb-3 flex-shrink-0">
        {filterOptions.map(({ key, label }) => {
          const isActive = filter === key;
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className="px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider transition-all touch-target"
              style={{
                background: isActive
                  ? 'linear-gradient(135deg, var(--amber), var(--amber-dim))'
                  : 'transparent',
                border: isActive
                  ? '1px solid rgba(229, 168, 50, 0.60)'
                  : '1px solid var(--border-base)',
                color: isActive ? 'var(--text-on-amber, #0A0F1E)' : 'var(--text-secondary)',
                fontWeight: 800,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="border-t border-white/5" />

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-[12px] text-white/40 font-mono">
            No notifications
          </div>
        ) : (
          filtered.map(n => (
            <NotificationItem
              key={n.id}
              notification={n}
              onActivate={handleActivate}
              onSnooze={handleSnooze}
              onDone={handleDone}
            />
          ))
        )}
      </div>

      <div className="border-t border-white/5 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <button
          onClick={() => { navigate('/notifications'); onClose(); }}
          className="text-[10px] font-mono transition-colors touch-target"
          style={{ color: 'var(--amber)' }}
        >
          View all notifications &rarr;
        </button>
        <button
          onClick={() => { navigate('/notifications/preferences'); onClose(); }}
          className="text-[10px] font-mono text-white/40 hover:text-white/60 transition-colors touch-target"
        >
          Settings
        </button>
      </div>
    </div>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const isMobile = useIsMobile();
  const { data: unreadCount = 0 } = useUnreadCount();

  const handleClose = useCallback(() => {
    setOpen(false);
    setFilter('all');
  }, []);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg touch-target"
        style={{
          background: 'transparent',
          border: '1px solid var(--border-base)',
        }}
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5 text-white/70" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-1.5 -right-1.5 min-w-[20px] h-[20px] px-1.5 rounded-full flex items-center justify-center text-[10px] font-bold font-mono dot-pulse-red"
            style={{
              background: 'var(--sev-critical)',
              color: '#fff',
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isMobile ? (
        <BottomSheet open={open} onClose={handleClose}>
          <NotificationList onClose={handleClose} filter={filter} setFilter={setFilter} />
        </BottomSheet>
      ) : (
        <Dropdown open={open} onClose={handleClose} width={380}>
          <NotificationList onClose={handleClose} filter={filter} setFilter={setFilter} />
        </Dropdown>
      )}
    </div>
  );
}
