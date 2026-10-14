/**
 * Observatory search over data already loaded on the client: countries, brands
 * (arc targets), ASNs, operations, hosting providers, actors and campaigns.
 * Pure: the index is built from whatever the page holds, the ranking is simple
 * and deterministic, and picking a result produces a URL patch (lens + selection).
 */

import type { ArcData, ThreatPoint } from '@/hooks/useObservatory';
import type { ActorListItem, CampaignGeo, OperationGeo, ProviderGeo } from '@/hooks/useObservatoryLenses';
import { COUNTRY_CODES } from '../anim/country-index';
import { countryName } from './country-name';
import { iso2 } from './lens/placement';
import type { DrillTarget } from './drill';
import { drillToPatch } from './drill';
import type { LayerId, LayerToggles, LensId } from './lenses';
import type { ObservatoryPatch } from './url-state';

export type SearchKind = 'country' | 'brand' | 'asn' | 'operation' | 'provider' | 'actor' | 'campaign';

export interface SearchData {
  threats?: readonly ThreatPoint[];
  arcs?: readonly ArcData[];
  operations?: readonly OperationGeo[];
  providers?: readonly ProviderGeo[];
  actors?: readonly ActorListItem[];
  campaigns?: readonly CampaignGeo[];
}

export interface SearchEntry {
  key: string;
  kind: SearchKind;
  label: string;
  sublabel: string;
  target: DrillTarget;
  /** Lower-cased strings the query is matched against: [primary, ...secondary]. */
  hay: string[];
  weight: number;
}

export interface SearchResult {
  key: string;
  kind: SearchKind;
  label: string;
  sublabel: string;
  target: DrillTarget;
  score: number;
}

const KIND_WEIGHT: Record<SearchKind, number> = {
  operation: 6, actor: 5, country: 5, provider: 4, brand: 4, asn: 3, campaign: 3,
};

const KIND_NOUN: Record<SearchKind, string> = {
  country: 'Country', brand: 'Brand', asn: 'ASN', operation: 'Operation', provider: 'Provider', actor: 'Actor', campaign: 'Campaign',
};
export function kindNoun(k: SearchKind): string {
  return KIND_NOUN[k];
}

export function normAsn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(?:AS)?\s*(\d{1,10})$/i.exec(raw.trim());
  return m ? `AS${m[1]}` : null;
}

const lc = (s: string): string => s.toLowerCase();

export function buildSearchIndex(data: SearchData): SearchEntry[] {
  const out: SearchEntry[] = [];

  // Countries: every known country (names come from Intl), with the count when nodes are loaded.
  const perCountry = new Map<string, number>();
  for (const n of data.threats ?? []) {
    const cc = iso2(n.country_code);
    if (cc) perCountry.set(cc, (perCountry.get(cc) ?? 0) + n.threat_count);
  }
  for (const code of COUNTRY_CODES) {
    const name = countryName(code);
    const count = perCountry.get(code);
    out.push({
      key: `country:${code}`, kind: 'country', label: name, sublabel: count ? `${code} · ${count.toLocaleString()} threats` : code,
      target: { kind: 'country', code }, hay: [lc(name), lc(code)], weight: KIND_WEIGHT.country + (count ? 1 : 0),
    });
  }

  // Brands: the biggest arc per target brand.
  const bestArc = new Map<string, ArcData>();
  const brandVolume = new Map<string, number>();
  for (const a of data.arcs ?? []) {
    const name = a.brand_name ?? a.target_brand;
    if (!name) continue;
    brandVolume.set(name, (brandVolume.get(name) ?? 0) + a.volume);
    const cur = bestArc.get(name);
    if (!cur || a.volume > cur.volume) bestArc.set(name, a);
  }
  for (const [name, arc] of bestArc) {
    out.push({
      key: `brand:${name}`, kind: 'brand', label: name, sublabel: `${brandVolume.get(name)!.toLocaleString()} threats targeted`,
      target: { kind: 'arc', arc }, hay: [lc(name)], weight: KIND_WEIGHT.brand,
    });
  }

  // ASNs: providers first (they have a lens to land on), then operations.
  const asnSeen = new Set<string>();
  for (const p of data.providers ?? []) {
    const asn = normAsn(p.asn);
    if (asn && !asnSeen.has(asn)) {
      asnSeen.add(asn);
      out.push({
        key: `asn:${asn}`, kind: 'asn', label: asn, sublabel: p.name,
        target: { kind: 'provider', id: p.id, provider: p }, hay: [lc(asn), lc(p.name)], weight: KIND_WEIGHT.asn,
      });
    }
    out.push({
      key: `provider:${p.id}`, kind: 'provider', label: p.name, sublabel: [p.asn, p.country].filter(Boolean).join(' · '),
      target: { kind: 'provider', id: p.id, provider: p }, hay: [lc(p.name), lc(p.asn ?? '')], weight: KIND_WEIGHT.provider,
    });
  }
  for (const o of data.operations ?? []) {
    const name = o.name ?? o.id;
    out.push({
      key: `operation:${o.id}`, kind: 'operation', label: name,
      sublabel: [o.actor?.name, `${o.countries.length} countr${o.countries.length === 1 ? 'y' : 'ies'}`].filter(Boolean).join(' · '),
      target: { kind: 'operation', id: o.id, op: o },
      hay: [lc(name), lc(o.id), ...(o.actor ? [lc(o.actor.name)] : [])], weight: KIND_WEIGHT.operation,
    });
    for (const raw of o.asns) {
      const asn = normAsn(raw);
      if (!asn || asnSeen.has(asn)) continue;
      asnSeen.add(asn);
      out.push({
        key: `asn:${asn}`, kind: 'asn', label: asn, sublabel: `in ${name}`,
        target: { kind: 'operation', id: o.id, op: o }, hay: [lc(asn)], weight: KIND_WEIGHT.asn,
      });
    }
  }

  for (const a of data.actors ?? []) {
    out.push({
      key: `actor:${a.id}`, kind: 'actor', label: a.name, sublabel: `${a.cluster_count} cluster${a.cluster_count === 1 ? '' : 's'} · ${a.infra_count} infra`,
      target: { kind: 'actor', id: a.id, name: a.name }, hay: [lc(a.name)], weight: KIND_WEIGHT.actor,
    });
  }
  for (const c of data.campaigns ?? []) {
    out.push({
      key: `campaign:${c.id}`, kind: 'campaign', label: c.name, sublabel: [c.status, c.conflict].filter(Boolean).join(' · ') || 'curated',
      target: { kind: 'campaign', id: c.id, campaign: c }, hay: [lc(c.name), lc(c.conflict ?? '')], weight: KIND_WEIGHT.campaign,
    });
  }
  return out;
}

function scoreEntry(e: SearchEntry, q: string, asnQuery: string | null): number {
  const primary = e.hay[0]!;
  if (primary === q || (asnQuery && primary === asnQuery)) return 100;
  if (primary.startsWith(q) || (asnQuery && primary.startsWith(asnQuery))) return 80;
  if (primary.split(/[\s\-_/.,()]+/).some(w => w.startsWith(q))) return 60;
  if (primary.includes(q)) return 40;
  for (let i = 1; i < e.hay.length; i++) {
    const h = e.hay[i]!;
    if (h === q) return 50;
    if (h.startsWith(q)) return 30;
    if (h.includes(q)) return 20;
  }
  return 0;
}

export function runSearch(index: readonly SearchEntry[], query: string, limit = 8): SearchResult[] {
  const q = lc(query.trim());
  if (q.length < 2) return [];
  const asnQuery = /^\d{2,10}$/.test(q) ? `as${q}` : null;
  const scored: SearchResult[] = [];
  for (const e of index) {
    const s = scoreEntry(e, q, asnQuery);
    if (s > 0) scored.push({ key: e.key, kind: e.kind, label: e.label, sublabel: e.sublabel, target: e.target, score: s * 10 + e.weight });
  }
  scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored.slice(0, limit);
}

/** The lens + layer a kind of target is drawn on (absent = visible on any lens). */
const TARGET_LAYER: Partial<Record<DrillTarget['kind'], { layer: LayerId; lens: LensId }>> = {
  operation: { layer: 'operations', lens: 'operations' },
  provider: { layer: 'hosting', lens: 'hosting' },
  actor: { layer: 'actors', lens: 'actors' },
  campaign: { layer: 'campaigns', lens: 'campaigns' },
  movement: { layer: 'movement', lens: 'movement' },
};

/**
 * URL patch for selecting `target`: select it, and switch lens only when the
 * layer it is drawn on isn't already on (so a country opened from the Hosting
 * lens stays on Hosting, but an operation opened from it flips to Operations).
 */
export function targetPatch(target: DrillTarget, layers: LayerToggles): ObservatoryPatch {
  const need = TARGET_LAYER[target.kind];
  const patch: ObservatoryPatch = { ...drillToPatch(target), mode: 'global' };
  if (need && !layers[need.layer]) patch.lens = need.lens;
  // A node / corridor needs the threat layers that provide its data.
  if ((target.kind === 'arc' || target.kind === 'node') && !(layers.nodes || layers.particles || layers.beams)) patch.lens = 'threats';
  return patch;
}

/** Picking a search result: its target's patch (an ASN resolves to a provider or operation target). */
export function searchPatch(result: Pick<SearchResult, 'kind' | 'target'>, layers: LayerToggles): ObservatoryPatch {
  return targetPatch(result.target, layers);
}
