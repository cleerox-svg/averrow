/**
 * Live sonar pings: turn newly-arrived /live items into ring spawns at their
 * origin country plus a screen-reader announcement.
 *
 * The poll returns the latest N items every time; only ids not seen before are
 * "new". The first batch only seeds the seen-set (the page just loaded: nothing
 * "just arrived"), and the set is bounded so a long session can't grow it.
 */

import type { LiveThreatEntry } from '@/hooks/useObservatory';
import type { LngLat } from '@/lib/country-centroids';
import { getSeverityColor, typeLabel, type Rgba } from '../map-colors';
import { countryCenter, iso2 } from './placement';

export interface PingItem {
  id: string;
  /** Origin country centroid; null when the country is unknown (announced, not drawn). */
  position: LngLat | null;
  color: Rgba;
  severity: string | null;
  type: string;
  country: string | null;
  domain: string | null;
}

export const SEEN_CAP = 400;

export function diffLive(
  seen: Set<string>,
  items: readonly LiveThreatEntry[] | undefined,
  primed: boolean,
): PingItem[] {
  const fresh: PingItem[] = [];
  for (const it of items ?? []) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (!primed) continue;
    const cc = iso2(it.country_code);
    fresh.push({
      id: it.id,
      position: cc ? countryCenter(cc) : null,
      color: getSeverityColor(it.severity, 235),
      severity: it.severity,
      type: it.threat_type,
      country: cc,
      domain: it.malicious_domain,
    });
  }
  if (seen.size > SEEN_CAP) {
    // Drop the oldest entries (Set iterates in insertion order).
    let drop = seen.size - SEEN_CAP;
    for (const id of seen) {
      if (drop-- <= 0) break;
      seen.delete(id);
    }
  }
  return fresh;
}

/** "New phishing threat from DE: evil.example" / "3 new threats: 2 phishing, 1 c2". */
export function announcePings(items: readonly PingItem[]): string {
  if (items.length === 0) return '';
  const one = (p: PingItem): string =>
    `New ${typeLabel(p.type) || 'threat'}${p.type ? ' threat' : ''}${p.country ? ` from ${p.country}` : ''}${p.domain ? `: ${p.domain}` : ''}`;
  if (items.length === 1) return one(items[0]!);
  const counts = new Map<string, number>();
  for (const p of items) {
    const k = typeLabel(p.type) || 'unclassified';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`);
  return `${items.length} new threats: ${parts.join(', ')}`;
}
