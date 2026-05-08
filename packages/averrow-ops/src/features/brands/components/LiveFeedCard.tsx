import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { severityColor } from '@/lib/severityColor';
import { LiveIndicator } from '@/components/ui/LiveIndicator';

interface RecentThreat {
  id: string;
  threat_type: string;
  severity: string;
  source_feed: string;
  malicious_domain?: string;
  ip_address?: string;
  country_code?: string;
  created_at: string;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const SEVERITY_SCORE: Record<string, number> = {
  critical: 10,
  high: 30,
  medium: 50,
  low: 70,
  info: 90,
};

export function LiveFeedCard() {
  const { data: threats } = useQuery({
    queryKey: ['threats', 'recent'],
    queryFn: async () => {
      const res = await api.get<RecentThreat[]>('/api/threats/recent?limit=8');
      return res.data ?? [];
    },
    refetchInterval: 30000,
  });

  const items = threats ?? [];

  return (
    <div className="p-4" style={{ background:'rgba(15,23,42,0.50)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:'0.75rem', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)' }}>
      <div className="mb-3">
        <LiveIndicator label="LIVE FEED" size="xs" />
      </div>

      {items.length === 0 ? (
        <p className="text-[11px] text-white/40">No recent activity</p>
      ) : (
        <div className="flex flex-col">
          {items.map((t) => {
            const score = SEVERITY_SCORE[t.severity?.toLowerCase()] ?? 50;
            const dotColor = severityColor(score);
            const identifier = t.malicious_domain || t.ip_address || '';
            const displayType = (t.threat_type ?? '').replace(/_/g, ' ');
            return (
              <div
                key={t.id}
                className="flex items-center gap-2 border-b border-white/[0.05] py-1.5 last:border-b-0"
              >
                <span
                  className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                />
                <span className="flex-shrink-0 font-mono text-[9px]" style={{ color: dotColor }}>
                  {displayType}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-white/60">
                  {identifier.length > 25 ? identifier.slice(0, 25) + '…' : identifier}
                </span>
                {t.country_code && (
                  <span className="flex-shrink-0 font-mono text-[9px] text-white/40">
                    {t.country_code}
                  </span>
                )}
                <span className="flex-shrink-0 font-mono text-[9px] text-white/50">
                  {timeAgo(t.created_at)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <Link
        to="/contacts"
        className="mt-3 block text-[10px] transition-colors hover:text-white"
        style={{ color: 'var(--amber)' }}
      >
        View all in Observatory →
      </Link>
    </div>
  );
}
