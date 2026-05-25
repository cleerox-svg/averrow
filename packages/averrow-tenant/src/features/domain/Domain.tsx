// Domain Monitoring — primary tenant surface.
//
// Shows: headline metrics across all brands, per-brand summary
// cards with severity counts, drill-down link per brand. The
// drill-down page is `BrandDomainFindings.tsx` — same module,
// different route.
//
// Per `eager-moseying-papert.md` Phase B sprint 1.

import { Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, ShieldCheck, FileSearch } from 'lucide-react';
import { useDomainModuleSummary, type DomainBrandSummary } from '@/lib/domainModule';

export function Domain() {
  const { data, isLoading, error } = useDomainModuleSummary();

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO OVERVIEW
      </Link>

      <header>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-[28px] font-bold text-white tracking-tight">Domain Monitoring</h1>
          <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-amber bg-amber/[0.10] border border-amber/[0.20] rounded px-2 py-1">
            Active
          </span>
        </div>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Malicious domains and URLs, lookalike domains, and Certificate Transparency activity targeting your brands.
        </p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading findings…</div>}
      {error && <ErrorState error={error.message} />}

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
  totals,
  brandCount,
}: {
  totals: ReturnType<typeof useDomainModuleSummary>['data'] extends infer T
    ? T extends { totals: infer X } ? X : never
    : never;
  brandCount: number;
}) {
  const cards = [
    {
      label: 'Malicious domains & URLs',
      value: totals.malicious_threats_total,
      sub: `across ${brandCount} brand${brandCount === 1 ? '' : 's'} monitored`,
      icon: ShieldCheck,
      tone: totals.malicious_threats_total > 0 ? 'warn' as const : 'neutral' as const,
    },
    {
      label: 'Lookalikes registered',
      value: totals.lookalikes_registered,
      sub: `of ${totals.lookalikes_total} permutations tracked`,
      icon: AlertTriangle,
      tone: totals.lookalikes_registered > 0 ? 'warn' as const : 'neutral' as const,
    },
    {
      label: 'High / Critical lookalikes',
      value: totals.lookalikes_critical + totals.lookalikes_high,
      sub: `${totals.lookalikes_critical} critical · ${totals.lookalikes_high} high`,
      icon: AlertTriangle,
      tone: (totals.lookalikes_critical + totals.lookalikes_high) > 0 ? 'crit' as const : 'neutral' as const,
    },
    {
      label: 'Suspicious certificates',
      value: totals.certs_suspicious,
      sub: `${totals.certs_new} awaiting review`,
      icon: FileSearch,
      tone: totals.certs_suspicious > 0 ? 'warn' as const : 'neutral' as const,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        const accent =
          c.tone === 'crit'   ? 'text-sev-critical' :
          c.tone === 'warn'   ? 'text-amber'        :
          'text-white/85';
        return (
          <div key={c.label} className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
              <Icon size={11} />
              <span className="truncate">{c.label}</span>
            </div>
            <div className={`text-3xl font-bold tabular-nums ${accent}`}>{c.value}</div>
            <p className="text-[11px] text-white/40 mt-1 leading-relaxed">{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}

function BrandCard({ brand: b }: { brand: DomainBrandSummary }) {
  const totalFindings = b.lookalikes_total + b.certs_total + b.malicious_threats_total;
  const criticalCount = b.lookalikes_critical;
  const highCount = b.lookalikes_high;
  const tone =
    criticalCount > 0 || b.malicious_threats_total > 0 ? 'border-sev-critical/[0.30]' :
    highCount > 0     ? 'border-amber/[0.30]'        :
    'border-white/[0.06]';

  return (
    <Link
      to={`/modules/domain/brands/${b.brand_id}`}
      className={`block rounded-xl border bg-bg-card p-4 transition-colors hover:border-white/[0.20] ${tone}`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white/90 truncate">{b.brand_name}</div>
          <div className="text-[11px] text-white/45 font-mono mt-0.5 truncate">{b.canonical_domain}</div>
        </div>
        {totalFindings === 0 ? (
          <span className="text-[9px] uppercase tracking-widest font-mono text-white/30 flex-shrink-0">clear</span>
        ) : (
          <span className="text-[9px] uppercase tracking-widest font-mono text-white/55 flex-shrink-0">
            {totalFindings} finding{totalFindings === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 mt-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest font-mono text-white/35 mb-1">Malicious</div>
          <div className="flex items-baseline gap-2">
            <span className={`text-xl font-bold tabular-nums ${b.malicious_threats_total > 0 ? 'text-sev-critical' : 'text-white/90'}`}>
              {b.malicious_threats_total.toLocaleString()}
            </span>
            <span className="text-[10px] text-white/40">active</span>
          </div>
          <div className="text-[10px] text-white/45 mt-0.5">domains &amp; URLs</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest font-mono text-white/35 mb-1">Lookalikes</div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold tabular-nums text-white/90">{b.lookalikes_registered}</span>
            <span className="text-[10px] text-white/40">registered</span>
          </div>
          <div className="text-[10px] text-white/45 mt-0.5">
            {b.lookalikes_critical > 0 && (
              <span className="text-sev-critical">{b.lookalikes_critical} critical · </span>
            )}
            {b.lookalikes_high > 0 && (
              <span className="text-amber">{b.lookalikes_high} high · </span>
            )}
            <span>{b.lookalikes_total} total</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest font-mono text-white/35 mb-1">CT certs</div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold tabular-nums text-white/90">{b.certs_suspicious}</span>
            <span className="text-[10px] text-white/40">suspicious</span>
          </div>
          <div className="text-[10px] text-white/45 mt-0.5">
            {b.certs_malicious > 0 && (
              <span className="text-sev-critical">{b.certs_malicious} malicious · </span>
            )}
            <span>{b.certs_total} total</span>
          </div>
        </div>
      </div>
    </Link>
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

function ErrorState({ error }: { error: string }) {
  return (
    <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
      <h3 className="text-sm font-semibold text-white/90">Couldn't load Domain Monitoring</h3>
      <p className="text-[12px] text-white/55 mt-1">{error}</p>
    </div>
  );
}
