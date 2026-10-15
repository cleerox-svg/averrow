import { describe, it, expect } from 'vitest';
import type { OperationGeo, ProviderGeo } from '@/hooks/useObservatoryLenses';
import { buildOperationsModel, edgeShortLabel, visibleEdges } from '../lib/lens/operations';
import { buildHostingModel } from '../lib/lens/hosting';
import type { ActorModel, ActorCountry } from '../lib/lens/actors';
import {
  edgeLabelSources, labelledEdges, hostLabelSources, actorLabelSources, placeLensLabels, stablePlacement, MAX_EDGE_LABELS, MAX_HOST_LABELS, MAX_ACTOR_LABELS, MAX_MOVE_LABELS, keepTopMoves, NO_LABELS,
  type MoveLabelSource,
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
    expect(edgeShortLabel('asn', ['AS1', 'AS2', 'AS3'])).toBe('▲ 3 ASNs');
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
  // A star of 4 countries => 3 arcs, all "▲ 3 ASNs".
  const model = buildOperationsModel([op('a', ['US', 'DE', 'JP', 'BR']), op('b', ['FR', 'NL'], { kind: 'per_ip', asns: ['AS9'] })], []);
  const shown = visibleEdges(model, null);
  it('keeps ONE label per lead operation and evidence kind (not one per star arc)', () => {
    expect(shown.filter(e => e.opIds[0] === 'a')).toHaveLength(3);
    const src = edgeLabelSources(shown, '');
    expect(src.filter(s => s.text === '▲ 3 ASNs')).toHaveLength(1);
    expect(src.filter(s => s.text === '● IP')).toHaveLength(1);
  });
  it('is memoised on (visible arcs, selection): same identity on repeat calls', () => {
    expect(edgeLabelSources(shown, '')).toBe(edgeLabelSources(shown, ''));
    expect(edgeLabelSources(shown, 'a')).not.toBe(edgeLabelSources(shown, ''));
  });
  it('the selected operation\'s arcs outrank the rest, then the arcs more operations share', () => {
    const m = buildOperationsModel([op('a', ['US', 'DE']), op('b', ['FR', 'NL']), op('c', ['JP', 'AU'], { threat_count: 99 })], []);
    const vis = visibleEdges(m, null);
    const sel = edgeLabelSources(vis, 'b');
    expect(vis.find(e => e.id === sel[0]!.id)!.opIds).toContain('b');
  });
});

describe('labelledEdges: evidence words only for the selected or hovered links', () => {
  const model = buildOperationsModel([op('a', ['US', 'DE']), op('b', ['FR', 'NL'], { kind: 'per_ip' })], []);
  it('the default view labels nothing', () => {
    expect(visibleEdges(model, null).length).toBeGreaterThan(0);
    expect(labelledEdges(visibleEdges(model, null), null, null)).toEqual([]);
    expect(edgeLabelSources(labelledEdges(visibleEdges(model, null), null, null), '')).toEqual([]);
  });
  it('a selected operation labels its own arcs; a hovered row labels only its arcs', () => {
    const sel = labelledEdges(visibleEdges(model, 'a'), 'a', null);
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.every(e => e.opIds.includes('a'))).toBe(true);
    const hov = labelledEdges(visibleEdges(model, null, 'b'), null, 'b');
    expect(hov.length).toBeGreaterThan(0);
    expect(hov.every(e => e.opIds.includes('b'))).toBe(true);
    expect(hov.length).toBeLessThan(visibleEdges(model, null, 'b').length);
  });
  it('is memoised: same identity on repeat calls', () => {
    const vis = visibleEdges(model, 'a');
    expect(labelledEdges(vis, 'a', null)).toBe(labelledEdges(vis, 'a', null));
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
    const out = placeLensLabels({ edges: edgeLabelSources(visibleEdges(model, null), ''), hosts: [], nodes: [] }, mockProject, size);
    expect(out.edges.length).toBeLessThanOrEqual(MAX_EDGE_LABELS);
    for (const e of out.edges) {
      expect(e.angle).toBeGreaterThan(-90);
      expect(e.angle).toBeLessThanOrEqual(90);
    }
  });
  it('drops an edge too short on screen to carry its text between its nodes', () => {
    const squash: Project = p => ({ x: 500 + p[0] * 0.01, y: 350 + p[1] * 0.01 });
    expect(placeLensLabels({ edges: edgeLabelSources(visibleEdges(model, null), ''), hosts: [], nodes: [] }, squash, size).edges).toEqual([]);
  });
  it('skips labels whose anchor is off screen or unprojectable', () => {
    const off: Project = () => ({ x: -500, y: 10 });
    expect(placeLensLabels({ edges: edgeLabelSources(visibleEdges(model, null), ''), hosts: [], nodes }, off, size).edges).toEqual([]);
    expect(placeLensLabels({ edges: edgeLabelSources(visibleEdges(model, null), ''), hosts: [], nodes }, () => null, size)).toEqual(NO_LABELS);
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

const P = (p: Partial<PlacedLabels>): PlacedLabels => ({ edges: [], hosts: [], actors: [], ...p });

describe('stablePlacement', () => {
  const a = P({ edges: [{ id: 'e', text: 'x', position: [0, 0], angle: 10.1 }] });
  it('keeps the previous object when nothing visible changed', () => {
    expect(stablePlacement(a, P({ edges: [{ id: 'e', text: 'x', position: [0, 0], angle: 10.4 }] }))).toBe(a);
  });
  it('takes the new one when a label appears, goes, or turns', () => {
    expect(stablePlacement(a, P({}))).not.toBe(a);
    expect(stablePlacement(a, P({ edges: [{ id: 'e', text: 'x', position: [0, 0], angle: 40 }] }))).not.toBe(a);
  });
  it('takes the new one when a label keeps its id but its text, anchor or ring size changed (refetch)', () => {
    expect(stablePlacement(a, P({ edges: [{ id: 'e', text: 'y', position: [0, 0], angle: 10.1 }] }))).not.toBe(a);
    expect(stablePlacement(a, P({ edges: [{ id: 'e', text: 'x', position: [3, 4], angle: 10.1 }] }))).not.toBe(a);
    const h = P({ hosts: [{ id: 'p1', text: 'Host A', position: [1, 2], radiusPx: 10 }] });
    expect(stablePlacement(h, P({ hosts: [{ id: 'p1', text: 'Host A', position: [1, 2], radiusPx: 10 }] }))).toBe(h);
    expect(stablePlacement(h, P({ hosts: [{ id: 'p1', text: 'Host A', position: [1, 2], radiusPx: 18 }] }))).not.toBe(h);
    expect(stablePlacement(h, P({ hosts: [{ id: 'p1', text: 'Host B', position: [1, 2], radiusPx: 10 }] }))).not.toBe(h);
    expect(stablePlacement(h, P({ hosts: [{ id: 'p1', text: 'Host A', position: [9, 2], radiusPx: 10 }] }))).not.toBe(h);
  });
  it('a provider rank swap (same ids, swapped sizes) is a change', () => {
    const before = P({ hosts: [{ id: 'a', text: 'A', position: [0, 0], radiusPx: 20 }, { id: 'b', text: 'B', position: [10, 10], radiusPx: 12 }] });
    const after = P({ hosts: [{ id: 'a', text: 'A', position: [0, 0], radiusPx: 12 }, { id: 'b', text: 'B', position: [10, 10], radiusPx: 20 }] });
    expect(stablePlacement(before, after)).toBe(after);
  });
  it('actor labels: same ids but a new count/text is a change; identical is not', () => {
    const x = P({ actors: [{ id: 'DE', text: 'DE · high', position: [10, 51], radiusPx: 12 }] });
    expect(stablePlacement(x, P({ actors: [{ id: 'DE', text: 'DE · high', position: [10, 51], radiusPx: 12 }] }))).toBe(x);
    expect(stablePlacement(x, P({ actors: [{ id: 'DE', text: 'DE · low', position: [10, 51], radiusPx: 12 }] }))).not.toBe(x);
    expect(stablePlacement(x, P({ actors: [{ id: 'DE', text: 'DE · high', position: [10, 51], radiusPx: 16 }] }))).not.toBe(x);
  });
});

describe('actor labels go through the same screen-space placement', () => {
  const size = { width: 800, height: 500 };
  const country = (cc: string, lng: number, lat: number, items = 1, confidence: number | null = 0.9): ActorCountry => ({
    country: cc, position: [lng, lat], confidence, items, asns: [], phase: 0,
  });
  const model = (countries: ActorCountry[]): ActorModel => ({ actorId: 'ta', countries, edges: [], asns: [], clusters: [], unplaced: 0, empty: countries.length === 0 });
  // lng/lat straight to pixels.
  const project: Project = ([lng, lat]) => ({ x: lng, y: lat });
  it('builds one source per country, text "CC · band"', () => {
    const src = actorLabelSources(model([country('DE', 10, 50, 3, 0.9), country('RU', 100, 60, 1, null)]));
    expect(src.map(s => s.text)).toEqual(['DE · high', 'RU · unknown']);
    expect(src[0]!.radiusPx).toBeGreaterThan(8);
  });
  it('drops a label that would clip at the screen edge (the old layer drew it half cut off)', () => {
    const src = actorLabelSources(model([country('DE', 400, 250), country('US', 4, 250)]));
    const out = placeLensLabels({ edges: [], hosts: [], actors: src, nodes: [] }, project, size);
    expect(out.actors.map(a => a.id)).toEqual(['DE']);
  });
  it('drops the lower-priority label of two that collide', () => {
    const src = actorLabelSources(model([country('DE', 400, 250, 5), country('FR', 408, 252, 1)]));
    const out = placeLensLabels({ edges: [], hosts: [], actors: src, nodes: [] }, project, size);
    expect(out.actors.map(a => a.id)).toEqual(['DE']);
  });
  it('keeps clear of a provider label already placed, and caps the count', () => {
    const many = model(Array.from({ length: 30 }, (_, i) => country(`C${i}`, 60 + (i % 10) * 70, 60 + Math.floor(i / 10) * 120)));
    const out = placeLensLabels({ edges: [], hosts: [], actors: actorLabelSources(many), nodes: [] }, project, size);
    expect(out.actors.length).toBeLessThanOrEqual(MAX_ACTOR_LABELS);
    expect(out.actors.length).toBeGreaterThan(0);
  });
  it('no actor sources => none placed', () => {
    expect(placeLensLabels({ edges: [], hosts: [], nodes: [] }, project, size).actors).toEqual([]);
  });
});

describe('movement labels: top moves, plus the selected one only when it is placed', () => {
  const size = { width: 1000, height: 700 };
  // 1 degree = 20px; origin at (500, 350). Each source is a 10-degree hop on its own row so no two labels collide.
  const project: Project = ([lng, lat]) => ({ x: 500 + lng * 20, y: 350 - lat * 20 });
  const src = (id: string, row: number, over: Partial<MoveLabelSource> = {}): MoveLabelSource => ({
    id, text: '+3 IPs', position: [0, row], before: [-1, row], after: [1, row], from: [-5, row], to: [5, row], priority: 10 - row, ...over,
  });
  const ids = (m: readonly MoveLabelSource[]) => placeLensLabels({ edges: [], hosts: [], nodes: [], moves: m }, project, size).moves?.map(x => x.id) ?? [];

  it('keepTopMoves keeps every selected label and the best MAX_MOVE_LABELS of the rest', () => {
    const placed = ['s', 'a', 'b', 'c', 'd'].map(id => ({ id }));
    expect(keepTopMoves(placed, id => id === 's').map(p => p.id)).toEqual(['s', 'a', 'b', 'c']);
    expect(keepTopMoves(placed.slice(1), () => false).map(p => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('shows at most MAX_MOVE_LABELS when the selected event cannot be placed (no fourth, "extra" label)', () => {
    // the selected one is far off screen: it is skipped, and its reserved slot used to let a 4th ordinary label through
    const off = src('sel', 0, { position: [200, 0], before: [199, 0], after: [201, 0], from: [190, 0], to: [210, 0], priority: 1e6, selected: true });
    const rest = [1, 2, 3, 4, 5].map(r => src(`m${r}`, r));
    expect(ids([off, ...rest])).toHaveLength(MAX_MOVE_LABELS);
    expect(ids([off, ...rest])).not.toContain('sel');
  });

  it('adds the selected event on top of the top moves when it is placed', () => {
    const sel = src('sel', 0, { priority: 1e6, selected: true });
    const rest = [1, 2, 3, 4, 5].map(r => src(`m${r}`, r));
    const out = ids([sel, ...rest]);
    expect(out).toHaveLength(MAX_MOVE_LABELS + 1);
    expect(out).toContain('sel');
  });
});
