// Averrow — Dark Web (cross-brand paste-archive mention overview)
// Peer page to Brands / Apps / Providers. Lists every monitored brand
// with counts of confirmed / suspicious dark-web mentions found in
// paste archives (PSBDMP for now; Telegram / HIBP / Flare land in
// later slices without touching this UI).

import { useNavigate } from 'react-router-dom';
import { useDarkWebOverview, type DarkWebOverviewRow } from '@/hooks/useDarkWebMonitor';
import { StatCard, StatGrid, PageHeader, Card } from '@/components/ui';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { relativeTime } from '@/lib/time';

function formatCount(n: number) {
  return n.toLocaleString();
}

function BrandRow({ row, onClick }: { row: DarkWebOverviewRow; onClick: () => void }) {
  const hasFindings = row.counts.total > 0;
  const nothingFound = row.counts.total === 0 && row.last_checked != null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-3 flex items-center gap-4 hover:bg-white/5 transition-colors border-b border-white/[0.04] last:border-b-0"
    >
      <div className="flex-1 min-w-0">
        <div className="font-mono text-sm text-instrument-white truncate">{row.brand_name}</div>
        <div className="font-mono text-[10px] text-white/50 truncate">
          {row.domain ?? 'no domain'}
          {!row.has_executives && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-white/5 text-white/60 border border-white/10 text-[9px] uppercase tracking-widest">
              No execs set
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {row.counts.critical > 0 && (
          <Badge variant="critical">{formatCount(row.counts.critical)} critical</Badge>
        )}
        {row.counts.high > 0 && (
          <Badge variant="high">{formatCount(row.counts.high)} high</Badge>
        )}
        {row.counts.confirmed > 0 && row.counts.critical === 0 && row.counts.high === 0 && (
          <Badge variant="critical">{formatCount(row.counts.confirmed)} confirmed</Badge>
        )}
        {row.counts.suspicious > 0 && (
          <Badge variant="high">{formatCount(row.counts.suspicious)} suspicious</Badge>
        )}
        {nothingFound && !hasFindings && <Badge variant="default">Clean</Badge>}
      </div>

      <div className="w-32 flex-shrink-0 text-right font-mono text-[10px] text-white/50">
        {row.last_checked ? relativeTime(row.last_checked) : 'Never scanned'}
      </div>
    </button>
  );
}

export function DarkWeb() {
  const navigate = useNavigate();
  const query = useDarkWebOverview({ limit: 100 });

  const rows = query.data?.data ?? [];
  const totals = query.data?.totals;

  const goToBrand = (brandId: string) => {
    navigate(`/brands/${brandId}?tab=dark-web`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dark Web"
        subtitle="Paste-archive mention monitoring across every monitored brand. Telegram / HIBP / commercial sources land in later releases."
      />

      {totals && (
        <StatGrid>
          <StatCard
            label="Total Mentions"
            value={formatCount(totals.total)}
            accentColor="var(--red)"
          />
          <StatCard
            label="Confirmed"
            value={formatCount(totals.confirmed)}
            accentColor={totals.confirmed > 0 ? 'var(--red)' : 'var(--blue)'}
          />
          <StatCard
            label="Critical / High"
            value={formatCount(totals.critical + totals.high)}
            accentColor={totals.critical + totals.high > 0 ? 'var(--red)' : 'var(--blue)'}
          />
          <StatCard
            label="Suspicious"
            value={formatCount(totals.suspicious)}
            accentColor={totals.suspicious > 0 ? 'var(--amber)' : 'var(--blue)'}
          />
        </StatGrid>
      )}

      {query.isLoading ? (
        <div className="text-center text-white/40 font-mono text-xs py-12">
          Loading dark-web overview…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No monitored brands yet"
          subtitle="Add brands to monitored_brands to start scanning paste archives for mentions."
          variant="scanning"
        />
      ) : (
        <Card>
          <div className="divide-y divide-white/[0.04]">
            <div className="px-4 py-2 flex items-center gap-4 font-mono text-[9px] uppercase tracking-widest text-white/40 border-b border-white/10">
              <div className="flex-1">Brand</div>
              <div className="flex-shrink-0">Findings</div>
              <div className="w-32 flex-shrink-0 text-right">Last Scan</div>
            </div>
            {rows.map((row) => (
              <BrandRow key={row.id} row={row} onClick={() => goToBrand(row.id)} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
