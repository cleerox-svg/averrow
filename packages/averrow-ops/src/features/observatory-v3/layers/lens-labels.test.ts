import { describe, it, expect } from 'vitest';
import type { OperationGeo, ComponentGeo, ProviderGeo } from '@/hooks/useObservatoryLenses';
import { buildOperationsModel, edgeShortLabel } from '../lib/lens/operations';
import { buildHostingModel } from '../lib/lens/hosting';
import {
  edgeLabelSources, hostLabelSources, placeLensLabels, stablePlacement, MAX_EDGE_LABELS, MAX_HOST_LABELS, NO_LABELS,
  type Project, type PlacedLabels,
} from './lens-labels';

const op = (id: string, countries: string[], over: Partial<OperationGeo> = {}): OperationGeo => ({
  id, name: id, component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 10, actor: null,
  countries, asns: ['AS1', 'AS2', 'AS3'], last_seen: null, last_movement_pivot_at: null, ...over,
});

describe('edgeShortLabel: glyph + a word', () => {
  it('uses short words, not sentences', () => {
    expect(edgeShortLabel('cert_serial', [])).toBe('◆ cert');
    expect(edgeShortLabel('cert_san', [])).toBe('◆ SAN');
    expect(edgeShortLabel('per_ip', ['AS1'])).toBe('● IP');
    expect(edgeShortLabel('asn', ['AS1', 'AS2', 'AS3'])).toBe('▲ ASN ×3');
    expect(edgeShortLabel('asn', ['AS1'])).toBe('▲ ASN');
    expect(edgeShortLabel(null, [])).toBe('· link');
    expect(edgeShortLabel('weird_kind', [])).toBe('· weird kind');
  });
  it('every short label is under 12 characters', () => {
    for (const k of ['cert_serial', 'cert_san', 'per_ip', 'subnet', 'registrar', 'asn', 'app_store', 'dark_web']) {
      expect(edgeShortLabel(k, ['AS1', 'AS2', 'AS3']).length).toBeLessThan(12);
    }
  });
});

describe('edge label sources', () => {
  // A star of 4 countries => 3 intra-op edges, all "▲ ASN ×3".
  const model = buildOperationsModel([op('a', ['US', 'DE', 'JP', 'BR']), op('b', ['FR', 'NL'], { kind: 'per_ip', asns: ['AS9'] })], []);
  it('keeps ONE label per operation and evidence kind (not one per star edge)', () => {
    expect(model.edges.filter(e => e.opIds[0] === 'a')).toHaveLength(3);
    const src = edgeLabelSources(model, '');
    expect(src.filter(s => s.text === '▲ ASN ×3')).toHaveLength(1);
    expect(src.filter(s => s.text === '● IP')).toHaveLength(1);
  });
  it('is memoised on (model, group): same identity on repeat calls', () => {
    expect(edgeLabelSources(model, '')).toBe(edgeLabelSources(model, ''));
    expect(edgeLabelSources(model, 'a')).not.toBe(edgeLabelSources(model, ''));
  });
  it('the selected component outranks the rest', () => {
    const comp: ComponentGeo = { component_id: 'g', operation_ids: ['a', 'b'], countries: [], edges: [{ a: 'a', b: 'b', kind: 'cert_serial', shared_asns: [] }] };
    const m = buildOperationsModel([op('a', ['US', 'DE'], { component_id: 'g' }), op('b', ['FR', 'NL'], { component_id: 'g' }), op('c', ['JP', 'AU'])], [comp]);
    const sel = edgeLabelSources(m, 'g');
    expect(m.edges.find(e => e.id === sel[0]!.id)!.group).toBe('g');
  });
});

describe('host label sources', () => {
  const prov = (id: string, active: number): ProviderGeo => ({ id, name: `Host ${id}`, asn: 'AS1', country: 'NL', active_threat_count: active, total_threat_count: active, trend_7d: 1, trend_30d: 1, is_bulletproof: false, reputation_score: null, takedown: null });
  it('lists the biggest providers plus the selected one, whichever rank', () => {
    const model = buildHostingModel(Array.from({ length: 30 }, (_, i) => prov(`p${i}`, 100 - i)));
    const src = hostLabelSources(model, 'p29');
    expect(src.some(s => s.id === 'p29' && s.priority === 1e9)).toBe(true);
    expect(src.length).toBeLessThanOrEqual(15);
    expect(hostLabelSources(model, 'p29')).toBe(src);
  });
});

describe('screen-space placement', () => {
  const size = { width: 1000, height: 700 };
  // 1 geographic degree = 20 screen px; origin at (500, 350)
  const project: Project = ([lng, lat]) => ({ x: 500 + lng * 20, y: 350 - lat * 20 });
  const model = buildOperationsModel([op('a', ['US', 'DE'])], []);
  const nodes = model.nodes.map(n => ({ position: n.position, radiusPx: 12 }));

  it('places an edge label along the edge with an upright angle', () => {
    const mockProject: Project = p => ({ x: 200 + p[0] * 4, y: 350 + p[1] * -2 });
    const out = placeLensLabels({ edges: edgeLabelSources(model, ''), hosts: [], nodes: [] }, mockProject, size);
    expect(out.edges.length).toBeLessThanOrEqual(MAX_EDGE_LABELS);
    for (const e of out.edges) {
      expect(e.angle).toBeGreaterThan(-90);
      expect(e.angle).toBeLessThanOrEqual(90);
    }
  });
  it('drops an edge too short on screen to carry its text between its nodes', () => {
    const squash: Project = p => ({ x: 500 + p[0] * 0.01, y: 350 + p[1] * 0.01 });
    expect(placeLensLabels({ edges: edgeLabelSources(model, ''), hosts: [], nodes: [] }, squash, size).edges).toEqual([]);
  });
  it('skips labels whose anchor is off screen or unprojectable', () => {
    const off: Project = () => ({ x: -500, y: 10 });
    expect(placeLensLabels({ edges: edgeLabelSources(model, ''), hosts: [], nodes }, off, size).edges).toEqual([]);
    expect(placeLensLabels({ edges: edgeLabelSources(model, ''), hosts: [], nodes }, () => null, size)).toEqual(NO_LABELS);
  });
  it('a provider\'s name is placed under its own ring (the ring is not an obstacle to itself)', () => {
    const provs: ProviderGeo[] = [{ id: 'p0', name: 'Solo Host', asn: null, country: 'NL', active_threat_count: 50, total_threat_count: 1, trend_7d: 0, trend_30d: 0, is_bulletproof: false, reputation_score: null, takedown: null }];
    const hosting = buildHostingModel(provs);
    const proj: Project = () => ({ x: 400, y: 300 });
    const nodes = hosting.rings.map(r => ({ position: r.position, radiusPx: r.radiusPx, id: r.id }));
    const out = placeLensLabels({ edges: [], hosts: hostLabelSources(hosting, ''), nodes }, proj, size);
    expect(out.hosts.map(h => h.id)).toEqual(['p0']);
  });
  it('de-duplicates provider names that collide and caps the total', () => {
    const provs: ProviderGeo[] = Array.from({ length: 14 }, (_, i) => ({
      id: `p${i}`, name: `Provider number ${i}`, asn: null, country: 'NL', active_threat_count: 100 - i, total_threat_count: 1, trend_7d: 0, trend_30d: 0,
      is_bulletproof: false, reputation_score: null, takedown: null,
    }));
    const hosting = buildHostingModel(provs);
    // Every ring lands within a few px of the others => almost all labels collide.
    const crowded: Project = () => ({ x: 500, y: 300 });
    const out = placeLensLabels({ edges: [], hosts: hostLabelSources(hosting, ''), nodes: [] }, crowded, size);
    expect(out.hosts.length).toBe(1);
    // Spread out, they all fit up to the cap.
    const spread: Project = p => ({ x: 60 + ((p[0] * 997) % 880), y: 60 + ((p[1] * 313) % 560) });
    const out2 = placeLensLabels({ edges: [], hosts: hostLabelSources(hosting, ''), nodes: [] }, spread, size);
    expect(out2.hosts.length).toBeLessThanOrEqual(MAX_HOST_LABELS);
    void project;
  });
});

describe('stablePlacement', () => {
  const a: PlacedLabels = { edges: [{ id: 'e', text: 'x', position: [0, 0], angle: 10.1 }], hosts: [] };
  it('keeps the previous object when nothing visible changed', () => {
    const b: PlacedLabels = { edges: [{ id: 'e', text: 'x', position: [0, 0], angle: 10.4 }], hosts: [] };
    expect(stablePlacement(a, b)).toBe(a);
  });
  it('takes the new one when a label appears, goes, or turns', () => {
    expect(stablePlacement(a, { edges: [], hosts: [] })).not.toBe(a);
    expect(stablePlacement(a, { edges: [{ id: 'e', text: 'x', position: [0, 0], angle: 40 }], hosts: [] })).not.toBe(a);
  });
});
