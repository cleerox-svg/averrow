import { describe, it, expect } from 'vitest';
import type { ThreatPoint } from '@/hooks/useObservatory';
import {
  filterNodesBySeverity, filtersToParams, filterChips, removeFilterPatch, hasActiveFilters, toggleSeverity, toggleType,
  TYPE_OPTIONS, BRAND_SCOPE_NOTE, CLEAR_FILTERS_PATCH,
} from './filters';
import { THREAT_TYPE_IDS } from './url-state';

const node = (over: Partial<ThreatPoint> = {}): ThreatPoint => ({
  lat: 1, lng: 2, threat_count: 10, top_severity: 'critical', critical: 3, high: 4, medium: 2, low: 1,
  country_code: 'NL', top_threat_type: 'phishing', ...over,
});

describe('filterNodesBySeverity (client-side, from the per-severity counts)', () => {
  it('no selection (or all four) hands back the same array', () => {
    const nodes = [node()];
    expect(filterNodesBySeverity(nodes, [])).toBe(nodes);
    expect(filterNodesBySeverity(nodes, ['critical', 'high', 'medium', 'low'])).toBe(nodes);
  });

  it('keeps only the selected severities\' counts and recomputes the total', () => {
    const [n] = filterNodesBySeverity([node()], ['high', 'low']);
    expect(n).toMatchObject({ critical: 0, high: 4, medium: 0, low: 1, threat_count: 5 });
  });

  it('colours a node by the highest SELECTED severity that is present', () => {
    expect(filterNodesBySeverity([node()], ['high', 'medium'])[0]!.top_severity).toBe('high');
    expect(filterNodesBySeverity([node({ critical: 0 })], ['critical', 'medium'])[0]!.top_severity).toBe('medium');
  });

  it('drops a node with nothing left in the selection', () => {
    const out = filterNodesBySeverity([node({ critical: 0, high: 0, medium: 0, low: 5, threat_count: 5 }), node({ lat: 9 })], ['critical']);
    expect(out).toHaveLength(1);
    expect(out[0]!.lat).toBe(9);
  });

  it('does not mutate its input', () => {
    const n = node();
    filterNodesBySeverity([n], ['low']);
    expect(n.critical).toBe(3);
  });
});

describe('filtersToParams: only what is set, with the API param names', () => {
  it('is empty with no filter (default keys stay unchanged)', () => {
    expect(filtersToParams({ sev: [], type: [], brand: null })).toEqual({});
  });
  it('uses severity / threat_type / brand', () => {
    expect(filtersToParams({ sev: ['critical', 'high'], type: ['c2', 'phishing'], brand: 'b_1' }))
      .toEqual({ severity: 'critical,high', threat_type: 'c2,phishing', brand: 'b_1' });
  });
  it('type options are exactly the values the API accepts', () => {
    expect(TYPE_OPTIONS.map(t => t.id)).toEqual([...THREAT_TYPE_IDS]);
  });
});

describe('active-filter chips', () => {
  const f = { sev: ['critical' as const], type: ['phishing'], brand: 'b_1' };
  it('one chip per value, each with its own remove label', () => {
    const chips = filterChips(f, 'PayPal');
    expect(chips.map(c => c.key)).toEqual(['sev:critical', 'type:phishing', 'brand:b_1']);
    expect(chips[0]!.removeLabel).toMatch(/critical/);
    expect(chips[2]).toMatchObject({ label: 'PayPal', note: BRAND_SCOPE_NOTE });
  });
  it('the brand chip falls back to a neutral label (never the raw id) when the name is not known, and says it applies to arcs and stats', () => {
    expect(filterChips(f).find(c => c.kind === 'brand')).toMatchObject({ label: 'Brand filter', note: 'applies to arcs and stats' });
  });
  it('removing a chip removes only its value', () => {
    expect(removeFilterPatch({ sev: ['critical', 'high'], type: [], brand: null }, 'sev', 'critical')).toEqual({ sev: ['high'] });
    expect(removeFilterPatch(f, 'type', 'phishing')).toEqual({ type: [] });
    expect(removeFilterPatch(f, 'brand', 'b_1')).toEqual({ brand: null });
    expect(CLEAR_FILTERS_PATCH).toEqual({ sev: [], type: [], brand: null });
  });
  it('hasActiveFilters', () => {
    expect(hasActiveFilters({ sev: [], type: [], brand: null })).toBe(false);
    expect(hasActiveFilters(f)).toBe(true);
  });
});

describe('toggles', () => {
  it('severity toggles keep severity order', () => {
    expect(toggleSeverity([], 'low')).toEqual(['low']);
    expect(toggleSeverity(['low'], 'critical')).toEqual(['critical', 'low']);
    expect(toggleSeverity(['critical', 'low'], 'critical')).toEqual(['low']);
  });
  it('type toggles stay sorted', () => {
    expect(toggleType(['phishing'], 'c2')).toEqual(['c2', 'phishing']);
    expect(toggleType(['c2', 'phishing'], 'c2')).toEqual(['phishing']);
  });
});
