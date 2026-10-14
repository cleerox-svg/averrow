/**
 * Rows for the lens-aware intelligence panel: what each lens ranks, derived from
 * the lens data the page already holds (no extra requests).
 *
 *   Hosting     top providers by active threats
 *   Operations  top operations by threat count
 *   Baseline    most over-indexed countries (or biggest volume / highest bot share)
 *   Campaigns   active campaigns first
 *   Movement    most recent moves
 *   Actors      actors with the most attributed clusters
 */

import type {
  ActorListItem, CampaignGeo, Movement, OperationGeo, OverindexRow, ProviderGeo,
} from '@/hooks/useObservatoryLenses';
import type { BotDensityPoint } from './bot-density';
import { countryName } from './country-name';
import type { DrillTarget } from './drill';
import { formatRatio } from './lens/baseline';
import { trendClass } from './lens/hosting';
import { normalizeConfidence, operationEvidence } from './lens/operations';
import { isActiveCampaign } from './lens/campaigns';
import { iso2 } from './lens/placement';
import { formatHours, pct, resolvedOf, TAKEDOWN_MIN_RESOLVED, type TakedownCountryModel, type TakedownProviderModel } from './lens/takedowns';
import type { VelocityModel } from './lens/velocity';
import { VELOCITY_FILLING } from './lens/velocity';
import { parseUtc, relativeTime } from '@/lib/time';

export interface PanelRow {
  key: string;
  primary: string;
  secondary?: string;
  /** Right-aligned figure. */
  trailing?: string;
  /** Tone of the trailing figure. */
  tone?: 'rising' | 'falling' | 'neutral';
  /** Selecting the row re-targets the map + drawer. Absent => informational. */
  target?: DrillTarget;
}

export interface PanelSection {
  title: string;
  /** Shown when there are no rows. */
  empty: string;
  rows: PanelRow[];
}

export const PANEL_ROWS = 12;
/** Over-index ratios on a handful of threats are noise: rank only countries with at least this many. */
export const MIN_RANKED_COUNT = 5;

export function hostingRows(providers: readonly ProviderGeo[] | undefined): PanelSection {
  const rows = [...(providers ?? [])]
    .filter(p => p.active_threat_count > 0)
    .sort((a, b) => b.active_threat_count - a.active_threat_count || a.id.localeCompare(b.id))
    .slice(0, PANEL_ROWS)
    .map((p): PanelRow => {
      const trend = trendClass(p.trend_7d, p.trend_30d);
      return {
        key: p.id, primary: p.name,
        secondary: [p.asn, countryName(iso2(p.country) ?? '')].filter(Boolean).join(' · ') + (p.is_bulletproof ? ' · bulletproof' : ''),
        trailing: `${p.active_threat_count.toLocaleString()}${trend === 'rising' ? ' ↑' : trend === 'falling' ? ' ↓' : ''}`,
        tone: trend === 'flat' ? 'neutral' : trend,
        target: { kind: 'provider', id: p.id, provider: p },
      };
    });
  return { title: 'Top hosting providers', empty: 'No provider has active threats.', rows };
}

export function operationRows(ops: readonly OperationGeo[] | undefined): PanelSection {
  const rows = [...(ops ?? [])]
    .sort((a, b) => b.threat_count - a.threat_count || a.id.localeCompare(b.id))
    .slice(0, PANEL_ROWS)
    .map((o): PanelRow => {
      const conf = normalizeConfidence(o.confidence_score);
      return {
        key: o.id, primary: o.name ?? o.id,
        secondary: `${operationEvidence(o)} · ${o.countries.length} countries${conf !== null ? ` · ${Math.round(conf * 100)}% conf` : ''}${o.actor ? ` · ${o.actor.name}` : ''}`,
        trailing: o.threat_count.toLocaleString(),
        target: { kind: 'operation', id: o.id, op: o },
      };
    });
  return { title: 'Top operations', empty: 'No active operations.', rows };
}

export function baselineRows(
  measure: 'index' | 'raw' | 'bot',
  overindex: readonly OverindexRow[] | undefined,
  bot: readonly BotDensityPoint[] | undefined,
): PanelSection {
  if (measure === 'bot') {
    const rows = [...(bot ?? [])]
      .sort((a, b) => b.bot_pct - a.bot_pct || a.code.localeCompare(b.code))
      .slice(0, PANEL_ROWS)
      .map((b): PanelRow => ({
        key: b.code, primary: b.name || countryName(b.code), secondary: `${b.traffic_pct.toFixed(1)}% of global traffic`,
        trailing: `${b.bot_pct.toFixed(1)}%`,
      }));
    return { title: 'Highest bot share', empty: 'No bot-share data yet.', rows };
  }
  if (measure === 'raw') {
    const rows = [...(overindex ?? [])]
      .filter(r => r.our_count > 0)
      .sort((a, b) => b.our_count - a.our_count || a.country_code.localeCompare(b.country_code))
      .slice(0, PANEL_ROWS)
      .map((r): PanelRow => ({
        key: r.country_code, primary: countryName(r.country_code) || r.country_code,
        secondary: `${(r.our_share * 100).toFixed(1)}% of our threats`, trailing: r.our_count.toLocaleString(),
        target: { kind: 'country', code: r.country_code },
      }));
    return { title: 'Most threats', empty: 'No country data for this period.', rows };
  }
  const rows = [...(overindex ?? [])]
    .filter(r => r.ratio !== null && Number.isFinite(r.ratio) && r.our_count >= MIN_RANKED_COUNT)
    .sort((a, b) => (b.ratio as number) - (a.ratio as number) || a.country_code.localeCompare(b.country_code))
    .slice(0, PANEL_ROWS)
    .map((r): PanelRow => ({
      key: r.country_code, primary: countryName(r.country_code) || r.country_code,
      secondary: `${r.our_count.toLocaleString()} threats`, trailing: formatRatio(r.ratio).replace(' Radar', ''),
      tone: (r.ratio as number) > 1 ? 'rising' : 'falling',
      target: { kind: 'country', code: r.country_code },
    }));
  return { title: 'Most over-indexed', empty: `No country has ${MIN_RANKED_COUNT}+ threats and a Radar baseline.`, rows };
}

export function campaignRows(campaigns: readonly CampaignGeo[] | undefined): PanelSection {
  const rows = [...(campaigns ?? [])]
    .sort((a, b) => Number(isActiveCampaign(b.status)) - Number(isActiveCampaign(a.status)) || a.name.localeCompare(b.name))
    .slice(0, PANEL_ROWS)
    .map((c): PanelRow => ({
      key: c.id, primary: c.name,
      secondary: `${c.adversary_countries.length} adversar${c.adversary_countries.length === 1 ? 'y' : 'ies'} → ${c.target_countries.length} target${c.target_countries.length === 1 ? '' : 's'}`,
      trailing: c.status ?? '',
      tone: isActiveCampaign(c.status) ? 'rising' : 'neutral',
      target: { kind: 'campaign', id: c.id, campaign: c },
    }));
  return { title: 'Curated campaigns', empty: 'No curated campaigns.', rows };
}

export function movementRows(moves: readonly Movement[] | undefined): PanelSection {
  const rows = [...(moves ?? [])]
    .sort((a, b) => parseUtc(b.at).getTime() - parseUtc(a.at).getTime())
    .slice(0, PANEL_ROWS)
    .map((m): PanelRow => ({
      key: m.id, primary: m.cluster_name ?? 'Infrastructure movement',
      secondary: m.kind === 'dormancy' ? 'went dark' : `${m.counts.new_asns} ASN · ${m.counts.new_ips} IP${m.counts.new_serials ? ` · ${m.counts.new_serials} cert` : ''}`,
      trailing: relativeTime(m.at),
      target: { kind: 'movement', id: m.id, movement: m },
    }));
  return { title: 'Recent moves', empty: 'No infrastructure moves in this period.', rows };
}

export function actorRows(actors: readonly ActorListItem[] | undefined): PanelSection {
  const rows = [...(actors ?? [])]
    .sort((a, b) => b.cluster_count - a.cluster_count || a.name.localeCompare(b.name))
    .slice(0, PANEL_ROWS * 2)
    .map((a): PanelRow => ({
      key: a.id, primary: a.name,
      secondary: `${a.cluster_count} cluster${a.cluster_count === 1 ? '' : 's'} · ${a.infra_count} infrastructure`,
      target: { kind: 'actor', id: a.id, name: a.name },
    }));
  return { title: 'Known actors', empty: 'No actors are on file.', rows };
}

/** Fast weaponization (Threats lens, Fast view): countries ranked by fast-weaponized threats. */
export function velocityRows(model: VelocityModel | null): PanelSection {
  const rows = (model?.points ?? []).slice(0, PANEL_ROWS).map((p): PanelRow => ({
    key: p.cc, primary: countryName(p.cc) || p.cc,
    secondary: `${p.veryFast.toLocaleString()} very fast · ${p.fast.toLocaleString()} fast`,
    trailing: p.count.toLocaleString(),
    target: { kind: 'country', code: p.cc },
  }));
  return { title: 'Fastest to weaponize', empty: VELOCITY_FILLING, rows };
}

const rateTone = (share: number): PanelRow['tone'] => (share < 0.5 ? 'rising' : 'neutral');

/** Baseline > Takedowns: the hardest jurisdictions, lowest success share first, enough volume only. */
export function takedownCountryRows(model: TakedownCountryModel | null | undefined, window: string): PanelSection {
  const rows = (model?.hardest ?? []).slice(0, PANEL_ROWS).map((r): PanelRow => {
    const median = formatHours(r.median_hours);
    return {
      key: r.key, primary: countryName(r.key) || r.key,
      secondary: `${resolvedOf(r).toLocaleString()} resolved${median ? ` · median ${median}` : ''}`,
      trailing: pct(r.share as number),
      tone: rateTone(r.share as number),
      target: { kind: 'country', code: r.key },
    };
  });
  return {
    title: 'Hardest jurisdictions',
    empty: `No country has ${TAKEDOWN_MIN_RESOLVED}+ resolved takedowns in the last ${window} yet.`,
    rows,
  };
}

/** Hosting > Takedowns: the hardest hosts, lowest success share first, enough volume only. */
export function takedownProviderRows(
  model: TakedownProviderModel | null | undefined,
  providers: readonly ProviderGeo[] | undefined,
  window: string,
): PanelSection {
  const rows = (model?.hardest ?? []).slice(0, PANEL_ROWS).map((r): PanelRow => {
    const median = formatHours(r.median_hours);
    const provider = providers?.find(p => p.id === r.key) ?? null;
    return {
      key: r.key, primary: r.label,
      secondary: [`${resolvedOf(r).toLocaleString()} resolved`, median ? `median ${median}` : null, r.country ? countryName(iso2(r.country) ?? '') : null].filter(Boolean).join(' · '),
      trailing: pct(r.share as number),
      tone: rateTone(r.share as number),
      // Only a host the map and drawer know (it has active threats) can be opened.
      target: provider ? { kind: 'provider', id: provider.id, provider } : undefined,
    };
  });
  return {
    title: 'Hardest hosts',
    empty: `No host has ${TAKEDOWN_MIN_RESOLVED}+ resolved takedowns in the last ${window} yet.`,
    rows,
  };
}
