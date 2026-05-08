import { useState, useEffect, useCallback } from 'react';
import { useAgents, useAgentConfig, useApiUsage, useTriggerAgent } from '@/hooks/useAgents';
import type { Agent } from '@/hooks/useAgents';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { TableLoader } from '@/components/ui/PageLoader';
import { Badge } from '@/components/ui/Badge';
import { AgentIcon } from '@/components/brand/AgentIcon';
import { useToast } from '@/components/ui/Toast';
import { relativeTime, formatDuration } from '@/lib/time';
import { cn } from '@/lib/cn';

type TriggerState = 'idle' | 'loading' | 'success' | 'error';

function TriggerButton({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { mutateAsync } = useTriggerAgent();
  const { showToast } = useToast();
  const [state, setState] = useState<TriggerState>('idle');

  const resetTimer = useCallback(() => {
    const id = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (state === 'success' || state === 'error') {
      return resetTimer();
    }
  }, [state, resetTimer]);

  const handleClick = async () => {
    setState('loading');
    try {
      await mutateAsync(agentId);
      setState('success');
      showToast(`${agentName} triggered successfully`, 'success');
    } catch {
      setState('error');
      showToast(`Failed to trigger ${agentName}`, 'error');
    }
  };

  if (state === 'loading') {
    return (
      <button disabled className="flex items-center gap-1.5 px-3 py-1.5 border border-accent/30 rounded text-accent font-mono text-[10px] font-bold uppercase tracking-wide opacity-60">
        <span className="w-3 h-3 border-2 border-accent/40 border-t-accent rounded-full animate-spin" />
        Running
      </button>
    );
  }

  if (state === 'success') {
    return (
      <span className="flex items-center gap-1.5 px-3 py-1.5 text-positive font-mono text-[10px] font-bold uppercase tracking-wide">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        Triggered
      </span>
    );
  }

  if (state === 'error') {
    return (
      <span className="flex items-center gap-1.5 px-3 py-1.5 text-accent font-mono text-[10px] font-bold uppercase tracking-wide">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        Failed
      </span>
    );
  }

  return (
    <button
      onClick={handleClick}
      className="px-3 py-1.5 border border-accent/30 rounded text-accent font-mono text-[10px] font-bold uppercase tracking-wide hover:bg-accent/10 transition-colors"
    >
      Trigger Now
    </button>
  );
}

const statusVariant: Record<string, 'success' | 'critical' | 'high' | 'default'> = {
  active: 'success',
  error: 'critical',
  degraded: 'high',
  idle: 'default',
};

function AgentRow({ agent }: { agent: Agent }) {
  const successRate = agent.jobs_24h > 0
    ? Math.round(((agent.jobs_24h - agent.error_count_24h) / agent.jobs_24h) * 100)
    : 100;

  return (
    <tr className="data-row border-b border-white/[0.04]">
      <td className="py-3 px-4">
        <div className="flex items-center gap-3">
          <AgentIcon agent={agent.name} size={24} className="shrink-0" />
          <div>
            <div className="font-mono text-[12px] font-bold text-[rgba(255,255,255,0.92)]">{agent.display_name}</div>
            <div className="font-mono text-[9px] text-white/55 uppercase">{agent.description}</div>
          </div>
        </div>
      </td>
      <td className="py-3 px-4">
        <Badge variant={statusVariant[agent.status] || 'default'}>{agent.status}</Badge>
      </td>
      <td className="py-3 px-4 font-mono text-[11px] text-[rgba(255,255,255,0.36)]">{agent.schedule}</td>
      <td className="py-3 px-4 font-mono text-[11px] text-[rgba(255,255,255,0.36)]">{relativeTime(agent.last_run_at)}</td>
      <td className="py-3 px-4 font-mono text-[11px] text-[rgba(255,255,255,0.36)]">{formatDuration(agent.avg_duration_ms)}</td>
      <td className="py-3 px-4 font-mono text-[11px] text-[rgba(255,255,255,0.36)]">{successRate}%</td>
      <td className="py-3 px-4 font-mono text-[11px] text-[rgba(255,255,255,0.92)]">{agent.outputs_24h}</td>
      <td className="py-3 px-4">
        <TriggerButton agentId={agent.name} agentName={agent.display_name} />
      </td>
    </tr>
  );
}

function ApiUsagePanel() {
  const { data: usage, isLoading } = useApiUsage();

  if (isLoading) return <Skeleton className="h-44 rounded-xl" />;
  if (!usage) return <EmptyState message="No API usage data available" />;

  const usagePercent = usage.daily_limit > 0
    ? Math.min(Math.round((usage.calls_today / usage.daily_limit) * 100), 100)
    : 0;

  const barColor = usagePercent >= 100
    ? 'bg-accent'
    : usagePercent >= 60
      ? 'bg-yellow-400'
      : 'bg-positive';

  return (
    <div className="bg-instrument border border-white/[0.06] rounded-xl p-5">
      <SectionLabel className="mb-4">Haiku API Usage</SectionLabel>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-5">
        <div>
          <div className="font-display text-lg font-bold text-[rgba(255,255,255,0.92)]">{(usage.tokens_24h ?? 0).toLocaleString()}</div>
          <div className="font-mono text-[9px] text-white/55 uppercase">Tokens 24h</div>
          <div className="font-mono text-[10px] text-[rgba(255,255,255,0.30)] mt-0.5">{usage.estimated_cost_24h}</div>
        </div>
        <div>
          <div className="font-display text-lg font-bold text-[rgba(255,255,255,0.92)]">{(usage.tokens_7d ?? 0).toLocaleString()}</div>
          <div className="font-mono text-[9px] text-white/55 uppercase">Tokens 7d</div>
          <div className="font-mono text-[10px] text-[rgba(255,255,255,0.30)] mt-0.5">{usage.estimated_cost_7d}</div>
        </div>
        <div>
          <div className="font-display text-lg font-bold text-[rgba(255,255,255,0.92)]">{(usage.tokens_30d ?? 0).toLocaleString()}</div>
          <div className="font-mono text-[9px] text-white/55 uppercase">Tokens 30d</div>
          <div className="font-mono text-[10px] text-[rgba(255,255,255,0.30)] mt-0.5">{usage.estimated_cost_30d}</div>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-mono text-[10px] text-[rgba(255,255,255,0.30)] uppercase">Daily Calls</span>
          <span className="font-mono text-[10px] text-[rgba(255,255,255,0.64)]">{usage.calls_today} / {usage.daily_limit}</span>
        </div>
        <div className="h-2 bg-white/5 rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${usagePercent}%` }} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className={cn('w-2 h-2 rounded-full', usage.api_key_configured ? 'bg-positive' : 'bg-accent')} />
        <span className="font-mono text-[10px] text-[rgba(255,255,255,0.30)]">
          API Key {usage.api_key_configured ? 'Configured' : 'Not Configured'}
        </span>
      </div>
    </div>
  );
}

export function AgentConfig() {
  const { data: agents, isLoading } = useAgents();
  useAgentConfig(); // Preload config data

  if (isLoading) return <TableLoader rows={6} />;

  return (
    <div className="animate-fade-in space-y-8">
      <h1 className="font-display text-xl font-bold text-[rgba(255,255,255,0.92)]">Agent Configuration</h1>

      {/* Agent Table */}
      <div>
        <SectionLabel className="mb-3">Agent Squadron</SectionLabel>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
          </div>
        ) : agents && agents.length > 0 ? (
          <div className="bg-instrument border border-white/[0.06] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                    {['Agent', 'Status', 'Schedule', 'Last Run', 'Avg Duration', 'Success Rate', 'Outputs 24h', 'Actions'].map((h) => (
                      <th key={h} className="py-2.5 px-4 text-left font-mono text-[9px] font-semibold text-white/55 uppercase tracking-wider">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <AgentRow key={agent.agent_id} agent={agent} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState message="No agents found" />
        )}
      </div>

      {/* API Usage */}
      <ApiUsagePanel />
    </div>
  );
}
