// Super-admin Notification Center.
//
// NX5 (RESTRUCTURE_SPEC.md § NOTIFICATIONS RESTRUCTURE). One operator
// surface for the notification system itself:
//
//   - Activity stats: what's firing, to whom, at what severity, in
//     the last 24h. Helps the operator see if the bell is going off
//     because of real signal or because of a producer in a loop.
//
//   - Per-type system-wide mutes: silence a specific notification type
//     for N hours during an incident. Producers continue running;
//     createNotification short-circuits the insert so deliveries are
//     suppressed without changing producer code.
//
// Distinct from /v2/notifications/preferences, which is the per-user
// preferences page. This one is platform-wide.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import {
  Card, Button, Badge, PageHeader, SectionLabel,
  StatCard, StatGrid, Select,
} from '@/design-system/components';
import { Table, Th, Td } from '@/components/ui/Table';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { relativeTime } from '@/lib/time';
import {
  useNotificationStats,
  useNotificationMutes,
  useCreateNotificationMute,
  useDeleteNotificationMute,
  type NotificationMute,
  type NotificationStatsRow,
} from '@/hooks/useNotifications';

const WINDOW_OPTIONS = [
  { value: '24',  label: 'Last 24h' },
  { value: '72',  label: 'Last 3 days' },
  { value: '168', label: 'Last 7 days' },
  { value: '720', label: 'Last 30 days' },
];

const MUTE_DURATION_OPTIONS = [
  { value: '1',   label: '1 hour' },
  { value: '4',   label: '4 hours' },
  { value: '24',  label: '24 hours' },
  { value: '72',  label: '3 days' },
  { value: '168', label: '1 week' },
];

export function NotificationCenter() {
  const { isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const [windowHours, setWindowHours] = useState('24');
  const { data: stats, isLoading: statsLoading } = useNotificationStats(parseInt(windowHours, 10));
  const { data: mutes = [] } = useNotificationMutes();

  // Gate: super_admin only. Bounce to dashboard for anyone else.
  if (!isSuperAdmin) {
    navigate('/admin', { replace: true });
    return null;
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Notification Center"
        subtitle="Platform-wide activity + per-type mutes for the notification system itself"
      />

      <StatsPanel
        stats={stats}
        loading={statsLoading}
        windowHours={windowHours}
        onWindowChange={setWindowHours}
      />

      <MutesPanel mutes={mutes} />

      <ActivityTable rows={stats?.by_type ?? []} mutes={mutes} loading={statsLoading} />
    </div>
  );
}

function StatsPanel({
  stats, loading, windowHours, onWindowChange,
}: {
  stats: ReturnType<typeof useNotificationStats>['data'];
  loading: boolean;
  windowHours: string;
  onWindowChange: (v: string) => void;
}) {
  return (
    <Card hover={false}>
      <div className="flex items-center justify-between mb-4">
        <SectionLabel>Activity Overview</SectionLabel>
        <Select value={windowHours} options={WINDOW_OPTIONS} onChange={(e) => onWindowChange(e.target.value)} />
      </div>
      {loading ? (
        <div className="text-white/40 text-sm font-mono py-4 text-center">Loading…</div>
      ) : (
        <StatGrid cols={4}>
          <StatCard label="Total fired" value={stats?.totals?.total ?? 0} accentColor="#E5A832" />
          <StatCard label="Distinct types" value={stats?.totals?.types ?? 0} accentColor="#0A8AB5" />
          <StatCard label="Unique recipients" value={stats?.totals?.unique_recipients ?? 0} accentColor="#3CB878" />
          <StatCard label="Critical" value={stats?.totals?.critical_count ?? 0} accentColor="#C83C3C" />
        </StatGrid>
      )}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <AudienceCount label="super_admin" count={stats.totals.super_admin_count} />
          <AudienceCount label="tenant"      count={stats.totals.tenant_count} />
          <AudienceCount label="team"        count={stats.totals.team_count} />
          <AudienceCount label="all"         count={stats.totals.all_count} />
        </div>
      )}
    </Card>
  );
}

function AudienceCount({ label, count }: { label: string; count: number }) {
  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--text-tertiary)' }}>
        Audience: {label}
      </div>
      <div className="font-mono text-lg font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
        {count}
      </div>
    </div>
  );
}

function MutesPanel({ mutes }: { mutes: NotificationMute[] }) {
  const [type, setType] = useState('');
  const [hours, setHours] = useState('1');
  const [reason, setReason] = useState('');
  const create = useCreateNotificationMute();
  const remove = useDeleteNotificationMute();
  const { showToast } = useToast();

  function handleCreate() {
    if (!type.trim()) {
      showToast('Type is required', 'error');
      return;
    }
    create.mutate(
      { type: type.trim(), hours: parseInt(hours, 10), reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          showToast(`Muted ${type} for ${hours}h`, 'success');
          setType(''); setReason('');
        },
        onError: () => showToast('Failed to create mute', 'error'),
      },
    );
  }

  function handleRemove(t: string) {
    remove.mutate(t, {
      onSuccess: () => showToast(`Unmuted ${t}`, 'success'),
      onError: () => showToast('Failed to unmute', 'error'),
    });
  }

  return (
    <Card hover={false}>
      <SectionLabel className="mb-3">Active mutes</SectionLabel>
      <p className="text-[12px] mb-4" style={{ color: 'var(--text-secondary)' }}>
        Silence a notification type platform-wide during an incident. Producers continue firing — only delivery is suppressed. Mutes self-clear on expiry; no need to remove manually.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_max-content_2fr_max-content] gap-2 items-end mb-4">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>
            Event type
          </label>
          <Input
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder="e.g. feed_health"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>
            Duration
          </label>
          <Select value={hours} options={MUTE_DURATION_OPTIONS} onChange={(e) => setHours(e.target.value)} />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>
            Reason (optional)
          </label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="incident #123"
          />
        </div>
        <Button variant="primary" onClick={handleCreate} disabled={create.isPending || !type.trim()}>
          {create.isPending ? 'Muting…' : 'Mute'}
        </Button>
      </div>

      {mutes.length === 0 ? (
        <p className="text-sm text-white/40 italic text-center py-4">No active mutes.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Type</Th>
              <Th>Expires</Th>
              <Th>Reason</Th>
              <Th>Muted by</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {mutes.map((m) => (
              <tr key={m.id} className="data-row">
                <Td><span className="font-mono text-xs">{m.type}</span></Td>
                <Td><span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{relativeTime(m.muted_until)}</span></Td>
                <Td><span className="text-xs">{m.reason ?? <em className="text-white/40">—</em>}</span></Td>
                <Td><span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{m.created_by.slice(0, 8)}…</span></Td>
                <Td>
                  <Button variant="ghost" size="sm" onClick={() => handleRemove(m.type)} disabled={remove.isPending}>
                    Unmute
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ActivityTable({
  rows, mutes, loading,
}: {
  rows: NotificationStatsRow[];
  mutes: NotificationMute[];
  loading: boolean;
}) {
  const mutedTypes = new Set(mutes.map((m) => m.type));

  return (
    <Card hover={false} className="p-0 overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <SectionLabel>Activity by type / audience</SectionLabel>
        <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
          Each row is a (type, audience, severity) bucket. Rows showing a "MUTED" badge are currently silenced.
        </p>
      </div>
      {loading ? (
        <div className="text-white/40 text-sm font-mono py-8 text-center">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-white/40 text-sm font-mono py-8 text-center">No notifications fired in this window.</div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Type</Th>
              <Th>Audience</Th>
              <Th>Severity</Th>
              <Th>Fired</Th>
              <Th>Recipients</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.type}-${r.audience}-${r.severity}-${i}`} className="data-row">
                <Td><span className="font-mono text-xs">{r.type}</span></Td>
                <Td>
                  <Badge variant={r.audience === 'super_admin' ? 'info' : r.audience === 'tenant' ? 'low' : 'default'}>
                    {r.audience}
                  </Badge>
                </Td>
                <Td>
                  <Badge variant={
                    r.severity === 'critical' ? 'critical' :
                    r.severity === 'high'     ? 'high'     :
                    r.severity === 'medium'   ? 'medium'   :
                    'low'
                  }>
                    {r.severity}
                  </Badge>
                </Td>
                <Td><span className="font-mono text-sm font-bold">{r.fired}</span></Td>
                <Td><span className="font-mono text-xs">{r.unique_recipients}</span></Td>
                <Td>
                  {mutedTypes.has(r.type)
                    ? <Badge variant="critical">MUTED</Badge>
                    : <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>—</span>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
