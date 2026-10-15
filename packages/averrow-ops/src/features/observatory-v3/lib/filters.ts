/**
 * Observatory data filters: severity (`sev`), threat type (`type`) and brand (`brand`).
 *
 *   severity    applied on the client to the threat NODES now, from the per-severity counts every node carries
 *               (`critical` / `high` / `medium` / `low`): a node keeps only the selected severities' counts, takes the
 *               highest selected severity as its colour and drops out when none is left. It is ALSO sent to the server
 *               (`severity=`) so the arcs and stats follow once the backend honours it; the two agree, so the node filter
 *               is idempotent on a server that already filtered.
 *   type/brand  server-side only (a node carries one top type, not a type breakdown, so there is nothing to filter on).
 *
 * Pure: the page memoises on the inputs, so a filtered array keeps its identity until the nodes or the filter change.
 */

import type { ArcData, ObservatoryFilters, ThreatPoint } from '@/hooks/useObservatory';
import { typeLabel } from './map-colors';
import { SEVERITY_IDS, THREAT_TYPE_IDS, type ObservatoryPatch, type ObservatoryUrlState, type Severity } from './url-state';

/** The slice of the URL state the filters are made of. */
export type FilterState = Pick<ObservatoryUrlState, 'sev' | 'type' | 'brand'>;

/** The threat types offered in the multi-select: exactly the ones the API accepts (the `threats.threat_type` CHECK values). */
export const TYPE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = THREAT_TYPE_IDS.map(id => ({ id, label: typeLabel(id) }));

/** True when any filter is on. */
export function hasActiveFilters(f: FilterState): boolean {
  return f.sev.length > 0 || f.type.length > 0 || !!f.brand;
}

/** The query params the data hooks send (`severity`, `threat_type`, `brand`); only the ones that are set. */
export function filtersToParams(f: FilterState): ObservatoryFilters {
  return {
    ...(f.sev.length > 0 ? { severity: f.sev.join(',') } : {}),
    ...(f.type.length > 0 ? { threat_type: f.type.join(',') } : {}),
    ...(f.brand ? { brand: f.brand } : {}),
  };
}

/**
 * Keep only the selected severities on each node. With no selection the SAME array comes back (identity preserved);
 * a node with nothing left in the selection is dropped.
 */
export function filterNodesBySeverity(nodes: ThreatPoint[], sev: readonly Severity[]): ThreatPoint[] {
  if (sev.length === 0 || sev.length >= SEVERITY_IDS.length) return nodes;
  const on = new Set<string>(sev);
  const out: ThreatPoint[] = [];
  for (const n of nodes) {
    const critical = on.has('critical') ? n.critical : 0;
    const high = on.has('high') ? n.high : 0;
    const medium = on.has('medium') ? n.medium : 0;
    const low = on.has('low') ? n.low : 0;
    const total = critical + high + medium + low;
    if (total <= 0) continue;
    const top: Severity = critical > 0 ? 'critical' : high > 0 ? 'high' : medium > 0 ? 'medium' : 'low';
    out.push({ ...n, critical, high, medium, low, threat_count: total, top_severity: top });
  }
  return out;
}

export type FilterKind = 'sev' | 'type' | 'brand';
export interface FilterChip {
  /** Stable key. */
  key: string;
  kind: FilterKind;
  /** The value removed with this chip (a severity, a type id, the brand name). */
  value: string;
  /** What the chip says. */
  label: string;
  /** Extra words after the label (the brand chip says where it applies). */
  note?: string;
  /** Accessible name of the remove button. */
  removeLabel: string;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Where the brand filter applies: /nodes has no brand dimension, so the node layer is not narrowed by it. */
export const BRAND_SCOPE_NOTE = 'applies to arcs and stats';

/** What the brand chip says before the brand's name is known (a link carries the id only): never the raw id. */
export const BRAND_FILTER_FALLBACK_LABEL = 'Brand filter';

/** One removable chip per active filter value. `brandName` is the brand's display name (the filter itself is its id). */
export function filterChips(f: FilterState, brandName?: string | null): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const s of f.sev) chips.push({ key: `sev:${s}`, kind: 'sev', value: s, label: cap(s), removeLabel: `Remove ${s} severity filter` });
  for (const t of f.type) chips.push({ key: `type:${t}`, kind: 'type', value: t, label: cap(typeLabel(t)), removeLabel: `Remove ${typeLabel(t)} type filter` });
  if (f.brand) {
    const name = brandName || BRAND_FILTER_FALLBACK_LABEL;
    chips.push({ key: `brand:${f.brand}`, kind: 'brand', value: f.brand, label: name, note: BRAND_SCOPE_NOTE, removeLabel: `Remove brand filter ${name}` });
  }
  return chips;
}

/** The URL patch that removes one chip's value. */
export function removeFilterPatch(f: FilterState, kind: FilterKind, value: string): ObservatoryPatch {
  if (kind === 'sev') return { sev: f.sev.filter(s => s !== value) };
  if (kind === 'type') return { type: f.type.filter(t => t !== value) };
  return { brand: null };
}

/** The patch that turns every filter off. */
export const CLEAR_FILTERS_PATCH: ObservatoryPatch = { sev: [], type: [], brand: null };

/** Toggle one severity in the selection (the result may be empty = all). */
export function toggleSeverity(sev: readonly Severity[], id: Severity): Severity[] {
  return sev.includes(id) ? sev.filter(s => s !== id) : SEVERITY_IDS.filter(s => s === id || sev.includes(s));
}

/** Toggle one threat type in the selection. */
export function toggleType(types: readonly string[], id: string): string[] {
  return types.includes(id) ? types.filter(t => t !== id) : [...types, id].sort();
}

/** A brand from a list the page already holds (the side panel's top brands). */
export interface FallbackBrand { id: string; name: string; threat_count?: number | null }
// `threat_count` is deliberately not used: `/api/brands?view=top` ignores `range` (all-time count), so it would not agree with the
// arcs' period volumes. A fallback brand carries volume 0 and the search lists it without a count, after the arc brands.

/**
 * The brand filter is picked from the arcs' brands, and only an arc that carries `target_brand_id` can be picked. The arcs
 * response is KV-cached for up to ~2h, so right after a deploy that added the id every cached arc lacks it and the filter
 * would list no brands at all. This tops the arcs up with brands from another already-fetched source (top brands), for the
 * FILTER's search only: each added entry is an `ArcData` stand-in that carries identity (id, name; volume 0) and nothing the
 * filter reads beyond that (picking uses the id and the label, never the arc's geometry). Brands whose id the arcs already
 * carry are not repeated; the arcs themselves are returned untouched when nothing is added.
 */
export function withFallbackBrands(arcs: readonly ArcData[] | undefined, brands: readonly FallbackBrand[] | undefined): readonly ArcData[] | undefined {
  if (!Array.isArray(brands) || brands.length === 0) return arcs; // a malformed reply is no brands, not a crash
  const have = new Set<string>();
  for (const a of arcs ?? []) if (a.target_brand_id) have.add(a.target_brand_id);
  const extra: ArcData[] = [];
  for (const b of brands) {
    if (!b.id || !b.name || have.has(b.id)) continue;
    have.add(b.id);
    extra.push({
      sourcePosition: [0, 0], targetPosition: [0, 0], threat_type: '', severity: '', source_region: '',
      target_brand: b.name, target_brand_id: b.id, brand_name: b.name, volume: 0,
    });
  }
  return extra.length > 0 ? [...(arcs ?? []), ...extra] : arcs;
}

/** True when the arcs carry at least one brand id (so the filter has something to offer). */
export function hasBrandIds(arcs: readonly ArcData[] | undefined): boolean {
  return !!arcs && arcs.some(a => !!a.target_brand_id);
}
