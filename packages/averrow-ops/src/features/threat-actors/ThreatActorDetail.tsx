import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Search } from 'lucide-react';
import { Card, StatCard, EmptyState } from '@/design-system/components';
import { Skeleton } from '@/components/ui/Skeleton';
import { useThreatActorDetail } from '@/hooks/useThreatActors';
import { BIMIGradeBadge } from '@/components/ui/BIMIGradeBadge';

function countryFlag(code: string | null): string {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65),
  );
}

function parseJsonArray(val: string | null): string[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    // Fallback: treat as comma-separated string
    return val.split(',').map(s => s.trim()).filter(Boolean);
  }
}

export function ThreatActorDetail() {
  const { actorId } = useParams<{ actorId: string }>();
  const navigate = useNavigate();
  const { data: actor, isLoading } = useThreatActorDetail(actorId ?? '');

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (!actor) {
    return (
      <div className="p-6 space-y-4">
        <button
          onClick={() => navigate('/threat-actors')}
          className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors hover:text-[var(--amber)]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <ArrowLeft size={12} /> Back to Threat Actors
        </button>
        <Card hover={false}>
          <EmptyState
            icon={<Search />}
            title="Threat actor not found"
            subtitle="The ID may have changed or the actor was merged. Browse the full registry to find them."
            variant="scanning"
            action={{
              label: 'Browse all threat actors',
              onClick: () => navigate('/threat-actors'),
              variant: 'secondary',
            }}
          />
        </Card>
      </div>
    );
  }

  const aliases = parseJsonArray(actor.aliases);
  const ttps = parseJsonArray(actor.ttps);
  const sectors = parseJsonArray(actor.target_sectors);

  // Parse active_campaigns — may be JSON array of strings, objects with id/name, or comma-separated
  const campaigns = (() => {
    const raw = actor.active_campaigns;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item: unknown) => {
          if (typeof item === 'string') return { id: null, name: item };
          if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>;
            return { id: (obj.id as string) ?? null, name: (obj.name as string) ?? String(obj.id ?? 'Unknown') };
          }
          return { id: null, name: String(item) };
        });
      }
      return [];
    } catch {
      return raw.split(',').map(s => s.trim()).filter(Boolean).map(name => ({ id: null, name }));
    }
  })();

  return (
    <div className="p-6 space-y-6">
      {/* Back nav */}
      <button
        onClick={() => navigate('/threat-actors')}
        className="text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] font-mono transition-colors"
      >
        &larr; Back to Threat Actors
      </button>

      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-mono font-bold text-[var(--text-primary)]">{actor.name}</h1>
          <span className="text-lg">{countryFlag(actor.country)}</span>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${
            actor.status === 'active' ? 'bg-[var(--sev-critical)]/20 text-[var(--sev-critical)] border-[var(--sev-critical)]/30' : 'bg-white/5 text-[var(--text-tertiary)] border-white/10'
          }`}>
            {actor.status}
          </span>
        </div>
        {aliases.length > 0 && (
          <p className="text-[11px] text-[var(--text-tertiary)] font-mono mt-1">
            Also known as: {aliases.join(', ')}
          </p>
        )}
        {actor.description && (
          <p className="text-[12px] text-white/70 mt-2 max-w-3xl leading-relaxed">{actor.description}</p>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          title="ATTRIBUTION"
          metric={<span className="text-lg sm:text-[28px] font-bold leading-none text-[var(--sev-critical)]">{actor.attribution ?? '?'}</span>}
          metricLabel="state sponsor"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--sev-critical)]" />
              <span className="text-[11px] text-white/60">Attribution</span>
              <span className="text-[11px] font-mono text-[var(--text-primary)]">{actor.attribution ?? 'Unknown'}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--amber)]" />
              <span className="text-[11px] text-white/60">Country</span>
              <span className="text-[11px] font-mono text-[var(--text-primary)]">{actor.country ?? 'Unknown'}</span>
            </div>
          </div>
        </StatCard>
        <StatCard
          title="TARGET SECTORS"
          metric={<span className="text-lg sm:text-[24px] font-bold leading-none" style={{ color: 'var(--amber)' }}>{sectors.length || 0}</span>}
          metricLabel="sectors"
        >
          {sectors.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {sectors.slice(0, 3).map(sector => (
                <span key={sector} className="text-[10px] px-1.5 py-0.5 rounded-full bg-wing-blue/10 border border-wing-blue/20 text-wing-blue">
                  {sector}
                </span>
              ))}
              {sectors.length > 3 && (
                <span className="text-[10px] text-white/40">+{sectors.length - 3}</span>
              )}
            </div>
          ) : (
            <span className="text-[11px] text-white/40">No sector data</span>
          )}
        </StatCard>
        <StatCard
          title="INFRASTRUCTURE"
          metric={<span className="text-xl sm:text-[32px] font-bold leading-none text-wing-blue">{actor.infrastructure?.length ?? 0}</span>}
          metricLabel="tracked"
        >
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-wing-blue" />
            <span className="text-[11px] text-white/60">Tracked ASNs/IPs/Domains</span>
          </div>
        </StatCard>
        <StatCard
          title="LINKED THREATS"
          metric={<span className="text-xl sm:text-[32px] font-bold leading-none text-[#f87171]">{actor.linked_threat_count}</span>}
          metricLabel="threats"
        >
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-[#f87171]" />
            <span className="text-[11px] text-white/60">From known ASNs</span>
          </div>
        </StatCard>
      </div>

      {/* Campaigns */}
      {campaigns.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-[var(--bg-card)] p-4">
          <h2 className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-tertiary)] mb-3 flex items-center gap-2">
            Active Campaigns
            <span className="flex-1 h-px bg-white/[0.06]" />
          </h2>
          <div className="space-y-2">
            {campaigns.map((campaign, idx) => (
              campaign.id ? (
                <Link
                  key={campaign.id}
                  to={`/campaigns/${campaign.id}`}
                  className="flex items-center justify-between p-3 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] hover:border-white/[0.10] transition-all group"
                >
                  <p className="text-[var(--text-primary)] text-sm font-medium group-hover:text-[var(--amber)] transition-colors">
                    {campaign.name}
                  </p>
                  <span className="text-white/40 group-hover:text-[var(--amber)] transition-colors">&rarr;</span>
                </Link>
              ) : (
                <div
                  key={`${campaign.name}-${idx}`}
                  className="flex items-center p-3 rounded-lg bg-white/[0.03] border border-white/[0.06]"
                >
                  <p className="text-[var(--text-primary)] text-sm">{campaign.name}</p>
                </div>
              )
            ))}
          </div>
        </div>
      )}

      {/* TTPs */}
      {ttps.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-[var(--bg-card)] p-4">
          <h2 className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-tertiary)] mb-3">
            Tactics, Techniques & Procedures
          </h2>
          <div className="flex flex-wrap gap-2">
            {ttps.map(ttp => (
              <span key={ttp} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-[11px] text-[var(--text-primary)]">
                {ttp.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Infrastructure */}
      {actor.infrastructure && actor.infrastructure.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-[var(--bg-card)] p-4">
          <h2 className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-tertiary)] mb-3">
            Known Infrastructure
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-[var(--text-tertiary)] text-left border-b border-white/10">
                  <th className="pb-2 pr-4">ASN</th>
                  <th className="pb-2 pr-4">Domain</th>
                  <th className="pb-2 pr-4">Country</th>
                  <th className="pb-2 pr-4">Confidence</th>
                  <th className="pb-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {actor.infrastructure.map(infra => (
                  <tr key={infra.id} className="data-row border-b border-white/5 text-white/70">
                    <td className="py-2 pr-4">{infra.asn ?? '—'}</td>
                    <td className="py-2 pr-4">{infra.domain ?? '—'}</td>
                    <td className="py-2 pr-4">{countryFlag(infra.country_code)} {infra.country_code ?? '—'}</td>
                    <td className="py-2 pr-4">
                      <span className={
                        infra.confidence === 'confirmed' ? 'text-green-400' :
                        infra.confidence === 'high' ? 'text-[var(--amber)]' : 'text-[var(--text-tertiary)]'
                      }>
                        {infra.confidence}
                      </span>
                    </td>
                    <td className="py-2 text-white/50">{infra.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Targeted Brands */}
      {actor.targets && actor.targets.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-[var(--bg-card)] p-4">
          <h2 className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-tertiary)] mb-3">
            Targeted Brands ({actor.targets.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {actor.targets.map(target => (
              <button
                key={target.id}
                onClick={() => target.brand_id ? navigate(`/brands/${target.brand_id}`) : undefined}
                className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-3 text-left hover:border-[var(--amber)]/30 transition-all"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-mono text-[var(--text-primary)] font-semibold">
                    {target.brand_name ?? target.sector ?? 'Unknown'}
                  </div>
                  {target.canonical_domain && (
                    <div className="text-[10px] text-[var(--text-tertiary)]">{target.canonical_domain}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <BIMIGradeBadge grade={(target as any).bimi_grade ?? null} size="sm" tooltip />
                  {target.sector && (
                    <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-tertiary)] border border-white/5">
                      {target.sector}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
          {actor.targets[0]?.context && (
            <p className="text-[10px] text-white/40 mt-3 font-mono">
              Context: {actor.targets[0].context}
            </p>
          )}
        </div>
      )}

      {/* Recent Activity — unified attribution timeline.
          Pulls from threat_attributions across all sources (OTX
          pulses, NEXUS clusters, news mentions). Replaces the
          static seed-data feel with real cross-source activity
          per actor. */}
      {actor.recent_attributions && actor.recent_attributions.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-[var(--bg-card)] p-4">
          <h2 className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-tertiary)] mb-3">
            Recent Activity ({actor.recent_attributions.length})
          </h2>
          <ul className="space-y-2">
            {actor.recent_attributions.map((att) => {
              const sourceColor =
                att.source === 'otx'    ? 'var(--blue)' :
                att.source === 'nexus'  ? 'var(--amber)' :
                att.source === 'news'   ? 'var(--green)' :
                'var(--text-tertiary)';
              const ago = relativeTime(att.observed_at);
              return (
                <li
                  key={att.id}
                  className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-2.5"
                >
                  <span
                    className="mt-1 flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider"
                    style={{
                      color: sourceColor,
                      borderColor: sourceColor,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      background: `${sourceColor}10`,
                    }}
                  >
                    {att.source}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-white/85 truncate">
                      {att.source_pulse_name ?? att.actor_name_raw ?? `Threat ${att.threat_id.slice(0, 16)}…`}
                    </div>
                    <div className="text-[10px] font-mono text-white/40 mt-0.5">
                      {ago} · confidence {att.confidence}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* News Mentions — articles from the news-watcher feed (Phase D)
          that named this actor. Five most recent geopolitical-flagged
          items first; click opens the source article in a new tab. */}
      {actor.news_mentions && actor.news_mentions.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-[var(--bg-card)] p-4">
          <h2 className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-tertiary)] mb-3">
            News Mentions ({actor.news_mentions.length})
          </h2>
          <ul className="space-y-2">
            {actor.news_mentions.map((m) => (
              <li key={m.id}>
                <a
                  href={m.article_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-lg border border-white/10 bg-white/5 p-3 hover:border-amber/30 transition-all"
                >
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <span className="font-mono text-[9px] uppercase tracking-widest text-amber">
                      {m.source_feed}
                    </span>
                    {m.is_geopolitical === 1 && (
                      <span className="rounded bg-[var(--sev-critical)]/10 border border-[var(--sev-critical)]/30 px-1.5 py-0.5 font-mono text-[8px] uppercase text-[var(--sev-critical)]">
                        Geopolitical
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] font-semibold text-white/90 line-clamp-2">
                    {m.title}
                  </div>
                  {m.excerpt && (
                    <div className="text-[10px] text-white/40 mt-1 line-clamp-2 font-mono">
                      {m.excerpt}
                    </div>
                  )}
                  <div className="text-[10px] font-mono text-white/30 mt-1.5">
                    {relativeTime(m.published_at ?? m.ingested_at)}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Honest empty-state — when we have no attribution data at all,
          tell the operator what we're waiting for instead of leaving
          a blank page. Reference actors (the seven IR APTs from
          migration 0093) sit in this state until OTX, NEXUS, or
          news-watcher writes their first attribution row. */}
      {(!actor.recent_attributions || actor.recent_attributions.length === 0) &&
       (!actor.news_mentions || actor.news_mentions.length === 0) &&
       (!actor.infrastructure || actor.infrastructure.length === 0) && (
        <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] p-6 text-center">
          <div className="font-mono text-[10px] uppercase tracking-widest text-white/40 mb-2">
            No observations yet
          </div>
          <p className="text-[12px] text-white/55 max-w-md mx-auto">
            This actor is in the reference taxonomy but no OTX pulse,
            NEXUS cluster, or news article has named them recently.
            Activity will surface here automatically once any of the
            attribution writers (OTX, NEXUS, news-watcher) sees them.
          </p>
        </div>
      )}
    </div>
  );
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
