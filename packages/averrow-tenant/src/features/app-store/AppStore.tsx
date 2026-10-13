// App Store Impersonation — primary tenant surface.
//
// Per-brand grid showing classification rollups across stores
// (iOS, Google Play, alternative stores). Drill-down lists app
// listings by severity → classification.
//
// Phase B sprint 4.

import { Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, ShieldCheck, Smartphone, type LucideIcon } from 'lucide-react';
import {
  useAppStoreModuleSummary,
  type AppStoreBrandSummary,
  type AppStoreModuleTotals,
} from '@/lib/appStoreModule';

export function AppStore() {
  const { data, isLoading, error } = useAppStoreModuleSummary();

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/55 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO OVERVIEW
      </Link>

      <header>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-[28px] font-bold text-[var(--text-primary)] tracking-tight">App Store Impersonation</h1>
          <span className="inline-flex items-center text-[11px] uppercase tracking-widest font-mono text-amber bg-amber/[0.10] border border-amber/[0.20] rounded px-2 py-1">
            Active
          </span>
        </div>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Fake apps across iOS, Google Play, and alternative stores like APKPure, Aptoide, Samsung Galaxy, and Huawei AppGallery.
        </p>
      </header>

      {isLoading && <div className="text-white/55 text-sm font-mono py-12 text-center">Loading findings…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load App Store Monitoring</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          <HeadlineMetrics totals={data.totals} brandCount={data.brands.length} />
          <section>
            <h2 className="text-[11px] uppercase tracking-[0.12em] font-mono text-white/55 mb-3">Per brand</h2>
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
  totals: AppStoreModuleTotals;
  brandCount: number;
}) {
  const cards: Array<{
    label: string; value: number; sub: string;
    icon: LucideIcon; tone: 'crit' | 'warn' | 'neutral';
  }> = [
    {
      label: 'Brands monitored',
      value: brandCount,
      sub: `${totals.apps_total} apps tracked`,
      icon: ShieldCheck,
      tone: 'neutral',
    },
    {
      label: 'Impersonation apps',
      value: totals.apps_impersonation,
      sub: `${totals.apps_suspicious} suspicious`,
      icon: AlertTriangle,
      tone: totals.apps_impersonation > 0 ? 'crit' : 'neutral',
    },
    {
      label: 'High / Critical',
      value: totals.apps_high_critical,
      sub: 'severity-flagged listings',
      icon: AlertTriangle,
      tone: totals.apps_high_critical > 0 ? 'warn' : 'neutral',
    },
    {
      label: 'Official + legitimate',
      value: totals.apps_official + totals.apps_legitimate,
      sub: 'verified or allowlisted',
      icon: Smartphone,
      tone: 'neutral',
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
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest font-mono text-white/55 mb-1">
              <Icon size={11} /><span className="truncate">{c.label}</span>
            </div>
            <div className={`text-3xl font-bold tabular-nums ${accent}`}>{c.value}</div>
            <p className="text-[11px] text-white/55 mt-1 leading-relaxed">{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}

function BrandCard({ brand: b }: { brand: AppStoreBrandSummary }) {
  const tone =
    b.apps_impersonation > 0 ? 'border-sev-critical/[0.30]' :
    b.apps_suspicious   > 0  ? 'border-amber/[0.30]'        :
    'border-white/[0.06]';
  return (
    <Link
      to={`/modules/app-store/brands/${b.brand_id}`}
      className={`block rounded-xl border bg-bg-card p-4 transition-colors hover:border-white/[0.20] ${tone}`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white/90 truncate">{b.brand_name}</div>
          <div className="text-[11px] text-white/55 font-mono mt-0.5 truncate">{b.canonical_domain}</div>
        </div>
        {b.apps_total === 0 ? (
          <span className="text-[11px] uppercase tracking-widest font-mono text-white/55 flex-shrink-0">no apps tracked</span>
        ) : (
          <span className="text-[11px] uppercase tracking-widest font-mono text-white/55 flex-shrink-0">
            {b.apps_total} app{b.apps_total === 1 ? '' : 's'} · {b.stores_covered} store{b.stores_covered === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        <ClassChip label="impersonation" count={b.apps_impersonation} tone="crit" />
        <ClassChip label="suspicious"    count={b.apps_suspicious}    tone="warn" />
        <ClassChip label="official"      count={b.apps_official}      tone="ok" />
      </div>
    </Link>
  );
}

function ClassChip({
  label, count, tone,
}: {
  label: string; count: number;
  tone: 'crit' | 'warn' | 'ok';
}) {
  const accent =
    count === 0     ? 'text-white/55'     :
    tone === 'crit' ? 'text-sev-critical' :
    tone === 'warn' ? 'text-amber'        :
                      'text-white/85';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest font-mono text-white/55 mb-0.5">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${accent}`}>{count}</div>
    </div>
  );
}

function NoBrands() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">No brands assigned to your organization yet.</p>
      <p className="text-white/55 text-xs mt-1">
        Contact <a className="text-amber hover:underline" href="mailto:support@averrow.com">support@averrow.com</a> to add a brand.
      </p>
    </div>
  );
}
