import { useState } from 'react';
import {
  Card,
  StatTile,
  StatGrid,
  PageState,
  Skeleton,
  Badge,
  PageHeader,
} from '@/design-system/components';
import { Zap, Send, AlertTriangle } from 'lucide-react';
import {
  useTakedownIntegrations,
  type IntegrationHealth,
} from '@/hooks/useTakedownIntegrations';
import { STATUS_BADGE, timeAgo, successColor, MonthlyQuotaLine } from './integrationShared';
import { IntegrationConfigPanel } from './IntegrationConfigPanel';

export { MonthlyQuotaLine };

const WINDOWS: Array<{ label: string; hours: number }> = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
];


// ─── Integration card ─────────────────────────────────────────

function IntegrationCard({ it, onSelect }: { it: IntegrationHealth; onSelect: (kind: string) => void }) {
  const badge = STATUS_BADGE[it.status];
  return (
    <button
      type="button"
      onClick={() => onSelect(it.kind)}
      aria-haspopup="dialog"
      aria-label={`${it.label}: open configuration`}
      className="block w-full cursor-pointer rounded-[var(--radius-card,16px)] border-0 bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-page)]"
    >
    <Card variant={it.status === 'live' ? 'active' : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 4 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {it.channel === 'api'
                ? <Zap size={15} style={{ color: 'var(--primary-text)' }} />
                : <Send size={15} style={{ color: 'var(--text-secondary)' }} />}
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{it.label}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>
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

        {it.monthly_quota && <MonthlyQuotaLine quota={it.monthly_quota} />}

        {/* Metrics */}
        <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: successColor(it.success_rate) }}>
              {it.success_rate === null ? '—' : `${it.success_rate}%`}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
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
            display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12,
            color: 'var(--sev-high-text)', background: 'var(--sev-high-bg)',
            padding: '6px 8px', borderRadius: 6,
          }}>
            <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.last_error}</span>
          </div>
        )}
      </div>
    </Card>
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────

export function Integrations() {
  const [hours, setHours] = useState(168);
  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const { data, isLoading, isError, isPlaceholderData, refetch } = useTakedownIntegrations(hours);
  // A failed fetch is an error, never "no integrations". keepPreviousData rows
  // belong to the previous window, so they don't count as data on failure.
  const failed = isError && (!data || isPlaceholderData);
  // null = still loading / failed; never a misleading 0 for a count that has not arrived.
  const count = (n: number): number | null => data ? n : (isLoading || isError ? null : 0);

  const integrations = data?.integrations ?? [];
  const selected = integrations.find((i) => i.kind === selectedKind) ?? null;
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
                  background: hours === w.hours ? 'var(--primary)' : 'transparent',
                  color: hours === w.hours ? 'var(--btn-primary-ink, #1a1205)' : 'var(--text-secondary)',
                  border: `1px solid ${hours === w.hours ? 'var(--primary)' : 'var(--bg-card)'}`,
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
        <StatTile label="Integrations" value={count(integrations.length)} error={failed} sub="registered submitters" />
        <StatTile label="Live" value={count(liveCount)} error={failed} accent="var(--green)" sub="configured + auto-submit on" />
        <StatTile label="Configured" value={count(configuredCount)} error={failed} sub="credential present" />
        <StatTile label={`Submissions · ${data?.window_hours ?? hours}h`} value={count(totalSubmissions)} error={failed} sub="across all submitters" />
      </StatGrid>

      {data && data.send_mode === 'draft' && (
        <Card>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>
            <AlertTriangle size={15} style={{ color: 'var(--amber-text)' }} />
            Global send mode is <strong style={{ color: 'var(--amber-text)' }}>draft</strong> —
            API submitters are held until <code>TAKEDOWN_SEND_MODE=live</code>. Real abuse reports are not being sent.
          </div>
        </Card>
      )}

      {isError && !failed && (
        <PageState kind="error" layout="inline" title="Couldn't refresh integrations" description="Showing the last loaded data." onRetry={() => { void refetch(); }} />
      )}

      {failed ? (
        <PageState kind="error" layout="card" title="Couldn't load integrations" onRetry={() => { void refetch(); }} />
      ) : isLoading && !data ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      ) : integrations.length === 0 ? (
        <PageState kind="empty" layout="card" title="No integrations" description="No takedown submitters are registered." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          {integrations.map((it) => <IntegrationCard key={it.kind} it={it} onSelect={setSelectedKind} />)}
        </div>
      )}

      <IntegrationConfigPanel
        integration={selected}
        windowHours={data?.window_hours ?? hours}
        onClose={() => setSelectedKind(null)}
      />
    </div>
  );
}
