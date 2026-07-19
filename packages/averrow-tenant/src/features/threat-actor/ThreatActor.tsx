// Threat-Actor Intelligence — primary tenant surface.
//
// Lists threat actors targeting the org's brands, with attack
// counts, country, capability, and confidence. Drill-down via
// /modules/threat-actor/actors/:actorId.
//
// Phase B sprint 8 (last per-module surface).

import { Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, ShieldCheck, Globe2, Crosshair, type LucideIcon } from 'lucide-react';
import {
  useThreatActorModuleSummary,
  CAPABILITY_LABELS,
  STATUS_LABELS,
  parseAliases,
  type ThreatActorSummary,
  type ThreatActorTotals,
} from '@/lib/threatActorModule';

export function ThreatActor() {
  const { data, isLoading, error } = useThreatActorModuleSummary();

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO OVERVIEW
      </Link>

      <header>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-[28px] font-bold text-white tracking-tight">Threat-Actor Intelligence</h1>
          <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-amber bg-amber/[0.10] border border-amber/[0.20] rounded px-2 py-1">
            Active
          </span>
        </div>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Adversaries targeting your brands. Attribution from OTX advisories, infrastructure-clustering fingerprints, and CISA / Mandiant / CrowdStrike intel feeds.
        </p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading actors…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load Threat-Actor Intelligence</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          <HeadlineMetrics totals={data.totals} />
          <section>
            <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">Actors targeting your brands</h2>
            {data.actors.length === 0 ? (
              <NoActors />
            ) : (
              <div className="space-y-2">
                {data.actors.map((a) => <ActorRow key={a.actor_id} actor={a} />)}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function HeadlineMetrics({ totals }: { totals: ThreatActorTotals }) {
  const cards: Array<{
    label: string; value: number; sub: string;
    icon: LucideIcon; tone: 'crit' | 'warn' | 'neutral';
  }> = [
    {
      label: 'Actors tracked',
      value: totals.actor_count,
      sub: `${totals.high_confidence_actors} high-confidence`,
      icon: Crosshair,
      tone: totals.actor_count > 0 ? 'warn' : 'neutral',
    },
    {
      label: 'Attributed threats',
      value: totals.threat_count,
      sub: 'against your brands',
      icon: AlertTriangle,
      tone: totals.threat_count > 0 ? 'crit' : 'neutral',
    },
    {
      label: 'Origin countries',
      value: totals.countries_count,
      sub: 'with attributed activity',
      icon: Globe2,
      tone: 'neutral',
    },
    {
      label: 'High confidence',
      value: totals.high_confidence_actors,
      sub: 'confirmed or high-confidence',
      icon: ShieldCheck,
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

function ActorRow({ actor: a }: { actor: ThreatActorSummary }) {
  const tone =
    a.threat_count_for_org > 5 ? 'border-sev-critical/[0.30]' :
    a.threat_count_for_org > 0 ? 'border-amber/[0.30]'        :
                                 'border-white/[0.06]';
  const aliases = parseAliases(a.aliases);

  return (
    <Link
      to={`/modules/threat-actor/actors/${a.actor_id}`}
      className={`block rounded-xl border bg-bg-card p-4 transition-colors hover:border-white/[0.20] ${tone}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-base font-semibold text-white/95">{a.name}</span>
            {a.country_code && (
              <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-blue/85 bg-blue/[0.06] border border-blue/[0.15] rounded px-1.5 py-0.5">
                {a.country_code}
              </span>
            )}
            {a.capability && (
              <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
                {CAPABILITY_LABELS[a.capability] ?? a.capability}
              </span>
            )}
            <ConfidencePill confidence={a.attribution_confidence} />
            <StatusPill status={a.status} />
          </div>

          {aliases.length > 0 && (
            <div className="text-[11px] text-white/45 font-mono mt-1">
              also known as: {aliases.slice(0, 5).join(', ')}{aliases.length > 5 ? ', …' : ''}
            </div>
          )}
          {a.affiliation && (
            <div className="text-[11px] text-white/55 mt-1">affiliation: {a.affiliation}</div>
          )}
        </div>

        <div className="flex items-start gap-6 flex-shrink-0">
          <Stat label="threats" value={a.threat_count_for_org} crit />
          <Stat label="brands hit" value={a.brands_targeted_for_org} />
        </div>
      </div>

      {a.last_seen_for_org && (
        <div className="text-[11px] text-white/40 font-mono mt-3">
          last activity against your brands: {formatDate(a.last_seen_for_org)}
        </div>
      )}
    </Link>
  );
}

function Stat({ label, value, crit }: { label: string; value: number; crit?: boolean }) {
  const accent =
    value === 0 ? 'text-white/35'     :
    crit        ? 'text-sev-critical' :
                  'text-white/85';
  return (
    <div className="text-right">
      <div className="text-[8px] uppercase tracking-widest font-mono text-white/35 mb-0.5">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

function ConfidencePill({ confidence }: { confidence: string }) {
  const tone =
    confidence === 'confirmed' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    confidence === 'high'      ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    confidence === 'medium'    ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                                 'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {confidence}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'active'    ? 'text-amber    bg-amber/[0.06]    border-amber/[0.15]' :
    status === 'disrupted' ? 'text-green/85 bg-green/[0.06]    border-green/[0.15]' :
    status === 'dormant'   ? 'text-white/40 bg-white/[0.04]    border-white/[0.08]' :
                             'text-white/55 bg-white/[0.04]    border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function NoActors() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">No actors are currently attributed to attacks on your brands.</p>
      <p className="text-white/35 text-xs mt-1">
        Attributions land here as OTX advisories, infrastructure-clustering matches, and CISA / Mandiant / CrowdStrike feeds bind activity to specific actors.
      </p>
    </div>
  );
}
