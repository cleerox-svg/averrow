import { useIntelligenceBriefings, useThreatVolume, useBrandMomentum } from '@/hooks/useTrends';
import type { VolumePoint } from '@/hooks/useTrends';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { AgentAttribution } from '@/components/ui/AgentAttribution';
import { FileText } from 'lucide-react';

const THREAT_TYPES: Array<{ key: keyof Omit<VolumePoint, 'date'>; label: string }> = [
  { key: 'phishing', label: 'Phishing' },
  { key: 'malware_distribution', label: 'Malware' },
  { key: 'malicious_ip', label: 'Malicious IP' },
  { key: 'c2', label: 'C2' },
  { key: 'typosquatting', label: 'Typosquatting' },
  { key: 'credential_harvesting', label: 'Credential Harvesting' },
];

function computeMetrics(volume: VolumePoint[]) {
  if (!volume.length) return null;

  let totalThreats = 0;
  const typeTotals: Record<string, number> = {};

  for (const point of volume) {
    for (const { key } of THREAT_TYPES) {
      const val = point[key] as number;
      totalThreats += val;
      typeTotals[key] = (typeTotals[key] ?? 0) + val;
    }
  }

  // Find dominant threat type
  let topType = THREAT_TYPES[0];
  let topCount = 0;
  for (const t of THREAT_TYPES) {
    if ((typeTotals[t.key] ?? 0) > topCount) {
      topCount = typeTotals[t.key] ?? 0;
      topType = t;
    }
  }

  // Split volume in half to compute trend
  const mid = Math.floor(volume.length / 2);
  const firstHalf = volume.slice(0, mid);
  const secondHalf = volume.slice(mid);

  const sumHalf = (half: VolumePoint[]) =>
    half.reduce((sum, p) => {
      let dayTotal = 0;
      for (const { key } of THREAT_TYPES) dayTotal += p[key] as number;
      return sum + dayTotal;
    }, 0);

  const firstTotal = sumHalf(firstHalf);
  const secondTotal = sumHalf(secondHalf);
  const changePct = firstTotal === 0
    ? (secondTotal > 0 ? 100 : 0)
    : Math.round(((secondTotal - firstTotal) / firstTotal) * 100);

  return { totalThreats, topType, topCount, changePct };
}

interface ExecutiveSummaryProps {
  period: string;
}

export function ExecutiveSummary({ period }: ExecutiveSummaryProps) {
  const { data: briefings, isLoading: briefingsLoading } = useIntelligenceBriefings(1);
  const { data: volume, isLoading: volumeLoading } = useThreatVolume(period);
  const { data: brands, isLoading: brandsLoading } = useBrandMomentum();

  const isLoading = briefingsLoading || volumeLoading || brandsLoading;

  if (isLoading) {
    return (
      <div className="bg-[var(--bg-card)] backdrop-blur-md border border-white/[0.07] rounded-xl p-5">
        <div className="h-3 bg-white/10 rounded w-48 mb-3 animate-pulse" />
        <div className="space-y-2">
          <Skeleton className="h-2 w-full rounded" />
          <Skeleton className="h-2 w-5/6 rounded" />
          <Skeleton className="h-2 w-4/6 rounded" />
        </div>
      </div>
    );
  }

  const latestBriefing = briefings?.[0];
  const metrics = volume ? computeMetrics(volume) : null;

  // Find most at-risk brand
  const topBrand = brands?.length
    ? brands.reduce((max, b) => ((b.this_week ?? 0) > (max.this_week ?? 0) ? b : max), brands[0])
    : null;

  if (!latestBriefing && !metrics) {
    return (
      <EmptyState
        icon={<FileText />}
        title="No intelligence summary available"
        subtitle="Observer generates summaries as threat data accumulates"
        variant="scanning"
        compact
      />
    );
  }

  return (
    <div className="bg-[var(--bg-card)] backdrop-blur-md border border-amber-500/15 rounded-xl p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-white/80 font-semibold text-sm">
            Intelligence Summary
          </h2>
          <p className="text-white/30 text-[10px] font-mono mt-0.5">
            {period.toUpperCase()} period
          </p>
        </div>
        <AgentAttribution agent="Observer" />
      </div>

      {latestBriefing?.summary && (
        <p className="text-white/60 text-sm leading-relaxed mb-4">
          {(() => {
            // Briefings arrive as markdown — strip bold markers so the
            // panel preview doesn't show literal `**` asterisks. Full
            // briefing modal still renders through ReportPanel's parser.
            const plain = latestBriefing.summary
              .replace(/\*\*(.+?)\*\*/g, '$1')
              .replace(/\*(.+?)\*/g, '$1');
            return plain.length > 280 ? plain.slice(0, 280) + '...' : plain;
          })()}
        </p>
      )}

      {/* Key metrics row */}
      {metrics && (
        <div className="flex gap-6 pt-4 border-t border-white/[0.06]">
          <div>
            <p className="font-mono font-bold text-lg" style={{ color: 'var(--text-primary)' }}>
              {metrics.totalThreats.toLocaleString()}
            </p>
            <p className="text-white/30 text-[10px]">Total Threats</p>
          </div>
          <div>
            <p className={`font-mono font-bold text-lg ${
              metrics.changePct > 0 ? 'text-red-400' : metrics.changePct < 0 ? 'text-emerald-400' : 'text-white/60'
            }`}>
              {metrics.changePct > 0 ? '\u2191' : metrics.changePct < 0 ? '\u2193' : '\u2014'}{Math.abs(metrics.changePct)}%
            </p>
            <p className="text-white/30 text-[10px]">Period Trend</p>
          </div>
          <div>
            <p className="font-mono font-bold text-lg" style={{ color: 'var(--amber)' }}>
              {metrics.topType.label}
            </p>
            <p className="text-white/30 text-[10px]">Top Threat Type</p>
          </div>
          {topBrand && (
            <div>
              <p className="font-mono font-bold text-lg" style={{ color: 'var(--text-primary)' }}>
                {topBrand.brand_name}
              </p>
              <p className="text-white/30 text-[10px]">Most Targeted Brand</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
