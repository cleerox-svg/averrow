// Trademark Infringement — primary tenant surface.
//
// Per-brand grid showing registered assets count + findings rollup
// across contexts (website, social, app store, marketplace).
// Drill-down lists assets + findings with side-by-side image
// comparison.
//
// Phase B sprint 7.

import { Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, ShieldCheck, Image as ImageIcon, Search, type LucideIcon } from 'lucide-react';
import {
  useTrademarkModuleSummary,
  type TrademarkBrandSummary,
  type TrademarkModuleTotals,
} from '@/lib/trademarkModule';

export function Trademark() {
  const { data, isLoading, error } = useTrademarkModuleSummary();

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO OVERVIEW
      </Link>

      <header>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-[28px] font-bold text-white tracking-tight">Trademark Infringement</h1>
          <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-amber bg-amber/[0.10] border border-amber/[0.20] rounded px-2 py-1">
            Active
          </span>
        </div>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Logo, wordmark, and combined-mark uses across third-party websites, social profiles, app icons, and marketplaces. Image-hash matching with vision-LLM verification.
        </p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading findings…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load Trademark Infringement</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          <HeadlineMetrics totals={data.totals} brandCount={data.brands.length} />
          <section>
            <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">Per brand</h2>
            {data.brands.length === 0 ? (
              <NoBrands />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {data.brands.map((b) => <BrandCard key={b.brand_id} brand={b} />)}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function HeadlineMetrics({
  totals, brandCount,
}: {
  totals: TrademarkModuleTotals;
  brandCount: number;
}) {
  const cards: Array<{
    label: string; value: number; sub: string;
    icon: LucideIcon; tone: 'crit' | 'warn' | 'neutral';
  }> = [
    {
      label: 'Brands monitored',
      value: brandCount,
      sub: `${totals.assets_active} assets registered`,
      icon: ShieldCheck,
      tone: 'neutral',
    },
    {
      label: 'Confirmed infringements',
      value: totals.findings_confirmed,
      sub: `${totals.findings_likely} likely`,
      icon: AlertTriangle,
      tone: totals.findings_confirmed > 0 ? 'crit' : 'neutral',
    },
    {
      label: 'High / Critical',
      value: totals.findings_high_critical,
      sub: 'severity-flagged findings',
      icon: AlertTriangle,
      tone: totals.findings_high_critical > 0 ? 'warn' : 'neutral',
    },
    {
      label: 'Awaiting review',
      value: totals.findings_unknown,
      sub: 'pending classification',
      icon: Search,
      tone: totals.findings_unknown > 0 ? 'warn' : 'neutral',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        const accent =
          c.tone === 'crit' ? 'text-sev-critical' :
          c.tone === 'warn' ? 'text-amber'        :
                              'text-white/85';
        return (
          <div key={c.label} className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
              <Icon size={11} /><span className="truncate">{c.label}</span>
            </div>
            <div className={`text-3xl font-bold tabular-nums ${accent}`}>{c.value}</div>
            <p className="text-[11px] text-white/40 mt-1 leading-relaxed">{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}

function BrandCard({ brand: b }: { brand: TrademarkBrandSummary }) {
  const tone =
    b.findings_confirmed > 0 ? 'border-sev-critical/[0.30]' :
    b.findings_likely    > 0 ? 'border-amber/[0.30]'        :
    'border-white/[0.06]';
  const noAssets = b.assets_active === 0;
  return (
    <Link
      to={`/modules/trademark/brands/${b.brand_id}`}
      className={`block rounded-xl border bg-bg-card p-4 transition-colors hover:border-white/[0.20] ${tone}`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white/90 truncate">{b.brand_name}</div>
          <div className="text-[11px] text-white/45 font-mono mt-0.5 truncate">{b.canonical_domain}</div>
        </div>
        {noAssets ? (
          <span className="text-[9px] uppercase tracking-widest font-mono text-amber/80 flex-shrink-0">no assets uploaded</span>
        ) : (
          <span className="text-[9px] uppercase tracking-widest font-mono text-white/55 flex-shrink-0">
            {b.assets_active} asset{b.assets_active === 1 ? '' : 's'} · {b.findings_total} finding{b.findings_total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {noAssets ? (
        <p className="text-[12px] text-white/45 mt-2">
          Upload a logo or wordmark to start scanning. <span className="inline-flex items-center gap-1 text-amber"><ImageIcon size={11} /> add asset</span>
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 mt-3">
          <ClassChip label="confirmed" count={b.findings_confirmed} tone="crit" />
          <ClassChip label="likely"    count={b.findings_likely}    tone="warn" />
          <ClassChip label="unknown"   count={b.findings_unknown}   tone="neutral" />
        </div>
      )}
    </Link>
  );
}

function ClassChip({
  label, count, tone,
}: {
  label: string; count: number;
  tone: 'crit' | 'warn' | 'neutral';
}) {
  const accent =
    count === 0     ? 'text-white/35'     :
    tone === 'crit' ? 'text-sev-critical' :
    tone === 'warn' ? 'text-amber'        :
                      'text-white/85';
  return (
    <div>
      <div className="text-[8px] uppercase tracking-widest font-mono text-white/35 mb-0.5">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${accent}`}>{count}</div>
    </div>
  );
}

function NoBrands() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">No brands assigned to your organization yet.</p>
      <p className="text-white/35 text-xs mt-1">
        Contact <a className="text-amber hover:underline" href="mailto:support@averrow.com">support@averrow.com</a> to add a brand.
      </p>
    </div>
  );
}
