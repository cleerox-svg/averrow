import { useState } from 'react';
import {
  Card,
  StatCard,
  StatGrid,
  PageHeader,
  EmptyState,
  Skeleton,
  Badge,
} from '@/design-system/components';
import { Zap, Send, AlertTriangle } from 'lucide-react';
import {
  useTakedownIntegrations,
  type IntegrationHealth,
  type IntegrationStatus,
} from '@/hooks/useTakedownIntegrations';
import type { BadgeStatus } from '@/design-system/components';

// ─── Status presentation ──────────────────────────────────────

const STATUS_BADGE: Record<IntegrationStatus, { status: BadgeStatus; label: string; pulse?: boolean }> = {
  live:         { status: 'healthy',  label: 'Live', pulse: true },
  paused:       { status: 'warning',  label: 'Ready · draft mode' },
  disabled:     { status: 'inactive', label: 'Disabled' },
  active:       { status: 'active',   label: 'Active' },
  unconfigured: { status: 'degraded', label: 'Not configured' },
};

const WINDOWS: Array<{ label: string; hours: number }> = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
];

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  if (Number.isNaN(then)) return iso;
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function successColor(rate: number | null): string {
  if (rate === null) return 'var(--text-tertiary)';
  if (rate >= 80) return 'var(--green)';
  if (rate >= 50) return 'var(--amber)';
  return 'var(--red)';
}

// ─── Integration card ─────────────────────────────────────────

function IntegrationCard({ it }: { it: IntegrationHealth }) {
  const badge = STATUS_BADGE[it.status];
  return (
    <Card variant={it.status === 'live' ? 'active' : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 4 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {it.channel === 'api'
                ? <Zap size={15} style={{ color: 'var(--amber)' }} />
                : <Send size={15} style={{ color: 'var(--text-secondary)' }} />}
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{it.label}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3, fontFamily: 'monospace' }}>
              {it.kind}
            </div>
          </div>
          <Badge status={badge.status} pulse={badge.pulse}>{badge.label}</Badge>
        </div>

        {/* Config line */}
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span>
            Credential:{' '}
            <strong style={{ color: it.configured ? 'var(--green)' : 'var(--red)' }}>
              {it.configured ? 'set' : 'missing'}
            </strong>
          </span>
          {it.channel === 'api' && (
            <span>
              Auto-submit:{' '}
              <strong style={{ color: it.auto_submit_enabled ? 'var(--green)' : 'var(--text-tertiary)' }}>
                {it.auto_submit_enabled ? 'on' : 'off'}
              </strong>
            </span>
          )}
        </div>

        {/* Metrics */}
        <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: successColor(it.success_rate) }}>
              {it.success_rate === null ? '—' : `${it.success_rate}%`}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              success
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <div>{it.submitted} submitted · {it.failed} failed · {it.rejected} rejected{it.queued ? ` · ${it.queued} queued` : ''}</div>
            <div style={{ color: 'var(--text-tertiary)' }}>
              {it.total} total · last {timeAgo(it.last_submission_at)}
            </div>
          </div>
        </div>

        {/* Last error */}
        {it.last_error && (
          <div style={{
            display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11,
            color: 'var(--sev-high)', background: 'var(--sev-high-bg)',
            padding: '6px 8px', borderRadius: 6,
          }}>
            <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.last_error}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────

export function Integrations() {
  const [hours, setHours] = useState(168);
  const { data, isLoading } = useTakedownIntegrations(hours);

  const integrations = data?.integrations ?? [];
  const liveCount = integrations.filter((i) => i.status === 'live').length;
  const configuredCount = integrations.filter((i) => i.configured).length;
  const totalSubmissions = integrations.reduce((sum, i) => sum + i.total, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Integrations"
        subtitle="Takedown submitter health — configuration, live status, and submission outcomes per provider"
        actions={
          <div style={{ display: 'flex', gap: 4 }}>
            {WINDOWS.map((w) => (
              <button
                key={w.hours}
                onClick={() => setHours(w.hours)}
                style={{
                  padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  background: hours === w.hours ? 'var(--amber)' : 'transparent',
                  color: hours === w.hours ? '#1a1205' : 'var(--text-secondary)',
                  border: `1px solid ${hours === w.hours ? 'var(--amber)' : 'var(--bg-card)'}`,
                  fontWeight: hours === w.hours ? 600 : 400,
                }}
              >
                {w.label}
              </button>
            ))}
          </div>
        }
      />

      <StatGrid>
        <StatCard label="Integrations" value={integrations.length} sublabel="registered submitters" />
        <StatCard label="Live" value={liveCount} accentColor="var(--green)" sublabel="configured + auto-submit on" />
        <StatCard label="Configured" value={configuredCount} sublabel="credential present" />
        <StatCard label={`Submissions · ${data?.window_hours ?? hours}h`} value={totalSubmissions} sublabel="across all submitters" />
      </StatGrid>

      {data && data.send_mode === 'draft' && (
        <Card>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>
            <AlertTriangle size={15} style={{ color: 'var(--amber)' }} />
            Global send mode is <strong style={{ color: 'var(--amber)' }}>draft</strong> —
            API submitters are held until <code>TAKEDOWN_SEND_MODE=live</code>. Real abuse reports are not being sent.
          </div>
        </Card>
      )}

      {isLoading && !data ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      ) : integrations.length === 0 ? (
        <EmptyState title="No integrations" description="No takedown submitters are registered." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          {integrations.map((it) => <IntegrationCard key={it.kind} it={it} />)}
        </div>
      )}
    </div>
  );
}
