/**
 * Phase 5.5 — "Declarations" panel for the agent detail screen.
 *
 * Surfaces the AgentModule's declared fields:
 *   - Budget cap vs current-month spend (with an over-alert pulse)
 *   - Supervision (stall threshold, parallel max, cost guard)
 *   - Resource declarations (D1 tables / KV namespaces / R2 buckets)
 *   - Output types
 *
 * Compact + read-only — operators can see what an agent SHOULD do
 * vs what it's actually doing (last_run / records_processed already
 * surfaced elsewhere). Phase 5.5 closes the loop on every Phase 4
 * declaration field by giving it a runtime surface.
 */

import { useMemo } from 'react';
import { ShieldCheck, ShieldOff, Database, KeyRound, Box, Plug, Layers, AlertTriangle, Globe } from 'lucide-react';

import { Card, Badge } from '@/design-system/components';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAgentModuleMetadata, type ResourceDecl } from '@/hooks/useAgentModuleMetadata';

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function resourceLabel(r: ResourceDecl): string {
  switch (r.kind) {
    case 'd1_table': return r.name ?? '(unknown table)';
    case 'kv':       return `${r.namespace}${r.prefix ? ` · ${r.prefix}` : ''}`;
    case 'r2':       return `${r.bucket}${r.prefix ? ` · ${r.prefix}` : ''}`;
    case 'queue':    return r.name ?? '(unknown queue)';
    case 'binding':  return r.name ?? '(unknown binding)';
    case 'external': return `${r.name ?? '(unnamed)'}${r.url ? ` · ${r.url}` : ''}`;
  }
}

function ResourceIcon({ kind }: { kind: ResourceDecl['kind'] }) {
  switch (kind) {
    case 'd1_table': return <Database size={11} />;
    case 'kv':       return <KeyRound size={11} />;
    case 'r2':       return <Box size={11} />;
    case 'queue':    return <Layers size={11} />;
    case 'binding':  return <Plug size={11} />;
    case 'external': return <Globe size={11} />;
  }
}

export function AgentDeclarationsPanel({ agentId }: { agentId: string }) {
  const { data, isLoading, isError } = useAgentModuleMetadata(agentId);

  const budgetTone = useMemo<{ color: string; label: string }>(() => {
    if (!data) return { color: 'var(--text-secondary)', label: '' };
    if (data.budget.over_cap) return { color: 'var(--sev-critical)', label: 'OVER CAP' };
    if (data.budget.over_alert_threshold) return { color: 'var(--sev-medium)', label: 'OVER ALERT' };
    if (data.budget.monthly_token_cap === 0) return { color: 'var(--text-tertiary)', label: 'EXEMPT' };
    return { color: 'var(--sev-low)', label: 'OK' };
  }, [data]);

  if (isLoading) {
    return (
      <Card style={{ padding: '20px' }}>
        <div className="font-mono text-[10px] uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>
          Declarations
        </div>
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card style={{ padding: '20px' }}>
        <div className="flex items-start gap-3">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" style={{ color: 'var(--sev-critical)' }} />
          <div className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            Could not load module-metadata for {agentId}.
          </div>
        </div>
      </Card>
    );
  }

  const cap = data.budget.monthly_token_cap;
  const tokens = data.budget.tokens_month;
  const pct = data.budget.pct_of_cap;
  const barWidthPct = cap > 0 ? Math.min(100, Math.round((tokens / cap) * 100)) : 0;

  return (
    <Card style={{ padding: '20px' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          Declarations
        </div>
        <span className="font-mono text-[9px] uppercase tracking-wider" style={{ color: budgetTone.color }}>
          {budgetTone.label}
        </span>
      </div>

      {/* ── Budget cap vs current-month spend ── */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            Monthly tokens
          </span>
          <span className="font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>
            {formatTokens(tokens)}
            {cap > 0 ? ` / ${formatTokens(cap)}` : ' (cap=0, exempt)'}
            {pct !== null && cap > 0 && (
              <span className="ml-1.5" style={{ color: 'var(--text-tertiary)' }}>· {pct}%</span>
            )}
          </span>
        </div>
        {cap > 0 && (
          <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <div
              className="h-full transition-all"
              style={{
                width: `${barWidthPct}%`,
                background: budgetTone.color,
                opacity: 0.85,
              }}
            />
          </div>
        )}
        <div className="mt-1.5 font-mono text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
          {data.budget.calls_month.toLocaleString()} call{data.budget.calls_month === 1 ? '' : 's'} · ${data.budget.cost_usd_month.toFixed(2)} this month
          {data.budget.alert_at !== 0.8 && ` · alert at ${Math.round(data.budget.alert_at * 100)}%`}
        </div>
      </div>

      {/* ── Supervision ── */}
      <div className="grid grid-cols-3 gap-3 mb-4 pb-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <SupervisionStat label="Stall" value={`${data.supervision.stall_threshold_minutes}m`} />
        <SupervisionStat label="Parallel" value={String(data.supervision.parallel_max)} />
        <SupervisionStat
          label="Cost guard"
          value={data.supervision.cost_guard === 'enforced' ? 'enforced' : 'exempt'}
          icon={data.supervision.cost_guard === 'enforced' ? <ShieldCheck size={10} /> : <ShieldOff size={10} />}
          tone={data.supervision.cost_guard === 'enforced' ? 'var(--sev-low)' : 'var(--text-tertiary)'}
        />
      </div>

      {/* ── Resource declarations ── */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <ResourceList label="Reads" items={data.resources.reads} />
        <ResourceList label="Writes" items={data.resources.writes} />
      </div>

      {/* ── Outputs ── */}
      {data.outputs.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
            Output types
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.outputs.map((o, i) => (
              <Badge key={`${o.type}-${i}`} label={o.type} size="xs" />
            ))}
          </div>
        </div>
      )}

      {data.budget.rollup_updated_at && (
        <div className="mt-4 font-mono text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
          Rollup updated {data.budget.rollup_updated_at}
        </div>
      )}
    </Card>
  );
}

function SupervisionStat({
  label, value, icon, tone,
}: { label: string; value: string; icon?: React.ReactNode; tone?: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div className="font-mono text-[11px] inline-flex items-center gap-1" style={{ color: tone ?? 'var(--text-primary)' }}>
        {icon}
        {value}
      </div>
    </div>
  );
}

function ResourceList({ label, items }: { label: string; items: ResourceDecl[] }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
        {label} ({items.length})
      </div>
      {items.length === 0 ? (
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          —
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((r, i) => (
            <div
              key={`${r.kind}-${i}`}
              className="font-mono text-[10px] inline-flex items-center gap-1.5 mr-2"
              style={{ color: 'var(--text-secondary)' }}
              title={`${r.kind}: ${resourceLabel(r)}`}
            >
              <span style={{ color: 'var(--text-tertiary)' }}>
                <ResourceIcon kind={r.kind} />
              </span>
              {resourceLabel(r)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
