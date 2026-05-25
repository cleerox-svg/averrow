// Trademark Infringement — per-brand drill-down.
//
// Shows registered assets at the top + a finding-by-finding list
// below with side-by-side image comparison (asset vs. found image)
// and a Hamming-distance / confidence indicator.
//
// Phase B sprint 7.

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Image as ImageIcon, Upload, Trash2 } from 'lucide-react';
import {
  useBrandTrademarkFindings,
  useTrademarkModuleSummary,
  useUploadTrademarkAsset,
  useDeleteTrademarkAsset,
  ASSET_TYPE_LABELS,
  CONTEXT_LABELS,
  type TrademarkAssetRow,
  type TrademarkFindingRow,
} from '@/lib/trademarkModule';
import { getToken } from '@/lib/api';

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
          <AssetsSection assets={data.assets} brandId={data.brand_id} />
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

function AssetsSection({ assets, brandId }: { assets: TrademarkAssetRow[]; brandId: string }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
          Registered assets <span className="text-white/30">({assets.length})</span>
        </h2>
      </div>

      <AssetUploader brandId={brandId} />

      {assets.length === 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-bg-card p-6 text-center">
          <ImageIcon className="inline text-white/40" size={20} />
          <p className="text-white/55 text-sm mt-2">No assets registered yet.</p>
          <p className="text-white/40 text-xs mt-1">Upload a logo or wordmark above. Active logo-image scanning lands with Phase 2; today this registers the mark and stores it for matching.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {assets.map((a) => <AssetCard key={a.id} asset={a} brandId={brandId} />)}
        </div>
      )}
    </section>
  );
}

// File picker → base64 → upload mutation. 2 MB cap (matches the server).
function AssetUploader({ brandId }: { brandId: string }) {
  const upload = useUploadTrademarkAsset();
  const fileRef = useRef<HTMLInputElement>(null);
  const [assetType, setAssetType] = useState<'logo' | 'wordmark' | 'combined'>('logo');
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const onPick = async (file: File) => {
    setLocalError(null);
    if (file.size > 2 * 1024 * 1024) { setLocalError('Image exceeds 2 MB.'); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
    upload.mutate(
      {
        brand_id: brandId,
        asset_type: assetType,
        asset_name: name.trim() || file.name,
        content_type: file.type || 'application/octet-stream',
        data_base64: dataUrl,
      },
      {
        onSuccess: () => { setName(''); if (fileRef.current) fileRef.current.value = ''; },
        onError: (e) => setLocalError((e as Error).message),
      },
    );
  };

  return (
    <div className="rounded-xl border border-white/[0.08] bg-bg-card p-3 flex flex-wrap items-center gap-2">
      <select
        value={assetType}
        onChange={(e) => setAssetType(e.target.value as 'logo' | 'wordmark' | 'combined')}
        className="rounded-lg bg-white/[0.03] border border-white/[0.08] focus:border-amber/[0.40] focus:outline-none px-2.5 py-1.5 text-[12px] text-white/90 font-mono"
      >
        <option value="logo">Logo</option>
        <option value="wordmark">Wordmark</option>
        <option value="combined">Combined</option>
      </select>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Asset name (optional)"
        className="flex-1 min-w-[140px] rounded-lg bg-white/[0.03] border border-white/[0.08] focus:border-amber/[0.40] focus:outline-none px-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/30"
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPick(f); }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={upload.isPending}
        className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-widest font-mono text-amber bg-amber/[0.08] hover:bg-amber/[0.16] border border-amber/[0.30] rounded px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Upload size={12} /> {upload.isPending ? 'Uploading…' : 'Upload image'}
      </button>
      {localError && <span className="text-[11px] text-sev-critical font-mono w-full">{localError}</span>}
    </div>
  );
}

function AssetCard({ asset: a, brandId }: { asset: TrademarkAssetRow; brandId: string }) {
  const del = useDeleteTrademarkAsset(brandId);
  return (
    <article className="rounded-xl border border-white/[0.06] bg-bg-card p-3">
      <div className="flex items-start gap-3">
        <AssetImage src={a.asset_url} fallback={a.asset_name?.[0] ?? '?'} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
              {ASSET_TYPE_LABELS[a.asset_type] ?? a.asset_type}
            </span>
            <button
              type="button"
              onClick={() => del.mutate(a.id)}
              disabled={del.isPending}
              title="Remove asset"
              className="ml-auto text-white/30 hover:text-sev-critical transition-colors disabled:opacity-40"
            >
              <Trash2 size={13} />
            </button>
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
  // Our own image-serve endpoint is auth-gated, so a bare <img src> can't load
  // it (no Bearer header). Fetch those as a blob with the token and use an
  // object URL. External URLs (e.g. a brand's public logo) load directly.
  const needsAuth = !!src && src.startsWith('/api/');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!needsAuth || !src) return;
    let revoked = false;
    let url: string | null = null;
    (async () => {
      try {
        const token = getToken();
        const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) { setFailed(true); return; }
        const blob = await res.blob();
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      } catch {
        setFailed(true);
      }
    })();
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [needsAuth, src]);

  const resolved = needsAuth ? objectUrl : src;
  if (resolved && !failed) {
    return <img src={resolved} alt="" className={`${dim} rounded-lg bg-white/10 border border-white/10 object-contain`} />;
  }
  return (
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
