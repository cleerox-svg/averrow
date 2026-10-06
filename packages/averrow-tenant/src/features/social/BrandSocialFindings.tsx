// Social Media Impersonation — per-brand drill-down.
//
// Lists social_profiles rows for one brand with classification +
// severity pills. Pre-sorted CRITICAL > HIGH > MEDIUM > LOW, then
// impersonation > suspicious > parked > legitimate > official.
//
// Phase B sprint 3.

import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Badge, PageState, pageStateKind } from '@averrow/shared/ui';
import {
  useBrandSocialFindings,
  useSocialModuleSummary,
  type SocialProfileRow,
} from '@/lib/socialModule';

export function BrandSocialFindings() {
  const { brandId } = useParams<{ brandId: string }>();
  const { data: summary } = useSocialModuleSummary();
  const { data, isLoading, isError, error, refetch } = useBrandSocialFindings(brandId ?? null);
  // Error beats loading. A failed refetch with the last good rows still on
  // screen keeps them and shows an inline error instead.
  const kind = pageStateKind({ isLoading, isError: isError && !data });

  const brand = summary?.brands.find((b) => b.brand_id === brandId);

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/modules/social" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO SOCIAL MEDIA
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Social Media Impersonation · Brand</div>
        <h1 className="text-[28px] font-bold text-[var(--text-primary)] tracking-tight">{brand?.brand_name ?? brandId}</h1>
        <p className="mt-1 text-sm text-white/55 font-mono">{brand?.canonical_domain ?? ''}</p>
      </header>

      {kind === 'loading' && <PageState kind="loading" layout="card" title="Loading profiles…" />}
      {kind === 'error' && (
        <PageState
          kind="error"
          layout="card"
          title="Couldn't load profiles"
          description={error?.message}
          onRetry={() => { void refetch(); }}
        />
      )}
      {isError && data && (
        <PageState
          kind="error"
          layout="inline"
          title="Couldn't refresh profiles"
          description={`${error?.message ?? 'Request failed.'} Showing the last loaded profiles.`}
          onRetry={() => { void refetch(); }}
        />
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

// Older rows were scored with two reasons that are not true statements about
// the account ("not verified" is assumed, not observed; the keyword line fires on
// every handle match). Never show them to a customer.
const FALSE_SIGNALS = new Set([
  'account is not verified',
  'account name or bio contains brand keywords',
]);

function parseSignals(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x !== '' && !FALSE_SIGNALS.has(x.replace(/\.$/, '').toLowerCase()));
}

function ProfileRow({ profile: p }: { profile: SocialProfileRow }) {
  const accent =
    p.classification === 'impersonation' ? 'border-l-sev-critical/70' :
    p.classification === 'suspicious'    ? 'border-l-amber/70'        :
                                           'border-l-white/15';
  const signals = parseSignals(p.impersonation_signals);
  const secondary = p.classification_reason || (signals.length > 0 ? signals.join(' · ') : null) || p.bio;
  return (
    <article className={`rounded-lg border border-white/[0.07] border-l-2 ${accent} bg-bg-card px-3.5 py-2.5 flex items-center gap-3 hover:border-white/[0.18] transition-colors`}>
      <Avatar src={p.avatar_url} fallback={p.handle?.[0] ?? '?'} verified={p.verified === 1} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-white/90 truncate">@{p.handle}</span>
          {p.display_name && <span className="text-[12px] text-white/45 truncate hidden sm:inline">{p.display_name}</span>}
          <PlatformChip platform={p.platform} />
          <Badge severity={p.severity} size="md" />
          <Badge classification={p.classification} size="md" />
        </div>
        {secondary && (
          <p className="text-[11px] text-white/45 mt-0.5 truncate" title={secondary}>{secondary}</p>
        )}
      </div>

      <div className="flex flex-col items-end gap-0.5 flex-shrink-0 pl-2">
        {p.impersonation_score > 0 && (
          <div className="text-right leading-none">
            <span className={`text-lg font-bold tabular-nums ${p.impersonation_score >= 0.7 ? 'text-sev-critical' : 'text-amber'}`}>
              {Math.round(p.impersonation_score * 100)}%
            </span>
            <div className="text-[8px] uppercase tracking-widest font-mono text-white/35 mt-0.5">match</div>
          </div>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          {p.followers_count !== null && (
            <span className="text-[10px] font-mono text-white/40">{formatFollowers(p.followers_count)}</span>
          )}
          {p.profile_url && (
            <a
              href={p.profile_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-mono text-amber hover:underline"
            >
              <ExternalLink size={10} /> open
            </a>
          )}
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

function EmptyState() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">No social profiles tracked for this brand yet.</p>
      <p className="text-white/35 text-xs mt-1">Profiles are added as the social monitor scanner finds them.</p>
    </div>
  );
}
