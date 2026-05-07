// Tenant Notifications inbox.
//
// Backed by GET /api/notifications (user-scoped, not org-scoped).
// Same backend that powers averrow-ui's notification bell.
//
// Phase B sprint 2 — viewer-only. Mark-read / snooze / done
// mutations port in subsequent sprints.

import { Bell, Inbox, Clock, type LucideIcon } from 'lucide-react';
import { useTenantNotifications, type Notification } from '@/lib/notifications';
import { cn } from '@/lib/cn';

export function Notifications() {
  const { data, isLoading, error } = useTenantNotifications();

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-white/55">
          Personal feed: alert digests, briefings, and platform updates for your account.
        </p>
      </header>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <RollupCard label="Unread" value={data.unread_count} icon={Bell} tone={data.unread_count > 0 ? 'warn' : 'neutral'} />
          <RollupCard label="Total" value={data.notifications.length} icon={Inbox} tone="neutral" />
          <RollupCard
            label="Snoozed"
            value={data.notifications.filter((n) => n.state === 'snoozed').length}
            icon={Clock}
            tone="neutral"
          />
        </div>
      )}

      {isLoading && <Loading />}
      {error    && <ErrorState error={error.message} />}

      {data && (
        data.notifications.length === 0 ? (
          <EmptyState />
        ) : (
          <section className="space-y-2">
            {data.notifications.map((n) => <NotificationRow key={n.id} notification={n} />)}
          </section>
        )
      )}
    </div>
  );
}

function NotificationRow({ notification: n }: { notification: Notification }) {
  const isUnread = n.state === 'unread';
  const Border =
    n.severity === 'critical' ? 'border-l-sev-critical' :
    n.severity === 'high'     ? 'border-l-amber'        :
    n.severity === 'medium'   ? 'border-l-amber/50'     :
                                'border-l-white/[0.08]';

  return (
    <article
      className={cn(
        'rounded-r-xl rounded-l-none border-l-2 bg-bg-card p-4 transition-colors',
        Border,
        isUnread ? 'bg-white/[0.03]' : '',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {isUnread && <span className="w-1.5 h-1.5 rounded-full bg-amber" aria-label="unread" />}
            <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">
              {n.type.replace(/_/g, ' ')}
            </span>
            <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">·</span>
            <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">{n.severity}</span>
          </div>
          <h3 className="text-sm font-semibold text-white/90">{n.title}</h3>
          <p className="text-[12px] text-white/55 mt-1 leading-relaxed">{n.message}</p>
          {n.recommended_action && (
            <p className="text-[11px] text-amber/80 mt-2 font-mono">→ {n.recommended_action}</p>
          )}
        </div>
        <span className="text-[10px] font-mono text-white/40 flex-shrink-0">
          {relativeTime(n.created_at)}
        </span>
      </div>
    </article>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function RollupCard({
  label, value, icon: Icon, tone,
}: {
  label: string; value: number;
  icon: LucideIcon;
  tone: 'neutral' | 'warn';
}) {
  const accent = tone === 'warn' ? 'text-amber' : 'text-white/85';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
        <Icon size={11} /><span>{label}</span>
      </div>
      <div className={`text-3xl font-bold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-8 text-center">
      <Inbox size={28} className="mx-auto text-white/30 mb-2" />
      <p className="text-sm text-white/70">Inbox zero.</p>
      <p className="text-[11px] text-white/40 mt-1">No notifications waiting for you.</p>
    </div>
  );
}

function Loading() {
  return <div className="text-white/40 text-sm font-mono py-12 text-center">Loading notifications…</div>;
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
      <h3 className="text-sm font-semibold text-white/90">Couldn't load notifications</h3>
      <p className="text-[12px] text-white/55 mt-1">{error}</p>
    </div>
  );
}
