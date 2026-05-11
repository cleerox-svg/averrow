// Trademark Infringement — per-brand drill-down.
//
// Shows registered assets at the top + a finding-by-finding list
// below with side-by-side image comparison (asset vs. found image)
// and a Hamming-distance / confidence indicator.
//
// Phase B sprint 7.

import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Image as ImageIcon } from 'lucide-react';
import {
  useBrandTrademarkFindings,
  useTrademarkModuleSummary,
  ASSET_TYPE_LABELS,
  CONTEXT_LABELS,
  type TrademarkAssetRow,
  type TrademarkFindingRow,
} from '@/lib/trademarkModule';

export function BrandTrademarkFindings() {
  const { brandId } = useParams<{ brandId: string }>();
  const { data: summary } = useTrademarkModuleSummary();
  const { data, isLoading, error } = useBrandTrademarkFindings(brandId ?? null);

  const brand = summary?.brands.find((b) => b.brand_id === brandId);

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/modules/trademark" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO TRADEMARK
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Trademark Infringement · Brand</div>
        <h1 className="text-[28px] font-bold text-white tracking-tight">{brand?.brand_name ?? brandId}</h1>
        <p className="mt-1 text-sm text-white/55 font-mono">{brand?.canonical_domain ?? ''}</p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading findings…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load findings</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          <AssetsSection assets={data.assets} />
          {data.findings.length === 0 ? (
            <EmptyFindings hasAssets={data.assets.length > 0} />
          ) : (
            <FindingsSection findings={data.findings} assets={data.assets} />
          )}
        </>
      )}
    </div>
  );
}

function AssetsSection({ assets }: { assets: TrademarkAssetRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
        Registered assets <span className="text-white/30">({assets.length})</span>
      </h2>
      {assets.length === 0 ? (
        <div className="rounded-xl border border-amber/[0.30] bg-amber/[0.06] p-6 text-center">
          <ImageIcon className="inline" size={20} />
          <p className="text-white/75 text-sm mt-2">No registered assets for this brand yet.</p>
          <p className="text-white/45 text-xs mt-1">Upload a logo or wordmark to start scanning. The scanner uses pHash + vision-LLM verification to find lookalike uses.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {assets.map((a) => <AssetCard key={a.id} asset={a} />)}
        </div>
      )}
    </section>
  );
}

function AssetCard({ asset: a }: { asset: TrademarkAssetRow }) {
  return (
    <article className="rounded-xl border border-white/[0.06] bg-bg-card p-3">
      <div className="flex items-start gap-3">
        <AssetImage src={a.asset_url} fallback={a.asset_name?.[0] ?? '?'} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
              {ASSET_TYPE_LABELS[a.asset_type] ?? a.asset_type}
            </span>
          </div>
          <div className="text-sm font-semibold text-white/90 truncate">{a.asset_name ?? '(unnamed)'}</div>
          {(a.registration_country ?? a.registration_number) && (
            <div className="text-[11px] text-white/45 font-mono mt-1">
              {a.registration_country && <span>{a.registration_country} </span>}
              {a.registration_number && <span>· {a.registration_number}</span>}
            </div>
          )}
          {a.phash && (
            <div className="text-[10px] text-white/35 font-mono mt-1">phash {a.phash.slice(0, 8)}…</div>
          )}
        </div>
      </div>
    </article>
  );
}

function FindingsSection({
  findings, assets,
}: {
  findings: TrademarkFindingRow[];
  assets:   TrademarkAssetRow[];
}) {
  const assetById = new Map(assets.map((a) => [a.id, a]));
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
        Findings <span className="text-white/30">({findings.length})</span>
      </h2>
      <div className="space-y-2">
        {findings.map((f) => (
          <FindingRow
            key={f.id}
            finding={f}
            asset={f.asset_id ? assetById.get(f.asset_id) ?? null : null}
          />
        ))}
      </div>
    </section>
  );
}

function FindingRow({
  finding: f, asset: a,
}: {
  finding: TrademarkFindingRow;
  asset:   TrademarkAssetRow | null;
}) {
  const tone =
    f.classification === 'confirmed' ? 'border-sev-critical/[0.30]' :
    f.classification === 'likely'    ? 'border-amber/[0.30]'        :
                                       'border-white/[0.06]';
  const conf = f.match_confidence ?? null;
  const dist = f.match_distance ?? null;

  return (
    <article className={`rounded-xl border bg-bg-card p-4 ${tone}`}>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <SeverityPill level={f.severity} />
        <ClassificationPill classification={f.classification} />
        {f.found_context && <ContextChip context={f.found_context} />}
        {conf !== null && (
          <span className="text-[10px] uppercase tracking-widest font-mono text-white/45">
            match {Math.round(conf * 100)}%
            {dist !== null && <span className="text-white/30"> · dist {dist}</span>}
          </span>
        )}
      </div>

      <div className="flex items-start gap-3">
        <ImagePair source={a?.asset_url ?? null} found={f.found_image_url} />

        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white/90 truncate">
            {a?.asset_name ?? 'Unmatched asset'}
          </div>
          <div className="text-[11px] text-white/45 font-mono mt-0.5 truncate">
            <a href={f.found_url} target="_blank" rel="noopener noreferrer" className="hover:text-amber">
              {f.found_url}
            </a>
          </div>
          {f.classification_reason && (
            <p className="text-[11px] text-white/40 mt-2 italic">{f.classification_reason}</p>
          )}
          <div className="flex items-center gap-3 mt-2 text-[11px] font-mono text-white/40">
            <span>{formatDate(f.last_seen ?? f.first_seen)}</span>
            {f.ai_action && f.ai_action !== 'safe' && (
              <span className={f.ai_action === 'escalate' ? 'text-sev-critical' : 'text-amber'}>
                ai: {f.ai_action}
              </span>
            )}
            {f.found_url && (
              <a
                href={f.found_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-amber hover:underline ml-auto"
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

function ImagePair({ source, found }: { source: string | null; found: string | null }) {
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      <AssetImage src={source} fallback="A" small />
      <span className="text-white/30 text-xs font-mono">vs</span>
      <AssetImage src={found} fallback="?" small />
    </div>
  );
}

function AssetImage({ src, fallback, small }: { src: string | null; fallback: string; small?: boolean }) {
  const dim = small ? 'w-10 h-10' : 'w-14 h-14';
  return src ? (
    <img src={src} alt="" className={`${dim} rounded-lg bg-white/10 border border-white/10 object-contain`} />
  ) : (
    <div className={`${dim} rounded-lg bg-white/10 border border-white/10 flex items-center justify-center text-base font-bold text-white/70`}>
      {fallback.toUpperCase()}
    </div>
  );
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ContextChip({ context }: { context: string }) {
  return (
    <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-blue/85 bg-blue/[0.06] border border-blue/[0.15] rounded px-1.5 py-0.5">
      {CONTEXT_LABELS[context] ?? context}
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
    classification === 'confirmed'      ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    classification === 'likely'         ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    classification === 'false_positive' ? 'text-white/40     bg-white/[0.04]        border-white/[0.08]'        :
    classification === 'resolved'       ? 'text-white/55     bg-white/[0.06]        border-white/[0.10]'        :
                                          'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {classification}
    </span>
  );
}

function EmptyFindings({ hasAssets }: { hasAssets: boolean }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">
        {hasAssets ? 'No active findings against your registered assets.' : 'Upload assets to start scanning.'}
      </p>
      <p className="text-white/35 text-xs mt-1">
        {hasAssets
          ? 'The scanner sweeps third-party sites, social profile pictures, and app icons every few hours.'
          : 'Findings show up here as the image-hash crawler discovers lookalike uses.'}
      </p>
    </div>
  );
}
