// Threat-Actor Intelligence — per-actor drill-down.
//
// Full actor profile + the org's brands this actor has targeted +
// the org's threats attributed to this actor + actor's known
// infrastructure.
//
// Phase B sprint 8.

import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Globe2, Server } from 'lucide-react';
import {
  useThreatActorDetail,
  CAPABILITY_LABELS,
  STATUS_LABELS,
  parseAliases,
  parseTtps,
  type ActorInfrastructureRow,
  type OrgTargetedBrand,
  type OrgThreatRow,
  type ThreatActorProfile,
} from '@/lib/threatActorModule';

export function ThreatActorDetail() {
  const { actorId } = useParams<{ actorId: string }>();
  const { data, isLoading, error } = useThreatActorDetail(actorId ?? null);

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/modules/threat-actor" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO THREAT ACTORS
      </Link>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading actor profile…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load threat actor</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          <ProfileHeader actor={data.actor} />
          <TargetedBrandsSection brands={data.targeted_brands} />
          <ThreatsSection threats={data.threats} />
          <InfrastructureSection rows={data.infrastructure} />
        </>
      )}
    </div>
  );
}

function ProfileHeader({ actor: a }: { actor: ThreatActorProfile }) {
  const aliases = parseAliases(a.aliases);
  const ttps    = parseTtps(a.primary_ttps);
  return (
    <header className="rounded-xl border border-white/[0.10] bg-bg-card p-5">
      <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Threat Actor</div>
      <h1 className="text-[28px] font-bold text-white tracking-tight mt-0.5">{a.name}</h1>

      <div className="flex items-center gap-2 flex-wrap mt-3">
        {a.country_code && (
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-mono text-blue/85 bg-blue/[0.06] border border-blue/[0.15] rounded px-1.5 py-0.5">
            <Globe2 size={11} /> {a.country_code}
          </span>
        )}
        {a.affiliation && (
          <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-amber bg-amber/[0.06] border border-amber/[0.20] rounded px-1.5 py-0.5">
            {a.affiliation}
          </span>
        )}
        {a.capability && (
          <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/65 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
            {CAPABILITY_LABELS[a.capability] ?? a.capability}
          </span>
        )}
        <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/65 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
          status: {STATUS_LABELS[a.status] ?? a.status}
        </span>
        <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/65 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
          attribution: {a.attribution_confidence}
        </span>
      </div>

      {aliases.length > 0 && (
        <p className="text-[12px] text-white/55 mt-3">
          <span className="text-white/40">also known as: </span>
          <span className="font-mono">{aliases.join(', ')}</span>
        </p>
      )}

      {a.description && (
        <p className="text-[13px] text-white/75 mt-3 leading-relaxed">{a.description}</p>
      )}

      {ttps.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-widest font-mono text-white/35 mb-1">primary TTPs</div>
          <div className="flex flex-wrap gap-1.5">
            {ttps.map((t) => (
              <span key={t} className="text-[11px] font-mono text-amber/80 bg-amber/[0.06] border border-amber/[0.15] rounded px-1.5 py-0.5">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-white/[0.06]">
        <div>
          <div className="text-[10px] uppercase tracking-widest font-mono text-white/35 mb-0.5">First seen</div>
          <div className="text-[12px] text-white/75 font-mono">{formatDate(a.first_seen)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest font-mono text-white/35 mb-0.5">Last seen</div>
          <div className="text-[12px] text-white/75 font-mono">{formatDate(a.last_seen)}</div>
        </div>
      </div>
    </header>
  );
}

function TargetedBrandsSection({ brands }: { brands: OrgTargetedBrand[] }) {
  if (brands.length === 0) return null;
  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
        Your brands targeted <span className="text-white/30">({brands.length})</span>
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {brands.map((b) => (
          <article key={b.brand_id} className="rounded-xl border border-amber/[0.20] bg-bg-card p-3">
            <div className="text-sm font-semibold text-white/90 truncate">{b.brand_name}</div>
            <div className="text-[11px] text-white/45 font-mono mt-0.5 truncate">{b.canonical_domain ?? ''}</div>
            <div className="text-[11px] text-white/45 font-mono mt-2">
              first targeted: {formatDate(b.first_targeted)}
              {b.last_targeted !== b.first_targeted && (
                <> · last: {formatDate(b.last_targeted)}</>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ThreatsSection({ threats }: { threats: OrgThreatRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
        Threats attributed to this actor (your brands) <span className="text-white/30">({threats.length})</span>
      </h2>
      {threats.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
          <p className="text-white/55 text-sm">No threats attributed to this actor against your brands yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {threats.map((t) => <ThreatRow key={t.id} threat={t} />)}
        </div>
      )}
    </section>
  );
}

function ThreatRow({ threat: t }: { threat: OrgThreatRow }) {
  const tone =
    t.severity === 'critical' ? 'border-sev-critical/[0.30]' :
    t.severity === 'high'     ? 'border-amber/[0.30]'        :
                                'border-white/[0.06]';
  return (
    <article className={`rounded-xl border bg-bg-card p-4 ${tone}`}>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <SeverityPill level={t.severity ?? 'low'} />
        <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
          {t.threat_type}
        </span>
        <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/45">
          attribution: {t.attribution_source} · {t.attribution_confidence}
        </span>
      </div>
      {t.brand_name && (
        <div className="text-[12px] text-white/65 mt-1">
          <span className="text-white/40">target brand: </span>
          <span>{t.brand_name}</span>
        </div>
      )}
      {(t.malicious_url ?? t.malicious_domain) && (
        <div className="text-[12px] text-white/75 font-mono mt-1 truncate">
          {t.malicious_url ?? t.malicious_domain}
        </div>
      )}
      <div className="flex items-center gap-3 mt-2 text-[11px] font-mono text-white/40">
        <span>observed {formatDate(t.observed_at)}</span>
        {t.country_code && <span>{t.country_code}</span>}
        {t.malicious_url && (
          <a
            href={t.malicious_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-amber hover:underline ml-auto"
          >
            <ExternalLink size={11} /> open
          </a>
        )}
      </div>
    </article>
  );
}

function InfrastructureSection({ rows }: { rows: ActorInfrastructureRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
        Known infrastructure <span className="text-white/30">({rows.length})</span>
      </h2>
      <div className="rounded-xl border border-white/[0.06] bg-bg-card overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-white/[0.02] border-b border-white/[0.06]">
            <tr className="text-left text-white/45 uppercase tracking-widest font-mono">
              <th className="px-3 py-2 text-[10px]">ASN</th>
              <th className="px-3 py-2 text-[10px]">Range / Domain</th>
              <th className="px-3 py-2 text-[10px]">Provider</th>
              <th className="px-3 py-2 text-[10px]">Country</th>
              <th className="px-3 py-2 text-[10px]">Confidence</th>
              <th className="px-3 py-2 text-[10px]">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-white/[0.04] last:border-b-0">
                <td className="px-3 py-2 font-mono text-white/75">{r.asn ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-white/75">
                  {r.domain ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Server size={10} className="text-white/40" /> {r.domain}
                    </span>
                  ) : (
                    r.ip_range ?? '—'
                  )}
                </td>
                <td className="px-3 py-2 text-white/65">{r.hosting_provider ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-white/65">{r.country_code ?? '—'}</td>
                <td className="px-3 py-2 text-white/65">{r.confidence}</td>
                <td className="px-3 py-2 font-mono text-white/45">{formatDate(r.last_observed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatDate(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function SeverityPill({ level }: { level: string }) {
  const tone =
    level === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    level === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    level === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                           'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {level}
    </span>
  );
}
