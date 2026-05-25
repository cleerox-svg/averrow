// Threats — org-wide threat records browser.
//
// Built on the shared <ThreatsTable> (@averrow/shared/threats-table) so it
// is identical to the ops view; only the data differs (this org's brands,
// curated columns). Server-side filter/sort/search/pagination. Rows expand
// to an evidence/TTP detail drawer. Reads ?brand= for deep-links.

import { Link, useSearchParams } from 'react-router-dom';
import { ShieldAlert, AlertTriangle, Globe } from 'lucide-react';
import { ThreatsTable, useThreatsTable, type ThreatsTableState } from '@averrow/shared/threats-table';
import { useTenantThreats, type ThreatsResponse } from '@/lib/threats';
import { useTenantDashboard } from '@/lib/dashboard';

const SORT_KEYS = {
  brand: 'brand', type: 'type', target: 'target', severity: 'severity',
  status: 'status', source: 'source', last_seen: 'last_seen',
} as const;

export function Threats() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: dashboard } = useTenantDashboard();
  const table = useThreatsTable({ pageSize: 50, initial: { brandId: searchParams.get('brand') ?? '' } });
  const { data, isLoading, error } = useTenantThreats(table.params);

  const brands = (dashboard?.brands ?? []).map((b) => ({ value: b.id, label: b.name }));

  // Keep ?brand in the URL in sync so the view is shareable / matches the
  // Overview deep-link.
  const onFilter = (patch: Partial<ThreatsTableState>) => {
    table.setFilter(patch);
    if ('brandId' in patch) {
      const next = new URLSearchParams(searchParams);
      if (patch.brandId) next.set('brand', patch.brandId); else next.delete('brand');
      setSearchParams(next, { replace: true });
    }
  };

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        ← BACK TO OVERVIEW
      </Link>

      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Threats</h1>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Every malicious domain, URL, and host attributed to your brands. Click a row for the evidence behind the verdict.
        </p>
      </header>

      {data && <StatRow data={data} />}

      <ThreatsTable
        columns={['brand', 'type', 'target', 'severity', 'status', 'source', 'evidence', 'last_seen']}
        rows={data?.threats ?? []}
        total={data?.total ?? 0}
        loading={isLoading}
        error={error ? error.message : null}
        state={table.state}
        pageSize={table.pageSize}
        onFilter={onFilter}
        onSearch={table.setSearch}
        onToggleSort={table.toggleSort}
        onPage={table.setPage}
        controls={['brand', 'severity', 'type', 'status', 'search']}
        brands={brands}
        sortKeys={SORT_KEYS}
      />
    </div>
  );
}

function StatRow({ data }: { data: ThreatsResponse }) {
  const sev = (s: string) => data.severity_breakdown.find((b) => b.severity === s)?.count ?? 0;
  const cards: Array<{ label: string; value: number; tone: 'crit' | 'warn' | 'neutral'; icon: typeof ShieldAlert }> = [
    { label: 'Matching threats', value: data.total, tone: data.total > 0 ? 'warn' : 'neutral', icon: ShieldAlert },
    { label: 'Critical', value: sev('critical'), tone: sev('critical') > 0 ? 'crit' : 'neutral', icon: AlertTriangle },
    { label: 'High', value: sev('high'), tone: sev('high') > 0 ? 'warn' : 'neutral', icon: AlertTriangle },
    { label: 'Types seen', value: data.type_breakdown.length, tone: 'neutral', icon: Globe },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        const accent = c.tone === 'crit' ? 'text-sev-critical' : c.tone === 'warn' ? 'text-amber' : 'text-white/85';
        return (
          <div key={c.label} className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
              <Icon size={11} /><span className="truncate">{c.label}</span>
            </div>
            <div className={`text-3xl font-bold tabular-nums ${accent}`}>{c.value.toLocaleString()}</div>
          </div>
        );
      })}
    </div>
  );
}
