/**
 * Campaigns lens model: curated geopolitical campaigns as adversary → target
 * country arcs. These are CURATED (an analyst's framing), not observed traffic:
 * they use a distinct dashed style and the legend / drawer say "curated".
 */

import type { CampaignGeo } from '@/hooks/useObservatoryLenses';
import type { LngLat } from '@/lib/country-centroids';
import type { Rgba } from '../map-colors';
import { greatCirclePath } from '../../anim/great-circle';
import { cumulativeDistances } from '../../anim/dash-flow-extension';
import { countryCenter, iso2 } from './placement';

export interface CampaignArc {
  id: string;
  campaignId: string;
  name: string;
  active: boolean;
  from: string;
  to: string;
  path: LngLat[];
  distances: number[];
  color: Rgba;
}

export interface CampaignsModel {
  arcs: CampaignArc[];
  /** Campaigns that produced at least one arc. */
  drawn: Set<string>;
  /** Country entries without a centroid. */
  unplaced: number;
  byId: Map<string, CampaignGeo>;
  /** Pairs dropped by the per-campaign / total caps. */
  truncated: number;
}

export const MAX_ADVERSARIES = 4;
export const MAX_TARGETS = 8;
export const MAX_ARCS = 400;

export const ACTIVE_COLOR: Rgba = [244, 114, 182, 215];
export const HISTORIC_COLOR: Rgba = [168, 140, 160, 120];

export function isActiveCampaign(status: string | null): boolean {
  return (status ?? '').toLowerCase() === 'active';
}

function countries(list: readonly string[], cap: number): { codes: string[]; unplaced: number; dropped: number } {
  const seen = new Set<string>();
  const codes: string[] = [];
  let unplaced = 0;
  let dropped = 0;
  for (const raw of list) {
    const cc = iso2(raw);
    if (!cc || seen.has(cc)) continue;
    seen.add(cc);
    if (!countryCenter(cc)) { unplaced++; continue; }
    if (codes.length >= cap) { dropped++; continue; }
    codes.push(cc);
  }
  return { codes, unplaced, dropped };
}

export function buildCampaignsModel(campaigns: readonly CampaignGeo[]): CampaignsModel {
  const arcs: CampaignArc[] = [];
  const drawn = new Set<string>();
  const byId = new Map<string, CampaignGeo>();
  let unplaced = 0;
  let truncated = 0;
  // Active campaigns first, so the arc cap never drops a live campaign for an old one.
  const ordered = [...campaigns].sort((a, b) => Number(isActiveCampaign(b.status)) - Number(isActiveCampaign(a.status)));
  for (const c of ordered) {
    byId.set(c.id, c);
    const adv = countries(c.adversary_countries, MAX_ADVERSARIES);
    const tgt = countries(c.target_countries, MAX_TARGETS);
    unplaced += adv.unplaced + tgt.unplaced;
    truncated += adv.dropped * Math.max(1, tgt.codes.length) + tgt.dropped * Math.max(1, adv.codes.length);
    const active = isActiveCampaign(c.status);
    for (const from of adv.codes) {
      for (const to of tgt.codes) {
        if (from === to) continue;
        if (arcs.length >= MAX_ARCS) { truncated++; continue; }
        const path = greatCirclePath(countryCenter(from)!, countryCenter(to)!, 28);
        arcs.push({
          id: `${c.id}:${from}-${to}`, campaignId: c.id, name: c.name, active, from, to,
          path, distances: cumulativeDistances(path), color: active ? ACTIVE_COLOR : HISTORIC_COLOR,
        });
        drawn.add(c.id);
      }
    }
  }
  return { arcs, drawn, unplaced, byId, truncated };
}
