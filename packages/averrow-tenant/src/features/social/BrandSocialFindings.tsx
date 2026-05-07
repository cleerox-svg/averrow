// Social Media Impersonation — per-brand drill-down.
//
// Lists social_profiles rows for one brand with classification +
// severity pills. Pre-sorted CRITICAL > HIGH > MEDIUM > LOW, then
// impersonation > suspicious > parked > legitimate > official.
//
// Phase B sprint 3.

import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  useBrandSocialFindings,
  useSocialModuleSummary,
  type SocialProfileRow,
} from '@/lib/socialModule';

export function BrandSocialFindings() {
  const { brandId } = useParams<{ brandId: string }>();
  const { data: summary } = useSocialModuleSummary();
  const { data, isLoading, error } = useBrandSocialFindings(brandId ?? null);

  const brand = summary?.brands.find((b) => b.brand_id === brandId);

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/modules/social" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO SOCIAL MEDIA
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Social Media Impersonation · Brand</div>
        <h1 className="text-[28px] font-bold text-white tracking-tight">{brand?.brand_name ?? brandId}</h1>
        <p className="mt-1 text-sm text-white/55 font-mono">{brand?.canonical_domain ?? ''}</p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading profiles…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load profiles</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        data.profiles.length === 0 ? (
          <EmptyState />
        ) : (
          <ProfilesSection rows={data.profiles} />
        )
      )}
    </div>
  );
}

function ProfilesSection({ rows }: { rows: SocialProfileRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
        Profiles <span className="text-white/30">({rows.length})</span>
      </h2>
      <div className="space-y-2">
        {rows.map((p) => <ProfileRow key={p.id} profile={p} />)}
      </div>
    </section>
  );
}

function ProfileRow({ profile: p }: { profile: SocialProfileRow }) {
  const tone =
    p.classification === 'impersonation' ? 'border-sev-critical/[0.30]' :
    p.classification === 'suspicious'    ? 'border-amber/[0.30]'        :
                                           'border-white/[0.06]';
  return (
    <article className={`rounded-xl border bg-bg-card p-4 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Avatar src={p.avatar_url} fallback={p.handle?.[0] ?? '?'} verified={p.verified === 1} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <PlatformChip platform={p.platform} />
              <SeverityPill level={p.severity} />
              <ClassificationPill classification={p.classification} />
            </div>
            <div className="text-sm font-semibold text-white/90">
              @{p.handle}
              {p.display_name && (
                <span className="text-white/55 font-normal"> — {p.display_name}</span>
              )}
            </div>
            {p.bio && (
              <p className="text-[12px] text-white/55 mt-1 leading-relaxed line-clamp-2">{p.bio}</p>
            )}
            {p.classification_reason && (
              <p className="text-[11px] text-white/40 mt-2 italic">{p.classification_reason}</p>
            )}
            <div className="flex items-center gap-3 mt-2 text-[11px] font-mono text-white/40">
              {p.followers_count !== null && (
                <span>{formatFollowers(p.followers_count)} followers</span>
              )}
              {p.impersonation_score > 0 && (
                <span className="text-amber/70">score {Math.round(p.impersonation_score * 100)}%</span>
              )}
              {p.profile_url && (
                <a
                  href={p.profile_url}
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
      </div>
    </article>
  );
}

function Avatar({ src, fallback, verified }: { src: string | null; fallback: string; verified: boolean }) {
  return (
    <div className="relative flex-shrink-0">
      {src ? (
        <img src={src} alt="" className="w-10 h-10 rounded-full bg-white/10 border border-white/10 object-cover" />
      ) : (
        <div className="w-10 h-10 rounded-full bg-white/10 border border-white/10 flex items-center justify-center text-sm font-bold text-white/70">
          {fallback.toUpperCase()}
        </div>
      )}
      {verified && (
        <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-amber rounded-full flex items-center justify-center text-[10px] font-bold text-black border border-bg-card">
          ✓
        </div>
      )}
    </div>
  );
}

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function PlatformChip({ platform }: { platform: string }) {
  return (
    <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
      {platform}
    </span>
  );
}

function SeverityPill({ level }: { level: string }) {
  const tone =
    level === 'CRITICAL' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    level === 'HIGH'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    level === 'MEDIUM'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
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
    classification === 'parked'        ? 'text-white/40     bg-white/[0.04]        border-white/[0.08]'        :
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
      <p className="text-white/55 text-sm">No social profiles tracked for this brand yet.</p>
      <p className="text-white/35 text-xs mt-1">Profiles are added as the social monitor scanner finds them.</p>
    </div>
  );
}
