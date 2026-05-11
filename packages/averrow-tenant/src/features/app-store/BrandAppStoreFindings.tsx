// App Store Impersonation — per-brand drill-down.
//
// Lists app_store_listings rows for one brand with classification +
// severity pills, store badge, developer name, rating.
//
// Phase B sprint 4.

import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Star } from 'lucide-react';
import {
  useBrandAppStoreFindings,
  useAppStoreModuleSummary,
  STORE_LABELS,
  type AppStoreListingRow,
} from '@/lib/appStoreModule';

export function BrandAppStoreFindings() {
  const { brandId } = useParams<{ brandId: string }>();
  const { data: summary } = useAppStoreModuleSummary();
  const { data, isLoading, error } = useBrandAppStoreFindings(brandId ?? null);

  const brand = summary?.brands.find((b) => b.brand_id === brandId);

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/modules/app-store" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO APP STORE
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">App Store Impersonation · Brand</div>
        <h1 className="text-[28px] font-bold text-white tracking-tight">{brand?.brand_name ?? brandId}</h1>
        <p className="mt-1 text-sm text-white/55 font-mono">{brand?.canonical_domain ?? ''}</p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading apps…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load apps</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        data.listings.length === 0 ? (
          <EmptyState />
        ) : (
          <ListingsSection rows={data.listings} />
        )
      )}
    </div>
  );
}

function ListingsSection({ rows }: { rows: AppStoreListingRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
        Apps <span className="text-white/30">({rows.length})</span>
      </h2>
      <div className="space-y-2">
        {rows.map((l) => <ListingRow key={l.id} listing={l} />)}
      </div>
    </section>
  );
}

function ListingRow({ listing: l }: { listing: AppStoreListingRow }) {
  const tone =
    l.classification === 'impersonation' ? 'border-sev-critical/[0.30]' :
    l.classification === 'suspicious'    ? 'border-amber/[0.30]'        :
                                           'border-white/[0.06]';
  return (
    <article className={`rounded-xl border bg-bg-card p-4 ${tone}`}>
      <div className="flex items-start gap-3">
        <Icon src={l.icon_url} fallback={l.app_name?.[0] ?? '?'} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <StoreChip store={l.store} />
            <SeverityPill level={l.severity} />
            <ClassificationPill classification={l.classification} />
          </div>
          <div className="text-sm font-semibold text-white/90 truncate">{l.app_name}</div>
          {l.developer_name && (
            <div className="text-[12px] text-white/55 mt-0.5">by {l.developer_name}</div>
          )}
          {l.classification_reason && (
            <p className="text-[11px] text-white/40 mt-2 italic">{l.classification_reason}</p>
          )}
          <div className="flex items-center gap-3 mt-2 text-[11px] font-mono text-white/40">
            {l.bundle_id && (
              <span className="truncate max-w-[260px]">id: {l.bundle_id}</span>
            )}
            {l.rating !== null && l.rating > 0 && (
              <span className="inline-flex items-center gap-1">
                <Star size={11} className="fill-amber text-amber" />
                {l.rating.toFixed(1)}
                {l.rating_count !== null && l.rating_count > 0 && (
                  <span className="text-white/35">({formatCount(l.rating_count)})</span>
                )}
              </span>
            )}
            {l.impersonation_score > 0 && (
              <span className="text-amber/70">score {Math.round(l.impersonation_score * 100)}%</span>
            )}
            {l.app_url && (
              <a
                href={l.app_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-amber hover:underline"
              >
                <ExternalLink size={11} /> open
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function Icon({ src, fallback }: { src: string | null; fallback: string }) {
  return src ? (
    <img src={src} alt="" className="w-12 h-12 rounded-lg bg-white/10 border border-white/10 object-cover flex-shrink-0" />
  ) : (
    <div className="w-12 h-12 rounded-lg bg-white/10 border border-white/10 flex items-center justify-center text-base font-bold text-white/70 flex-shrink-0">
      {fallback.toUpperCase()}
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function StoreChip({ store }: { store: string }) {
  return (
    <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
      {STORE_LABELS[store] ?? store}
    </span>
  );
}

function SeverityPill({ level }: { level: string }) {
  const sev = (level ?? '').toLowerCase();
  const tone =
    sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    sev === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    sev === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                         'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {level}
    </span>
  );
}

function ClassificationPill({ classification }: { classification: string }) {
  const tone =
    classification === 'impersonation' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    classification === 'suspicious'    ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    classification === 'official'      ? 'text-white/70     bg-white/[0.06]        border-white/[0.10]'        :
    classification === 'legitimate'    ? 'text-white/55     bg-white/[0.04]        border-white/[0.08]'        :
                                         'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {classification}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">No apps tracked for this brand yet.</p>
      <p className="text-white/35 text-xs mt-1">Listings appear as the app store monitor finds them across stores.</p>
    </div>
  );
}
