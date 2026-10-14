/**
 * Actors lens model: one actor's known infrastructure lit up on the map.
 *
 * Coverage is thin (attribution is rules-based, mostly OTX inheritance), so
 * every item carries its confidence and an empty result is reported as "no
 * attributed infrastructure" — NEVER as "this actor is inactive".
 */

import type { ActorDetail } from '@/hooks/useObservatoryLenses';
import type { LngLat } from '@/lib/country-centroids';
import { phaseForKey } from '../../anim/pulse';
import { greatCirclePath } from '../../anim/great-circle';
import { cumulativeDistances } from '../../anim/dash-flow-extension';
import { normalizeConfidence } from './operations';
import { countryCenter, iso2 } from './placement';

const CONFIDENCE_WORDS: Record<string, number> = {
  confirmed: 1, high: 0.85, probable: 0.7, medium: 0.6, possible: 0.45, low: 0.35, unknown: 0.3,
};

/** 0..1 for a confidence word ('high') or number (0..1 or 0..100); null when unreadable. */
export function confidenceValue(c: string | number | null | undefined): number | null {
  if (typeof c === 'number') return normalizeConfidence(c);
  if (typeof c === 'string') {
    const k = c.trim().toLowerCase();
    if (k in CONFIDENCE_WORDS) return CONFIDENCE_WORDS[k]!;
    const n = Number(k);
    if (k !== '' && Number.isFinite(n)) return normalizeConfidence(n);
  }
  return null;
}

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'unknown';

export function confidenceBand(v: number | null): ConfidenceBand {
  if (v === null) return 'unknown';
  if (v >= 0.75) return 'high';
  if (v >= 0.5) return 'medium';
  return 'low';
}

export interface ActorCountry {
  country: string;
  position: LngLat;
  /** Best confidence among the items placed here (0..1), null if none had one. */
  confidence: number | null;
  /** Infrastructure rows + clusters placed here. */
  items: number;
  asns: string[];
  phase: number;
}

export interface ActorAsn {
  asn: string;
  country: string | null;
  provider: string | null;
  confidence: number | null;
  lastObserved: string | null;
}

export interface ActorEdge {
  id: string;
  clusterId: string;
  confidence: number | null;
  path: LngLat[];
  distances: number[];
}

export interface ActorModel {
  actorId: string;
  countries: ActorCountry[];
  /** A cluster spans several countries: a star from its first placeable country. */
  edges: ActorEdge[];
  asns: ActorAsn[];
  clusters: Array<{ id: string; countries: string[]; asns: string[]; confidence: number | null }>;
  /** Items with a country that has no centroid, or no country at all. */
  unplaced: number;
  /** True when the actor has no placeable infrastructure at all. */
  empty: boolean;
}

export function buildActorModel(detail: ActorDetail): ActorModel {
  const countries = new Map<string, ActorCountry>();
  let unplaced = 0;

  const touch = (rawCc: string | null, conf: number | null, asn: string | null): void => {
    const cc = iso2(rawCc);
    const center = cc ? countryCenter(cc) : null;
    if (!cc || !center) { unplaced++; return; }
    let c = countries.get(cc);
    if (!c) {
      c = { country: cc, position: center, confidence: null, items: 0, asns: [], phase: phaseForKey(detail.actor.id) };
      countries.set(cc, c);
    }
    c.items++;
    if (conf !== null && (c.confidence === null || conf > c.confidence)) c.confidence = conf;
    if (asn && !c.asns.includes(asn)) c.asns.push(asn);
  };

  const asns: ActorAsn[] = [];
  for (const i of detail.infrastructure) {
    const conf = confidenceValue(i.confidence);
    touch(i.country_code, conf, i.asn);
    if (i.asn) {
      asns.push({ asn: i.asn, country: iso2(i.country_code), provider: i.hosting_provider, confidence: conf, lastObserved: i.last_observed });
    }
  }
  const clusters = detail.clusters.map(cl => {
    const conf = normalizeConfidence(cl.confidence_score);
    // A cluster spans several countries: it lights each of them once.
    for (const cc of cl.countries) touch(cc, conf, null);
    return { id: cl.id, countries: cl.countries, asns: cl.asns, confidence: conf };
  });

  const edges: ActorEdge[] = [];
  for (const cl of clusters) {
    const placed: Array<{ cc: string; at: LngLat }> = [];
    for (const raw of cl.countries) {
      const cc = iso2(raw);
      const at = cc ? countryCenter(cc) : null;
      if (cc && at && !placed.some(p => p.cc === cc)) placed.push({ cc, at });
    }
    for (let i = 1; i < placed.length; i++) {
      const path = greatCirclePath(placed[0]!.at, placed[i]!.at, 24);
      edges.push({ id: `${cl.id}:${placed[0]!.cc}-${placed[i]!.cc}`, clusterId: cl.id, confidence: cl.confidence, path, distances: cumulativeDistances(path) });
    }
  }

  const list = [...countries.values()].sort((a, b) => b.items - a.items || a.country.localeCompare(b.country));
  return { actorId: detail.actor.id, countries: list, edges, asns, clusters, unplaced, empty: list.length === 0 };
}
