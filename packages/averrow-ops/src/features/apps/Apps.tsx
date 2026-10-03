// Averrow — Apps (cross-brand app-store impersonation overview)
// Peer page to Brands / Threats / Providers. Lists every monitored
// brand with counts of impersonation / suspicious / legit findings on
// the iOS App Store, and deep-links into each brand's Apps tab.

import { useNavigate } from 'react-router-dom';
import { useAppStoreOverview, type AppStoreOverviewRow } from '@/hooks/useAppStoreMonitor';
import { StatTile, StatGrid, PageHeader, Card, Badge, PageState, pageStateKind } from '@/design-system/components';
import { relativeTime } from '@/lib/time';

function formatCount(n: number) {
  return n.toLocaleString();
}

function BrandRow({ row, onClick }: { row: AppStoreOverviewRow; onClick: () => void }) {
  const hasFindings = row.counts.total > 0;
  const nothingFound = row.counts.total === 0 && row.last_checked != null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-3 flex items-center gap-4 hover:bg-white/5 transition-colors border-b border-white/[0.04] last:border-b-0"
    >
      <div className="flex-1 min-w-0">
        <div className="font-mono text-sm text-[var(--text-primary)] truncate">{row.brand_name}</div>
        <div className="font-mono text-[10px] text-white/50 truncate">
          {row.domain ?? 'no domain'}
          {!row.has_allowlist && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-white/5 text-white/60 border border-white/10 text-[9px] uppercase tracking-widest">
              No allowlist
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {row.counts.impersonation > 0 && (
          <Badge variant="critical">{formatCount(row.counts.impersonation)} impersonation</Badge>
        )}
        {row.counts.suspicious > 0 && (
          <Badge variant="high">{formatCount(row.counts.suspicious)} suspicious</Badge>
        )}
        {row.counts.legitimate + row.counts.official > 0 && (
          <Badge variant="success">{formatCount(row.counts.legitimate + row.counts.official)} legit</Badge>
        )}
        {nothingFound && !hasFindings && (
          <Badge variant="default">Clean</Badge>
        )}
      </div>

      <div className="w-32 flex-shrink-0 text-right font-mono text-[10px] text-white/50">
        {row.last_checked ? relativeTime(row.last_checked) : 'Never scanned'}
      </div>
    </button>
  );
}

export function Apps() {
  const navigate = useNavigate();
  const query = useAppStoreOverview({ limit: 100 });

  const rows = query.data?.data ?? [];
  const totals = query.data?.totals;
  // Error beats loading beats empty. A failed refetch with the last good rows
  // still on screen keeps them and shows an inline error instead.
  const listKind = pageStateKind({
    isLoading: query.isLoading,
    isError: query.isError && !query.data,
    isEmpty: rows.length === 0,
  });

  const goToBrand = (brandId: string) => {
    navigate(`/brands/${brandId}?tab=apps`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apps"
        subtitle="iOS App Store impersonation monitoring across every monitored brand."
      />

      {totals && (
        <StatGrid>
          <StatTile
            label="Total Listings"
            value={formatCount(totals.total)}
            accent="var(--blue)"
          />
          <StatTile
            label="Impersonation"
            value={formatCount(totals.impersonation)}
            accent={totals.impersonation > 0 ? 'var(--red)' : 'var(--blue)'}
          />
          <StatTile
            label="Suspicious"
            value={formatCount(totals.suspicious)}
            accent={totals.suspicious > 0 ? 'var(--amber)' : 'var(--blue)'}
          />
          <StatTile
            label="Legit / Official"
            value={formatCount(totals.legitimate + totals.official)}
            accent="var(--green)"
          />
        </StatGrid>
      )}

      {query.isError && query.data && (
        <PageState kind="error" layout="inline" title="Couldn't refresh apps" description="Showing the last loaded data." onRetry={() => { void query.refetch(); }} />
      )}

      {listKind === 'loading' ? (
        <PageState kind="loading" layout="card" title="Loading app-store overview…" />
      ) : listKind === 'error' ? (
        <PageState kind="error" layout="card" title="Couldn't load app-store overview" onRetry={() => { void query.refetch(); }} />
      ) : listKind === 'empty' ? (
        <PageState
          kind="empty"
          layout="card"
          title="No monitored brands yet"
          description="Add brands to monitored_brands to start scanning the iOS App Store for impersonations."
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
