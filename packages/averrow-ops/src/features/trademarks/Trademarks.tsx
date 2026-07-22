// Averrow — Trademarks (cross-brand trademark-misuse overview)
// Peer page to Apps / Dark Web. Lists every brand with trademark assets
// or findings, with confirmed / likely / high-severity counts, and
// deep-links into the brand's detail. Phase 1 data is correlated from
// existing wordmark-misuse signals (social, app-store, domains); Phase 2
// (logo image matching) is documented in docs/TRADEMARK_MONITORING.md.

import { useNavigate } from 'react-router-dom';
import { useTrademarkOverview, type TrademarkOverviewRow } from '@/hooks/useTrademarkMonitor';
import { StatCard, StatGrid, PageHeader, Card } from '@/components/ui';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';

function formatCount(n: number) {
  return n.toLocaleString();
}

function BrandRow({ row, onClick }: { row: TrademarkOverviewRow; onClick: () => void }) {
  const hasFindings = row.findings_total > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-3 flex items-center gap-4 hover:bg-white/5 transition-colors border-b border-white/[0.04] last:border-b-0"
    >
      <div className="flex-1 min-w-0">
        <div className="font-mono text-sm text-[var(--text-primary)] truncate">{row.brand_name}</div>
        <div className="font-mono text-[10px] text-white/50 truncate">{row.domain ?? 'no domain'}</div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {row.findings_confirmed > 0 && (
          <Badge variant="critical">{formatCount(row.findings_confirmed)} confirmed</Badge>
        )}
        {row.findings_likely > 0 && (
          <Badge variant="high">{formatCount(row.findings_likely)} likely</Badge>
        )}
        {row.findings_unknown > 0 && (
          <Badge variant="default">{formatCount(row.findings_unknown)} unknown</Badge>
        )}
        {!hasFindings && <Badge variant="success">Clean</Badge>}
      </div>

      <div className="w-28 flex-shrink-0 text-right font-mono text-[10px] text-white/50">
        {row.assets_active} asset{row.assets_active === 1 ? '' : 's'}
      </div>
    </button>
  );
}

export function Trademarks() {
  const navigate = useNavigate();
  const query = useTrademarkOverview({ limit: 100 });

  const rows = query.data?.data ?? [];
  const totals = query.data?.totals;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trademarks"
        subtitle="Wordmark misuse unified across social, app-store, and domain signals. Logo image-matching is a paid Phase 2 add-on (see docs)."
      />

      {totals && (
        <StatGrid>
          <StatCard label="Brands w/ marks" value={formatCount(totals.brands)} accentColor="var(--blue)" />
          <StatCard
            label="Confirmed"
            value={formatCount(totals.confirmed)}
            accentColor={totals.confirmed > 0 ? 'var(--red)' : 'var(--blue)'}
          />
          <StatCard
            label="Likely"
            value={formatCount(totals.likely)}
            accentColor={totals.likely > 0 ? 'var(--amber)' : 'var(--blue)'}
          />
          <StatCard label="Total findings" value={formatCount(totals.findings)} accentColor="var(--blue)" />
        </StatGrid>
      )}

      {query.isLoading ? (
        <div className="text-center text-white/40 font-mono text-xs py-12">
          Loading trademark overview…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No trademark data yet"
          subtitle="The trademark scanner seeds assets and correlates wordmark misuse for monitored brands on the hourly tick."
          variant="scanning"
        />
      ) : (
        <Card>
          <div className="divide-y divide-white/[0.04]">
            <div className="px-4 py-2 flex items-center gap-4 font-mono text-[9px] uppercase tracking-widest text-white/40 border-b border-white/10">
              <div className="flex-1">Brand</div>
              <div className="flex-shrink-0">Findings</div>
              <div className="w-28 flex-shrink-0 text-right">Assets</div>
            </div>
            {rows.map((row) => (
              <BrandRow key={row.id} row={row} onClick={() => navigate(`/brands/${row.id}`)} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
