import { useState, useMemo, Fragment } from 'react';
import { useAgentRuns, useAgentTokenUsage } from '@/hooks/useAgents';
import type { AgentRun, TokenUsageEntry } from '@/hooks/useAgents';
import { relativeTime } from '@/lib/time';
import { Badge, Button, Input } from '@/design-system/components';
import { getAgentMetadata, AGENT_IDS } from '@/lib/agent-metadata';

const STATUS_OPTIONS = ['ALL', 'success', 'partial', 'failed'] as const;
const WINDOW_OPTIONS = [
  { label: 'Last 24H', value: '24h' },
  { label: '7D', value: '7d' },
  { label: '30D', value: '30d' },
  { label: 'All', value: '' },
] as const;

const PAGE_SIZE = 50;

// ─── Helpers ───────────────────────────────────────────────────
function formatTokens(n: number): string {
  if (!n) return '\u2014';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatRunDuration(run: AgentRun): string {
  const ms = run.duration_ms;
  if (ms == null) {
    if (!run.started_at || !run.completed_at) return '\u2014';
    const diff = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
    return formatMs(diff);
  }
  return formatMs(ms);
}

function formatMs(ms: number): string {
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function formatFullDate(date: string | null): string {
  if (!date) return '\u2014';
  return new Date(date).toLocaleString();
}

// ─── Token Usage Summary ───────────────────────────────────────
function TokenUsageSummary({ data }: { data: TokenUsageEntry[] }) {
  const maxTokens = data.length > 0 ? data[0].total_tokens : 1;
  const totalTokens = data.reduce((sum, d) => sum + d.total_tokens, 0);

  return (
    <div className="rounded-xl p-5 mb-6" style={{ background:'rgba(15,23,42,0.50)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:'0.75rem', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)' }}>
      <div className="font-mono text-[9px] text-white/40 uppercase tracking-widest mb-4">
        Token Usage (All Time)
      </div>
      <div className="space-y-3">
        {data.map((entry) => {
          const meta = getAgentMetadata(entry.agent_id);
          return (
          <div key={entry.agent_id} className="flex items-center gap-3">
            <div className="w-28 shrink-0">
              <span
                className="font-mono text-[11px] font-medium"
                style={{ color: meta?.color ?? '#78A0C8' }}
              >
                {meta?.displayName ?? entry.agent_id}
              </span>
            </div>
            <div
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid var(--border-base)',
                borderRadius: 4,
                overflow: 'hidden',
                height: 10,
              }}
            >
              <div
                style={{
                  width: `${(entry.total_tokens / maxTokens) * 100}%`,
                  height: '100%',
                  borderRadius: 4,
                  transition: 'width 0.5s ease',
                  background: 'linear-gradient(90deg, var(--amber-dim), var(--amber))',
                  boxShadow: '0 0 10px var(--amber-glow)',
                }}
              />
            </div>
            <div className="w-20 text-right font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
              {entry.total_tokens.toLocaleString()}
            </div>
          </div>
          );
        })}
      </div>
      <div className="mt-4 pt-3 border-t border-white/[0.06]">
        <span className="font-mono text-[10px] text-white/40">Total: </span>
        <span className="font-mono text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>
          {totalTokens.toLocaleString()} tokens
        </span>
      </div>
    </div>
  );
}

// ─── Expanded Row Detail ───────────────────────────────────────
function RunDetail({ run }: { run: AgentRun }) {
  return (
    <tr>
      <td colSpan={7} className="px-4 py-3 bg-white/[0.02]">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-[11px]">
          <div>
            <span className="font-mono text-white/40 block mb-1">Run ID</span>
            <span className="font-mono select-all" style={{ color: 'var(--text-primary)' }}>{run.id}</span>
          </div>
          <div>
            <span className="font-mono text-white/40 block mb-1">Started</span>
            <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{formatFullDate(run.started_at)}</span>
          </div>
          <div>
            <span className="font-mono text-white/40 block mb-1">Completed</span>
            <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{formatFullDate(run.completed_at)}</span>
          </div>
          {run.tokens_used ? (
            <>
              <div>
                <span className="font-mono text-white/40 block mb-1">Input Tokens</span>
                <span className="font-mono" style={{ color: 'var(--text-primary)' }}>
                  {(run.input_tokens ?? 0).toLocaleString()}
                </span>
              </div>
              <div>
                <span className="font-mono text-white/40 block mb-1">Output Tokens</span>
                <span className="font-mono" style={{ color: 'var(--text-primary)' }}>
                  {(run.output_tokens ?? 0).toLocaleString()}
                </span>
              </div>
              <div>
                <span className="font-mono text-white/40 block mb-1">Total Tokens</span>
                <span className="font-mono" style={{ color: 'var(--text-primary)' }}>
                  {(run.tokens_used ?? 0).toLocaleString()}
                </span>
              </div>
            </>
          ) : null}
          {run.status === 'failed' && run.error_message && (
            <div className="sm:col-span-2 lg:col-span-3">
              <span className="font-mono text-white/40 block mb-1">Error</span>
              <div className="rounded-lg px-3 py-2 font-mono text-[11px] text-[#f87171]" style={{ background:'rgba(15,23,42,0.50)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid rgba(239,68,68,0.30)', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)' }}>
                {run.error_message}
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Main History View ─────────────────────────────────────────
export function HistoryView() {
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [windowFilter, setWindowFilter] = useState('7d');
  const [page, setPage] = useState(0);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const { data: tokenUsage } = useAgentTokenUsage();
  const { data: runsData, isLoading } = useAgentRuns({
    agent: agentFilter || undefined,
    status: statusFilter !== 'ALL' ? statusFilter : undefined,
    window: windowFilter || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const runs = runsData?.data ?? [];
  const total = runsData?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Client-side search filter
  const filteredRuns = useMemo(() => {
    if (!search.trim()) return runs;
    const q = search.toLowerCase();
    return runs.filter((r) => r.agent_id.toLowerCase().includes(q));
  }, [runs, search]);

  const handleExportCsv = () => {
    const headers = ['id', 'agent_id', 'status', 'records_processed', 'outputs_generated', 'duration_ms', 'started_at', 'completed_at', 'error_message'];
    const csvRows = [headers.join(',')];
    for (const run of filteredRuns) {
      csvRows.push(headers.map((h) => {
        const val = run[h as keyof AgentRun];
        if (val == null) return '';
        return String(val).includes(',') ? `"${val}"` : String(val);
      }).join(','));
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-runs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="animate-fade-in space-y-4">
      {/* Token Usage Summary */}
      {tokenUsage && tokenUsage.length > 0 && (
        <TokenUsageSummary data={tokenUsage} />
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="w-full sm:w-48">
          <Input
            type="text"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="text-[11px] font-mono"
          />
        </div>
        <select
          value={agentFilter}
          onChange={(e) => { setAgentFilter(e.target.value); setPage(0); }}
          className="rounded-lg px-3 py-2 text-[11px] font-mono w-full sm:w-auto"
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border-base)',
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        >
          <option value="">All Agents</option>
          {AGENT_IDS.map((a) => (
            <option key={a} value={a}>{getAgentMetadata(a)?.displayName ?? a}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
          className="rounded-lg px-3 py-2 text-[11px] font-mono w-full sm:w-auto"
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border-base)',
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s.toUpperCase()}</option>
          ))}
        </select>
        <div className="flex gap-1">
          {WINDOW_OPTIONS.map((w) => (
            <Button
              key={w.value}
              variant={windowFilter === w.value ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => { setWindowFilter(w.value); setPage(0); }}
            >
              {w.label}
            </Button>
          ))}
        </div>
        <div className="ml-auto">
          <Button variant="ghost" size="sm" onClick={handleExportCsv}>
            Export CSV
          </Button>
        </div>
      </div>

      {/* Run Log Table */}
      <div className="rounded-xl overflow-hidden" style={{ background:'rgba(15,23,42,0.50)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:'0.75rem', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-4 py-3 font-mono text-[9px] text-white/40 uppercase tracking-widest">Timestamp</th>
                <th className="px-4 py-3 font-mono text-[9px] text-white/40 uppercase tracking-widest">Agent</th>
                <th className="px-4 py-3 font-mono text-[9px] text-white/40 uppercase tracking-widest">Status</th>
                <th className="px-4 py-3 font-mono text-[9px] text-white/40 uppercase tracking-widest">Records</th>
                <th className="px-4 py-3 font-mono text-[9px] text-white/40 uppercase tracking-widest hidden sm:table-cell">Outputs</th>
                <th className="px-4 py-3 font-mono text-[9px] text-white/40 uppercase tracking-widest">Tokens</th>
                <th className="px-4 py-3 font-mono text-[9px] text-white/40 uppercase tracking-widest">Duration</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-white/[0.03]">
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-white/[0.04] rounded animate-pulse w-16" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filteredRuns.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center font-mono text-[11px] text-white/40">
                    No runs found
                  </td>
                </tr>
              ) : (
                filteredRuns.map((run) => (
                    <Fragment key={run.id}>
                      <tr
                        onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                        className="border-b border-white/[0.03] cursor-pointer hover:bg-white/[0.02] transition-colors"
                      >
                        <td className="px-4 py-3 font-mono text-[11px] text-white/60" title={formatFullDate(run.started_at)}>
                          {relativeTime(run.started_at)}
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            const m = getAgentMetadata(run.agent_id);
                            return (
                              <span
                                className="font-mono text-[10px] font-semibold uppercase tracking-wider"
                                style={{ color: m?.color ?? '#78A0C8' }}
                              >
                                {m?.displayName ?? run.agent_id}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={run.status} />
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
                          {run.records_processed > 0 ? run.records_processed : '\u2014'}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] tabular-nums hidden sm:table-cell" style={{ color: 'var(--text-primary)' }}>
                          {run.outputs_generated > 0 ? run.outputs_generated : '\u2014'}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
                          {formatTokens(run.tokens_used ?? 0)}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
                          {formatRunDuration(run)}
                        </td>
                      </tr>
                      {expandedRun === run.id && <RunDetail run={run} />}
                    </Fragment>
                  ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-white/40">
            {total.toLocaleString()} total runs
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
            >
              Prev
            </Button>
            <span className="font-mono text-[10px] text-white/50 flex items-center px-2">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Status Badge ──────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  if (status === 'success') return <Badge status="healthy"  label="Success" size="xs" pulse />;
  if (status === 'partial') return <Badge severity="high"   label="Partial" size="xs" pulse />;
  if (status === 'failed')  return <Badge severity="critical" label="Failed" size="xs" pulse />;
  return <Badge status="inactive" label={status.toUpperCase()} size="xs" />;
}
