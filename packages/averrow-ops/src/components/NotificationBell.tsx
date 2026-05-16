// NotificationBell — operator dropdown for the notification feed.
//
// Redesigned 2026-05-16 to look like a modern notification surface
// (Linear / GitHub patterns) instead of a database row dump:
//
//   - Header gets a kebab menu instead of two competing links.
//   - Filter strip collapses 9 pills into 4 semantic buckets
//     (All / Critical / Platform / Intel) — surfaces what an operator
//     actually triages.
//   - Each row gets a severity-colored left stripe, a type icon, and
//     a single line of metadata (no more ALL CAPS event-key label).
//   - Rows group by time bucket (Today / Yesterday / Earlier) — a
//     stale 4-day-old notification no longer sits visually next to
//     a 2-minute one.
//   - Empty state has an icon + reassuring copy.
//
// Mobile (BottomSheet) and desktop (Dropdown) wrappers stay the same;
// only the inner content changed.

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, AlertTriangle, Clock, Check, MoreHorizontal, Settings, CheckCheck,
  Radio, Cpu, Brain, Mail, Database, TrendingUp, UserX, Lightbulb,
  PauseCircle, DollarSign, Layers, FileText, Workflow, Globe,
  ShieldAlert, Inbox,
  type LucideIcon,
} from 'lucide-react';
import { useIsMobile } from '@/hooks/useWindowWidth';
import {
  useUnreadCount, useNotifications, useMarkRead, useMarkAllRead, OPS_AUDIENCE_FILTER,
  useSnoozeNotification, useMarkDone,
} from '@/hooks/useNotifications';
import { useAlertTriageSummary } from '@/hooks/useAlerts';
import type { Notification } from '@/hooks/useNotifications';
import { relativeTime } from '@/lib/time';
import { Dropdown } from './Dropdown';
import { BottomSheet } from './BottomSheet';

// ─── Type → icon mapping ──────────────────────────────────────────
// Picks an icon per event family. Adding a new event key in
// @averrow/shared falls through to the default Bell.
function iconForType(type: string): LucideIcon {
  // Platform health — operator-only signals
  if (type === 'platform_feed_at_risk' || type === 'platform_feed_silent') return Radio;
  if (type === 'platform_feed_auto_paused') return PauseCircle;
  if (type === 'platform_agent_stalled' || type === 'platform_briefing_silent') return PauseCircle;
  if (type === 'platform_d1_budget_warn' || type === 'platform_d1_budget_breach') return Database;
  if (type === 'platform_kv_budget_warn') return Database;
  if (type === 'platform_worker_cpu_burst') return Cpu;
  if (type === 'platform_ai_spend_burst') return DollarSign;
  if (type === 'platform_enrichment_stuck_pile') return Layers;
  if (type === 'platform_cron_orchestrator_missed' || type === 'platform_cron_navigator_missed') return Clock;
  if (type === 'platform_workflow_dispatch_silent') return Workflow;
  if (type === 'platform_geoip_refresh_stalled') return Globe;
  if (type === 'platform_resend_bounces') return Inbox;
  // Intel
  if (type === 'intelligence_digest' || type === 'intel_predictive' || type === 'intel_cross_brand_pattern') return Brain;
  if (type === 'intel_sector_trend') return TrendingUp;
  if (type === 'intel_recommended_action') return Lightbulb;
  if (type === 'intel_threat_actor_surface') return UserX;
  // Campaigns / brand signals
  if (type === 'campaign_escalation') return TrendingUp;
  if (type === 'agent_milestone') return ShieldAlert;
  if (type === 'brand_threat') return AlertTriangle;
  // Email / abuse mailbox
  if (type === 'email_security_change' || type === 'abuse_mailbox_verdict' || type === 'abuse_mailbox_flood_detected') return Mail;
  // Agent telemetry / feed health
  if (type === 'feed_health') return Radio;
  if (type === 'circuit_breaker_tripped') return PauseCircle;
  if (type === 'notification_digest') return FileText;
  return Bell;
}

// ─── Type → high-level family ─────────────────────────────────────
// Used by the filter buckets so a single bucket covers many event keys.

type Family = 'platform' | 'intel' | 'brand' | 'email' | 'agent' | 'generic';

function familyForType(type: string): Family {
  if (type.startsWith('platform_')) return 'platform';
  if (type.startsWith('intel_') || type === 'intelligence_digest') return 'intel';
  if (type === 'brand_threat' || type === 'campaign_escalation' || type === 'agent_milestone') return 'brand';
  if (type === 'email_security_change' || type === 'abuse_mailbox_verdict' || type === 'abuse_mailbox_flood_detected') return 'email';
  if (type === 'feed_health' || type === 'circuit_breaker_tripped') return 'agent';
  return 'generic';
}

// ─── Time bucketing ───────────────────────────────────────────────
// Three buckets: Today / Yesterday / Earlier. Keeps the dropdown
// scannable without trying to be a calendar.

type TimeBucket = 'today' | 'yesterday' | 'earlier';

function bucketForDate(iso: string): TimeBucket {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const t = d.getTime();
  if (t >= startOfToday) return 'today';
  if (t >= startOfYesterday) return 'yesterday';
  return 'earlier';
}

const BUCKET_LABEL: Record<TimeBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
};

// ─── Severity helpers ─────────────────────────────────────────────

function severityStripe(severity: string): string {
  switch (severity) {
    case 'critical': return 'var(--sev-critical)';
    case 'high':     return 'var(--sev-high)';
    case 'medium':   return 'var(--sev-medium)';
    case 'low':      return 'var(--sev-low)';
    default:         return 'rgba(255,255,255,0.10)';
  }
}

function severityChipText(severity: string): string {
  switch (severity) {
    case 'critical': return 'text-[var(--sev-critical)]';
    case 'high':     return 'text-[var(--sev-high)]';
    case 'medium':   return 'text-[var(--sev-medium)]';
    case 'low':      return 'text-[var(--sev-low)]';
    default:         return 'text-white/40';
  }
}

// ─── Filter bucket ────────────────────────────────────────────────
// Four semantic buckets — keeps the chip strip to a single row.

type FilterKey = 'all' | 'critical' | 'platform' | 'intel';

const FILTER_OPTIONS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'all',      label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'platform', label: 'Platform' },
  { key: 'intel',    label: 'Intel' },
];

function notificationMatchesFilter(n: Notification, f: FilterKey): boolean {
  if (f === 'all') return true;
  if (f === 'critical') return n.severity === 'critical' || n.severity === 'high';
  if (f === 'platform') return familyForType(n.type) === 'platform' || familyForType(n.type) === 'agent';
  if (f === 'intel')    return familyForType(n.type) === 'intel';
  return true;
}

// ─── Notification row ─────────────────────────────────────────────

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
  const Icon = iconForType(notification.type);
  const stripeColor = severityStripe(notification.severity);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  return (
    <div
      className="group relative w-full transition-colors"
      style={{
        background: isUnread ? 'rgba(255,255,255,0.025)' : 'transparent',
      }}
    >
      {/* Severity stripe — 3px on the left edge. Critical/high get full
          opacity; medium/low fade so the eye filters down to what matters. */}
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{
          background: stripeColor,
          opacity: notification.severity === 'critical' ? 1
                 : notification.severity === 'high'     ? 0.85
                 : notification.severity === 'medium'   ? 0.55
                 : notification.severity === 'low'      ? 0.30
                 : 0.10,
        }}
      />

      <div className="pl-4 pr-2 py-3 hover:bg-white/[0.025]">
        <div className="flex items-start gap-3">
          {/* Type icon — anchors the row visually and tells the operator
              what kind of event this is without reading the text. */}
          <div
            className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center mt-0.5"
            style={{
              background: isUnread ? `${stripeColor}1A` : 'rgba(255,255,255,0.04)',
              color: isUnread ? stripeColor : 'var(--text-tertiary)',
            }}
          >
            <Icon size={14} />
          </div>

          <button
            onClick={() => onActivate(notification)}
            className="flex-1 min-w-0 text-left touch-target"
            aria-label={notification.link ? `Open "${notification.title}"` : notification.title}
          >
            <div className="flex items-baseline justify-between gap-2">
              <p
                className="text-[13px] leading-snug line-clamp-2 font-medium"
                style={{ color: isUnread ? 'var(--text-primary)' : 'var(--text-secondary)' }}
              >
                {notification.title}
              </p>
              <span
                className="flex-shrink-0 text-[10px] font-mono whitespace-nowrap"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {relativeTime(notification.created_at)}
              </span>
            </div>
            <p
              className="text-[11px] mt-0.5 line-clamp-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {notification.message}
            </p>
            {notification.recommended_action && (
              <p className="text-[11px] mt-1 line-clamp-1 italic" style={{ color: 'var(--amber)' }}>
                {notification.recommended_action}
              </p>
            )}
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`text-[10px] font-mono uppercase tracking-wider ${severityChipText(notification.severity)}`}>
                {notification.severity}
              </span>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>·</span>
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
                {notification.type.replace(/_/g, ' ')}
              </span>
            </div>
          </button>

          {/* Per-row kebab — always visible on touch, transparent until
              hover on desktop. Replaces the always-visible Clock/Check
              icon row which felt noisy. */}
          <div ref={menuRef} className="relative flex-shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
              className="p-1.5 rounded hover:bg-white/[0.06] opacity-40 group-hover:opacity-100 transition-opacity touch-target"
              style={{ color: 'var(--text-tertiary)' }}
              aria-label="Notification actions"
            >
              <MoreHorizontal size={14} />
            </button>
            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-1 min-w-[160px] rounded-md shadow-lg z-10 py-1"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-base)',
                }}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onSnooze(notification.id); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-white/[0.06] text-left"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <Clock size={12} /> Snooze 1 hour
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDone(notification.id); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-white/[0.06] text-left"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <Check size={12} /> Mark done
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── List ─────────────────────────────────────────────────────────

function NotificationList({
  onClose,
  filter,
  setFilter,
}: {
  onClose: () => void;
  filter: FilterKey;
  setFilter: (f: FilterKey) => void;
}) {
  const navigate = useNavigate();
  // N1: ops bell is scoped to operator-relevant audiences only. Tenant
  // brand events (DMARC drift, lookalike registered) ring the tenant
  // SPA's bell, not this one.
  const { data } = useNotifications(true, OPS_AUDIENCE_FILTER);
  const { data: triage } = useAlertTriageSummary();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const snooze = useSnoozeNotification();
  const markDone = useMarkDone();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const notifications = data?.notifications ?? [];

  // Counts per filter bucket — shown inline on the chip so the operator
  // can see "Critical (1)" without having to click in.
  const counts = useMemo(() => {
    return FILTER_OPTIONS.reduce((acc, opt) => {
      acc[opt.key] = notifications.filter(n => notificationMatchesFilter(n, opt.key)).length;
      return acc;
    }, {} as Record<FilterKey, number>);
  }, [notifications]);

  const filtered = notifications.filter(n => notificationMatchesFilter(n, filter));

  // Group filtered notifications by time bucket. Map preserves insertion
  // order so 'today' renders before 'yesterday' before 'earlier'.
  const grouped = useMemo(() => {
    const buckets = new Map<TimeBucket, Notification[]>([
      ['today', []], ['yesterday', []], ['earlier', []],
    ]);
    for (const n of filtered) {
      const b = bucketForDate(n.created_at);
      buckets.get(b)!.push(n);
    }
    return buckets;
  }, [filtered]);

  const handleActivate = (n: Notification) => {
    if (n.state === 'unread') markRead.mutate(n.id);
    if (n.link) {
      navigate(n.link);
      onClose();
    }
  };

  const handleSnooze = (id: string) => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    snooze.mutate({ id, until });
  };

  const handleDone = (id: string) => {
    markDone.mutate(id);
  };

  const newCount = triage?.new_count ?? 0;
  const criticalCount = triage?.critical_count ?? 0;
  const showTriage = newCount > 0;
  const unreadCount = data?.unread_count ?? 0;

  return (
    <div className="flex flex-col max-h-[560px] md:max-h-[560px]">
      {/* Header — title + unread count + kebab menu replacing the
          previous "Mark all read" + "Settings" links pattern. */}
      <div className="px-4 pt-4 pb-3 flex-shrink-0 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
            Notifications
          </h2>
          <p className="text-[11px] mt-0.5 font-mono" style={{ color: 'var(--text-tertiary)' }}>
            {unreadCount > 0 ? `${unreadCount} unread · ` : ''}{notifications.length} total
          </p>
        </div>
        <div ref={menuRef} className="relative flex-shrink-0">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-2 rounded-md hover:bg-white/[0.06] touch-target"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="Notification options"
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 min-w-[200px] rounded-md shadow-lg z-20 py-1"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-base)',
              }}
            >
              <button
                onClick={() => { setMenuOpen(false); markAllRead.mutate(); }}
                disabled={unreadCount === 0}
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-white/[0.06] text-left disabled:opacity-40 disabled:hover:bg-transparent"
                style={{ color: 'var(--text-primary)' }}
              >
                <CheckCheck size={12} /> Mark all read
              </button>
              <button
                onClick={() => { setMenuOpen(false); navigate('/notifications/preferences'); onClose(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-white/[0.06] text-left"
                style={{ color: 'var(--text-primary)' }}
              >
                <Settings size={12} /> Preferences
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Triage row — only when there are alerts that need triage.
          Compact, monochromatic against the bell's neutral background;
          the count is the headline, the icon plays a supporting role. */}
      {showTriage && (
        <button
          onClick={() => { navigate('/alerts?status=new'); onClose(); }}
          className="mx-4 mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-md transition-colors touch-target"
          style={{
            background: criticalCount > 0 ? 'var(--sev-critical-bg)' : 'var(--sev-medium-bg)',
            border: `1px solid ${criticalCount > 0 ? 'var(--sev-critical-border)' : 'var(--sev-medium-border)'}`,
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle
              size={14}
              style={{ color: criticalCount > 0 ? 'var(--sev-critical)' : 'var(--sev-medium)' }}
              className="flex-shrink-0"
            />
            <span
              className="text-[12px] font-semibold truncate"
              style={{ color: criticalCount > 0 ? 'var(--sev-critical)' : 'var(--sev-medium)' }}
            >
              {newCount.toLocaleString()} signal{newCount === 1 ? '' : 's'} need triage
            </span>
            {criticalCount > 0 && (
              <span
                className="dot-pulse-red flex-shrink-0"
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--sev-critical)',
                }}
                aria-label={`${criticalCount} critical`}
              />
            )}
          </div>
          <span
            className="text-[12px] flex-shrink-0"
            style={{ color: criticalCount > 0 ? 'var(--sev-critical)' : 'var(--sev-medium)' }}
            aria-hidden
          >
            →
          </span>
        </button>
      )}

      {/* Filter strip — 4 semantic buckets with inline counts. Replaces
          the prior 9-pill 3-row layout. Counts let the operator skim
          without clicking. */}
      <div className="flex gap-1 px-4 pb-3 flex-shrink-0 overflow-x-auto scrollbar-none">
        {FILTER_OPTIONS.map(({ key, label }) => {
          const isActive = filter === key;
          const count = counts[key] ?? 0;
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] transition-all touch-target"
              style={{
                background: isActive ? 'var(--amber)' : 'transparent',
                border: `1px solid ${isActive ? 'var(--amber)' : 'var(--border-base)'}`,
                color: isActive ? '#0A0F1E' : 'var(--text-secondary)',
                fontWeight: isActive ? 700 : 500,
              }}
            >
              {label}
              <span
                className="font-mono text-[10px] px-1 rounded"
                style={{
                  background: isActive ? 'rgba(10,15,30,0.18)' : 'rgba(255,255,255,0.06)',
                  color: isActive ? '#0A0F1E' : 'var(--text-tertiary)',
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t" style={{ borderColor: 'var(--border-base)' }} />

      {/* List body with time-bucketed sections. */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border-base)',
              }}
            >
              <Bell size={20} className="text-white/30" />
            </div>
            <p className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {filter === 'all' ? "You're all caught up" : 'No matches in this filter'}
            </p>
            <p className="text-[11px] mt-1 font-mono" style={{ color: 'var(--text-tertiary)' }}>
              {filter === 'all' ? 'New notifications will land here.' : 'Try a different filter or All.'}
            </p>
          </div>
        ) : (
          Array.from(grouped.entries()).map(([bucket, items]) => {
            if (items.length === 0) return null;
            return (
              <section key={bucket}>
                <div
                  className="px-4 pt-3 pb-1 sticky top-0 z-[1] backdrop-blur-sm"
                  style={{ background: 'rgba(6,10,20,0.85)' }}
                >
                  <span className="text-[10px] font-mono uppercase tracking-[0.15em]" style={{ color: 'var(--text-tertiary)' }}>
                    {BUCKET_LABEL[bucket]} · {items.length}
                  </span>
                </div>
                <div className="divide-y" style={{ borderColor: 'var(--border-base)' }}>
                  {items.map(n => (
                    <NotificationItem
                      key={n.id}
                      notification={n}
                      onActivate={handleActivate}
                      onSnooze={handleSnooze}
                      onDone={handleDone}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>

      {/* Footer — single archive CTA. Settings moves to the header kebab. */}
      <div
        className="border-t px-4 py-2.5 flex-shrink-0 flex items-center justify-between"
        style={{ borderColor: 'var(--border-base)' }}
      >
        <button
          onClick={() => { navigate('/notifications'); onClose(); }}
          className="text-[12px] font-medium transition-colors touch-target"
          style={{ color: 'var(--amber)' }}
        >
          Open inbox →
        </button>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
          Showing {notifications.length}
        </span>
      </div>
    </div>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('all');
  const isMobile = useIsMobile();
  // N1: unread badge counts only operator-relevant unread, mirroring the
  // bell's scoped fetch so the badge can't blink on tenant-only events
  // that don't show up in the dropdown.
  const { data: unreadCount = 0 } = useUnreadCount(OPS_AUDIENCE_FILTER);

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
        <Dropdown open={open} onClose={handleClose} width={420}>
          <NotificationList onClose={handleClose} filter={filter} setFilter={setFilter} />
        </Dropdown>
      )}
    </div>
  );
}
