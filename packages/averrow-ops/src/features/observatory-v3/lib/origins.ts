/**
 * "Top Threat Origins" aggregation for the side panel: per-country totals plus
 * the busiest node that can actually be placed on the map (the keyboard path to
 * selecting it). Pure, so the selection rule is unit-tested.
 */

import type { ThreatPoint } from '@/hooks/useObservatory';
import { hasValidPoint } from './geo';

export interface OriginRow {
  code: string;
  /** Total threats across EVERY node of the country (placeable or not). */
  count: number;
  /** Busiest node with a valid position, or null when none of them is on the map. */
  node: ThreatPoint | null;
}

export function topOrigins(nodes: readonly ThreatPoint[] | undefined, limit = 6): OriginRow[] {
  const byCountry = new Map<string, OriginRow>();
  for (const n of nodes ?? []) {
    if (!n.country_code) continue;
    const placeable = hasValidPoint(n);
    const cur = byCountry.get(n.country_code);
    if (!cur) {
      byCountry.set(n.country_code, { code: n.country_code, count: n.threat_count, node: placeable ? n : null });
    } else {
      cur.count += n.threat_count;
      if (placeable && (!cur.node || n.threat_count > cur.node.threat_count)) cur.node = n;
    }
  }
  return [...byCountry.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
