/**
 * Drill-in selection model. One discriminated union covers everything the
 * drawer can show (node, arc, country, operation, provider, actor, campaign,
 * movement); it is resolved from the URL keys against the data currently loaded,
 * and turned back into a URL patch when the analyst picks something.
 *
 * "Loaded" matters: while a lens query hasn't returned yet (`undefined`) the
 * selection resolves to a pending target (object = null) so the URL isn't
 * discarded; once it HAS returned and the object is absent, resolution yields
 * null and the caller drops the dead key.
 */

import type { ArcData, ThreatPoint } from '@/hooks/useObservatory';
import type {
  ActorListItem, CampaignGeo, Movement, OperationGeo, OverindexRow, ProviderGeo, TakedownGeoRow,
} from '@/hooks/useObservatoryLenses';
import { countryName } from './country-name';
import { arcKey, nodeKey, parseSel, selValue, type ObservatoryPatch, type SelKind } from './url-state';
import type { MapSelection } from './selection';
import { iso2 } from './lens/placement';

export type DrillTarget =
  | { kind: 'node'; node: ThreatPoint }
  | { kind: 'arc'; arc: ArcData }
  | { kind: 'country'; code: string }
  | { kind: 'operation'; id: string; op: OperationGeo | null }
  | { kind: 'provider'; id: string; provider: ProviderGeo | null }
  | { kind: 'actor'; id: string; name: string | null }
  | { kind: 'campaign'; id: string; campaign: CampaignGeo | null }
  | { kind: 'movement'; id: string; movement: Movement | null };

export interface DrillData {
  threats?: readonly ThreatPoint[];
  arcs?: readonly ArcData[];
  operations?: readonly OperationGeo[];
  providers?: readonly ProviderGeo[];
  campaigns?: readonly CampaignGeo[];
  movements?: readonly Movement[];
  actors?: readonly ActorListItem[];
  overindex?: readonly OverindexRow[];
  /**
   * Takedown outcomes (`/takedowns-geo`; roles holding `manage_takedowns` only, so these stay undefined for everyone
   * else). `takedownWindow` is the server window they cover ('30d' | '90d').
   */
  takedownCountries?: readonly TakedownGeoRow[];
  takedownProviders?: readonly TakedownGeoRow[];
  takedownWindow?: string;
  /** The country takedown request failed (so "loading" is not forever). */
  takedownCountriesError?: boolean;
}

export interface DrillUrl {
  node: string | null;
  arc: string | null;
  sel: string | null;
}

export function drillKey(t: DrillTarget): string {
  switch (t.kind) {
    case 'node': return `node:${nodeKey(t.node)}`;
    case 'arc': return `arc:${arcKey(t.arc)}`;
    default: return `${t.kind}:${'code' in t ? t.code : t.id}`;
  }
}

export function resolveDrill(url: DrillUrl, data: DrillData): DrillTarget | null {
  if (url.node) {
    const node = data.threats?.find(t => nodeKey(t) === url.node);
    return node ? { kind: 'node', node } : null;
  }
  if (url.arc) {
    const arc = data.arcs?.find(a => arcKey(a) === url.arc);
    return arc ? { kind: 'arc', arc } : null;
  }
  const sel = parseSel(url.sel);
  if (!sel) return null;
  switch (sel.kind) {
    case 'country':
      return { kind: 'country', code: sel.id };
    case 'op': {
      if (!data.operations) return { kind: 'operation', id: sel.id, op: null };
      const op = data.operations.find(o => o.id === sel.id);
      return op ? { kind: 'operation', id: sel.id, op } : null;
    }
    case 'provider': {
      if (!data.providers) return { kind: 'provider', id: sel.id, provider: null };
      const provider = data.providers.find(p => p.id === sel.id);
      return provider ? { kind: 'provider', id: sel.id, provider } : null;
    }
    case 'actor': {
      // The actor detail endpoint is the source of truth (404 => the drawer says so); the list only supplies the name.
      const name = data.actors?.find(a => a.id === sel.id)?.name ?? null;
      return { kind: 'actor', id: sel.id, name };
    }
    case 'campaign': {
      if (!data.campaigns) return { kind: 'campaign', id: sel.id, campaign: null };
      const campaign = data.campaigns.find(c => c.id === sel.id);
      return campaign ? { kind: 'campaign', id: sel.id, campaign } : null;
    }
    case 'move': {
      if (!data.movements) return { kind: 'movement', id: sel.id, movement: null };
      const movement = data.movements.find(m => m.id === sel.id);
      return movement ? { kind: 'movement', id: sel.id, movement } : null;
    }
  }
}

/** True when the target's data is still on its way (so the drawer shows a loading state, not an error). */
export function isPending(t: DrillTarget): boolean {
  switch (t.kind) {
    case 'operation': return t.op === null;
    case 'provider': return t.provider === null;
    case 'campaign': return t.campaign === null;
    case 'movement': return t.movement === null;
    default: return false;
  }
}

/** The URL patch that selects `t` (clearing the other selection kinds). */
export function drillToPatch(t: DrillTarget | null): Pick<ObservatoryPatch, 'node' | 'arc' | 'sel'> {
  if (!t) return { node: null, arc: null, sel: null };
  switch (t.kind) {
    case 'node': return { node: nodeKey(t.node), arc: null, sel: null };
    case 'arc': return { node: null, arc: arcKey(t.arc), sel: null };
    case 'country': return { node: null, arc: null, sel: selValue('country', t.code) };
    case 'operation': return { node: null, arc: null, sel: selValue('op', t.id) };
    case 'provider': return { node: null, arc: null, sel: selValue('provider', t.id) };
    case 'actor': return { node: null, arc: null, sel: selValue('actor', t.id) };
    case 'campaign': return { node: null, arc: null, sel: selValue('campaign', t.id) };
    case 'movement': return { node: null, arc: null, sel: selValue('move', t.id) };
  }
}

export function selPatch(kind: SelKind, id: string): Pick<ObservatoryPatch, 'node' | 'arc' | 'sel'> {
  return { node: null, arc: null, sel: selValue(kind, id) };
}

export function drillFromMapSelection(s: MapSelection): DrillTarget {
  return s.kind === 'node' ? { kind: 'node', node: s.node } : { kind: 'arc', arc: s.arc };
}

export function drillTitle(t: DrillTarget): string {
  switch (t.kind) {
    case 'node': return `${t.node.threat_count.toLocaleString()} threat${t.node.threat_count === 1 ? '' : 's'}`;
    case 'arc': return (t.arc.threat_type ?? '').replace(/_/g, ' ') || 'Threat corridor';
    case 'country': return countryName(t.code) || t.code;
    case 'operation': return t.op?.name ?? `Operation ${t.id}`;
    case 'provider': return t.provider?.name ?? 'Hosting provider';
    case 'actor': return t.name ?? 'Threat actor';
    case 'campaign': return t.campaign?.name ?? 'Campaign';
    case 'movement': return t.movement?.cluster_name ?? 'Infrastructure movement';
  }
}

export function drillEyebrow(t: DrillTarget): string {
  switch (t.kind) {
    case 'node': return 'Threat origin';
    case 'arc': return 'Attack corridor';
    case 'country': return 'Country';
    case 'operation': return 'Operation';
    case 'provider': return 'Hosting provider';
    case 'actor': return 'Threat actor';
    case 'campaign': return 'Campaign · curated';
    case 'movement': return t.movement?.kind === 'dormancy' ? 'Went dark' : 'Infrastructure movement';
  }
}

// ─── Country facts ──────────────────────────────────────────

export interface CountryFacts {
  code: string;
  name: string;
  /** Sum of node threat counts for the country; null when node data isn't loaded. */
  threats: number | null;
  severity: { critical: number; high: number; medium: number; low: number } | null;
  topTypes: Array<{ type: string; count: number }>;
  /** Brands attacked FROM this country (arc volume), biggest first. */
  brands: Array<{ name: string; volume: number }>;
  operations: OperationGeo[];
  providers: ProviderGeo[];
  overindex: OverindexRow | null;
}

export function countryFacts(codeRaw: string, data: DrillData): CountryFacts {
  const code = iso2(codeRaw) ?? codeRaw.toUpperCase();
  const nodes = data.threats?.filter(n => iso2(n.country_code) === code);
  let threats: number | null = null;
  let severity: CountryFacts['severity'] = null;
  const types = new Map<string, number>();
  if (nodes) {
    threats = 0;
    severity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const n of nodes) {
      threats += n.threat_count;
      severity.critical += n.critical;
      severity.high += n.high;
      severity.medium += n.medium;
      severity.low += n.low;
      if (n.top_threat_type) types.set(n.top_threat_type, (types.get(n.top_threat_type) ?? 0) + n.threat_count);
    }
  }
  const brandVolume = new Map<string, number>();
  for (const a of data.arcs ?? []) {
    if (iso2(a.source_region) !== code) continue;
    const name = a.brand_name ?? a.target_brand;
    if (!name) continue;
    brandVolume.set(name, (brandVolume.get(name) ?? 0) + a.volume);
  }
  return {
    code,
    name: countryName(code),
    threats,
    severity,
    topTypes: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count).slice(0, 3),
    brands: [...brandVolume.entries()].map(([name, volume]) => ({ name, volume })).sort((a, b) => b.volume - a.volume).slice(0, 5),
    operations: (data.operations ?? []).filter(o => o.countries.some(c => iso2(c) === code)),
    providers: (data.providers ?? []).filter(p => iso2(p.country) === code).sort((a, b) => b.active_threat_count - a.active_threat_count).slice(0, 5),
    overindex: data.overindex?.find(r => r.country_code === code) ?? null,
  };
}
