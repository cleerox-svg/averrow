import { useState, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useSpamTrapCampaigns, useSpamTrapDaily } from '@/hooks/useSpamTrap';
import type { SeedCampaign } from '@/hooks/useSpamTrap';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/design-system/components';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const GLASS_CARD: CSSProperties = {
  background: 'rgba(15,23,42,0.50)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.07)',
  boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
};

function StatusBadge({ status }: { status: string }) {
  const s = (status ?? '—').toLowerCase();
  const label = (status ?? '—').toUpperCase();
  if (s === 'active')    return <Badge status="active"   label={label} size="xs" />;
  if (s === 'completed') return <Badge status="healthy"  label={label} size="xs" />;
  return                        <Badge status="inactive" label={label} size="xs" />;
}

function CampaignCard({ campaign }: { campaign: SeedCampaign }) {
  let targetBrands: string[] = [];
  try {
    targetBrands = JSON.parse(campaign.target_brands ?? '[]') as string[];
  } catch { /* empty */ }

  const channels = (campaign.channel ?? '—').split(',').map((c) => c.trim());
  const seedCount = campaign.addresses_seeded ?? 0;
  const catches = campaign.total_catches ?? 0;
  const catchRate = seedCount > 0 ? ((catches / seedCount) * 100).toFixed(1) : '0.0';

  return (
    <div className="rounded-xl p-4 space-y-3" style={GLASS_CARD}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-white">{campaign.name ?? '—'}</span>
        <StatusBadge status={campaign.status ?? 'unknown'} />
      </div>
      <div className="flex items-center gap-4 text-[10px] font-mono text-white/40">
        <span>{seedCount} seeds</span>
        <span>{targetBrands.length} brands</span>
        <span>{channels.join(', ')}</span>
      </div>

      {/* Channel performance table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5">Channel</th>
              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5 text-right">Seeds</th>
              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5 text-right">Catches</th>
              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5 text-right">Rate</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((ch) => (
              <tr key={ch} className="border-b border-white/[0.03]">
                <td className="py-1.5 font-mono text-[11px] text-white/60">{ch}</td>
                <td className="py-1.5 font-mono text-[11px] text-white/50 text-right">{seedCount}</td>
                <td className="py-1.5 font-mono text-[11px] text-white/50 text-right">{catches}</td>
                <td className="py-1.5 font-mono text-[11px] text-[#E5A832] text-right">{catchRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SeedStrategist() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ message?: string; result?: string }>('/api/spam-trap/strategist/run');
      setResult(res.data?.message ?? res.data?.result ?? 'Strategist completed');
    } catch {
      setError('Strategist unavailable');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-xl p-4 space-y-3" style={GLASS_CARD}>
      <div className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)]">
        Seed Strategist
      </div>
      <button
        onClick={run}
        disabled={running}
        className="px-3 py-2 rounded-lg bg-afterburner-muted border border-afterburner-border text-[#E5A832] text-[11px] font-mono hover:bg-afterburner-muted disabled:opacity-40 transition-colors"
      >
        {running ? 'Running…' : 'Run Seed Strategist'}
      </button>
      {result && (
        <div className="text-[10px] font-mono text-white/60 whitespace-pre-wrap">{result}</div>
      )}
      {error && (
        <div className="text-[10px] font-mono text-red-400/80">{error}</div>
      )}
    </div>
  );
}

function CaptureTimeline() {
  const { data: daily, isLoading } = useSpamTrapDaily();

  const chartData = useMemo(() => {
    const days: { date: string; total: number }[] = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const match = (daily ?? []).find((r) => r.date === dateStr);
      days.push({ date: dateStr, total: match?.total ?? 0 });
    }
    return days;
  }, [daily]);

  if (isLoading) {
    return <Skeleton className="h-[120px] w-full rounded-xl" />;
  }

  return (
    <div className="rounded-xl p-4" style={GLASS_CARD}>
      <div className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)] mb-3">
        Capture Timeline (30d)
      </div>
      <div className="h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.2)' }}
              tickFormatter={(v: string) => v.slice(8)}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.2)' }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#0C1525',
                border: '1px solid rgba(0,212,255,0.2)',
                borderRadius: 8,
                fontSize: 10,
                fontFamily: 'JetBrains Mono, monospace',
              }}
              labelStyle={{ color: 'rgba(255,255,255,0.5)' }}
              itemStyle={{ color: '#E5A832' }}
            />
            <Bar dataKey="total" fill="#E5A832" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function CampaignPanel() {
  const { data: campaigns, isLoading, isError, refetch } = useSpamTrapCampaigns();

  if (isError) {
    return (
      <div className="rounded-xl p-4 min-h-[400px] flex flex-col items-center justify-center gap-3" style={GLASS_CARD}>
        <span className="text-white/40 text-sm font-mono">Unable to load campaigns</span>
        <button
          onClick={() => refetch()}
          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-mono text-white/60 transition-colors"
        >
          RETRY
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-4 min-h-[400px] space-y-4" style={GLASS_CARD}>
      <div className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)]">
        Campaign Intelligence
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : (campaigns ?? []).length === 0 ? (
        <div className="flex items-center justify-center h-[200px]">
          <span className="text-white/40 text-sm font-mono">
            No campaigns configured
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          {(campaigns ?? []).map((c, i) => (
            <CampaignCard key={c.id ?? i} campaign={c} />
          ))}
        </div>
      )}

      <SeedStrategist />
      <CaptureTimeline />
    </div>
  );
}
