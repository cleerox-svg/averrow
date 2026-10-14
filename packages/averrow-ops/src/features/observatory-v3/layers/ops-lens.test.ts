import { describe, it, expect, vi } from 'vitest';
import type { OperationGeo } from '@/hooks/useObservatoryLenses';
import { noLayers } from '../lib/lenses';
import { buildOperationsModel, aggregateEdges, visibleEdges } from '../lib/lens/operations';
import { opCountRange, opNodeRadius, opNodePx, opNodesDrawOrder, opEdgeStyle, maxPairOps, MAX_NODE_LABELS } from '../lib/lens/operations-draw';
import { globeEdgePath } from '../lib/lens/operations-globe';
import { buildLensLayers, NO_SELECTION, type LensLayerInput } from './lens-layers';
import { NO_LABELS, edgeLabelSources, opNodeLabelSources, placeLensLabels, stablePlacement, type Project } from './lens-labels';

const HOT = ['US', 'DE', 'NL', 'GB', 'FR', 'SG', 'JP', 'AU', 'CA', 'BR', 'IN', 'RU', 'CN', 'HK', 'IE', 'SE', 'PL', 'IT', 'ES', 'ZA', 'MX', 'TR', 'KR', 'ID', 'UA'];
const op = (id: string, countries: string[], over: Partial<OperationGeo> = {}): OperationGeo => ({
  id, name: id, component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 10, actor: null,
  countries, asns: ['AS1', 'AS2'], last_seen: null, last_movement_pivot_at: null, ...over,
});
// 50 operations x ~15 countries with heavy overlap, skewed toward the first few countries (like real hosting): the
// busiest country is in nearly every operation, the quietest in a handful.
const real = Array.from({ length: 50 }, (_, i) => op(`op${String(i).padStart(2, '0')}`,
  Array.from({ length: 22 }, (_, k) => HOT[Math.floor(Math.pow(((i * 7 + k * 5) % 25) / 25, 1.7) * HOT.length)]!), { threat_count: 1000 - i * 13 }));
const model = buildOperationsModel(real, []);

describe('node size: min-max normalised, so a narrow spread of counts is still readable', () => {
  const range = opCountRange(model);
  it('the scale uses the 6..14px range across the spread that exists', () => {
    expect(opNodeRadius(range.min, range)).toBe(6);
    expect(opNodeRadius(range.max, range)).toBe(14);
    const mid = opNodeRadius(Math.round((range.min + range.max) / 2), range);
    expect(mid).toBeGreaterThan(6);
    expect(mid).toBeLessThan(14);
  });
  it('realistic data: the nodes are not all within a few px of one another (the old count/max wall)', () => {
    const px = model.nodes.map(n => opNodeRadius(n.opCount, range));
    expect(Math.max(...px) - Math.min(...px)).toBeGreaterThanOrEqual(7);
  });
  it('one shared count sits mid-scale; the bloom is 2.1x the core', () => {
    expect(opNodeRadius(7, { min: 7, max: 7 })).toBe(10);
    expect(opNodePx(5, { min: 1, max: 5 })).toBeCloseTo(14 * 2.1, 9);
  });
  it('is monotonic', () => {
    for (let n = 1; n < 40; n++) expect(opNodeRadius(n + 1, { min: 1, max: 40 })).toBeGreaterThanOrEqual(opNodeRadius(n, { min: 1, max: 40 }));
  });
});

describe('draw order: the biggest first, so small nodes stay on top', () => {
  it('is count descending, stable on country, memoised, and a permutation of the nodes', () => {
    const order = opNodesDrawOrder(model);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.opCount).toBeGreaterThanOrEqual(order[i]!.opCount);
    expect(order).toHaveLength(model.nodes.length);
    expect(opNodesDrawOrder(model)).toBe(order);
  });
  it('the bloom and core layers receive that order', () => {
    const layers = buildLensLayers(base({ operations: true }), { seconds: 1, t: 1 });
    const core = layers.find(l => l.id === 'ops-core') as unknown as { props: { data: Array<{ opCount: number }> } };
    expect(core.props.data[0]!.opCount).toBe(Math.max(...model.nodes.map(n => n.opCount)));
    expect(core.props.data.at(-1)!.opCount).toBe(Math.min(...model.nodes.map(n => n.opCount)));
  });
});

describe('arc stroke is relative to the busiest drawn pair', () => {
  it('alpha spans 70..230 with the busiest pair at the top and one operation clearly lighter', () => {
    expect(opEdgeStyle(5, 5).alpha).toBe(230);
    expect(opEdgeStyle(1, 5).alpha).toBe(102);
    expect(opEdgeStyle(1, 1).alpha).toBe(230); // a lone pair is not left faint
    expect(opEdgeStyle(0, 5).alpha).toBe(70);
    expect(opEdgeStyle(9, 5).alpha).toBe(230); // never past the cap
  });
  it('width grows with operations and is capped', () => {
    expect(opEdgeStyle(1, 9).width).toBeLessThan(opEdgeStyle(9, 9).width);
    expect(opEdgeStyle(400, 400).width).toBe(3.4);
  });
  it('maxPairOps is the busiest edge, never 0', () => {
    expect(maxPairOps([])).toBe(1);
    expect(maxPairOps(aggregateEdges(model, model.topOpIds))).toBeGreaterThanOrEqual(1);
  });
});

function base(layers: Record<string, boolean>, extra: Partial<LensLayerInput> = {}): LensLayerInput {
  return {
    layers: { ...noLayers(), ...layers },
    operations: model, hosting: null, baseline: null, measure: 'index', bot: null, labels: NO_LABELS, countries: null,
    campaigns: null, actors: null, movement: null, velocity: null, takedownCountries: null, takedownProviders: null,
    sel: NO_SELECTION, reducedMotion: false, isMobile: false, pick: { hover: vi.fn(), click: vi.fn(() => true) },
    ...extra,
  };
}
const layerProps = (i: LensLayerInput, id: string) => (buildLensLayers(i, { seconds: 1, t: 1 }).find(l => l.id === id) as unknown as { props: Record<string, unknown> } | undefined)?.props;

describe('arc layers', () => {
  it('a faint solid underlay sits beneath the dashed flow (same data, ~40% alpha), pickable', () => {
    const i = base({ operations: true });
    const ids = buildLensLayers(i, { seconds: 1, t: 1 }).map(l => l.id);
    expect(ids.indexOf('ops-edges-under')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('ops-edges-under')).toBeLessThan(ids.indexOf('ops-edges'));
    const under = layerProps(i, 'ops-edges-under')!;
    const over = layerProps(i, 'ops-edges')!;
    expect(under.data).toBe(over.data);
    expect(under.pickable).toBe(true);
    const e = (over.data as Parameters<typeof aggregateEdges>[1] & object[])[0];
    const alphaOf = (p: Record<string, unknown>) => ((p.getColor as (d: unknown) => number[])(e))[3]!;
    expect(alphaOf(under)).toBe(Math.round(alphaOf(over) * 0.4));
  });
  it('reduced motion draws the flow solid already: no underlay', () => {
    expect(layerProps(base({ operations: true }, { reducedMotion: true }), 'ops-edges-under')).toBeUndefined();
  });
  it('colours are relative: the busiest drawn pair is the brightest, a single-operation pair is lighter', () => {
    const i = base({ operations: true });
    const over = layerProps(i, 'ops-edges')!;
    const edges = over.data as Array<{ opCount: number }>;
    const alpha = (e: unknown) => ((over.getColor as (d: unknown) => number[])(e))[3]!;
    const busiest = edges.reduce((a, b) => (b.opCount > a.opCount ? b : a));
    expect(alpha(busiest)).toBe(230);
    const lightest = edges.reduce((a, b) => (b.opCount < a.opCount ? b : a));
    if (lightest.opCount < busiest.opCount) expect(alpha(lightest)).toBeLessThan(230);
  });
  it('a dimmed node keeps a visible core (alpha ~70), a lit one is brighter', () => {
    const i = base({ operations: true }, { sel: { ...NO_SELECTION, opId: model.topOpIds[0]! } });
    const core = layerProps(i, 'ops-core')!;
    const outside = model.nodes.find(n => !n.opIds.includes(model.topOpIds[0]!));
    const inside = model.nodes.find(n => n.opIds.includes(model.topOpIds[0]!))!;
    const fill = core.getFillColor as (n: unknown) => number[];
    if (outside) expect(fill(outside)[3]).toBe(70);
    expect(fill(inside)[3]).toBeGreaterThan(100);
  });
});

describe('country node labels ("DE 37")', () => {
  const src = opNodeLabelSources(model);
  const size = { width: 1400, height: 800 };
  const flat: Project = ([lng, lat]) => ({ x: 700 + lng * 3.6, y: 400 - lat * 4.2 });
  it('labels the busiest nodes with country + count, at most MAX_NODE_LABELS, busiest first', () => {
    expect(src.length).toBe(MAX_NODE_LABELS);
    const top = [...model.nodes].sort((a, b) => b.opCount - a.opCount || b.threats - a.threats || a.country.localeCompare(b.country))[0]!;
    expect(src[0]).toMatchObject({ id: top.country, text: `${top.country} ${top.opCount}` });
    expect(opNodeLabelSources(model)).toBe(src); // memoised
  });
  it('are placed with the edge words, never on top of another node, and carry the limb fade', () => {
    const edges = edgeLabelSources(visibleEdges(model, null), '');
    const nodes = model.nodes.map(n => ({ position: n.position, radiusPx: opNodePx(n.opCount, opCountRange(model)), id: n.country }));
    const out = placeLensLabels({ opNodes: src, edges, hosts: [], nodes }, p => ({ ...flat(p)!, fade: 0.5 }), size);
    expect(out.opNodes!.length).toBeGreaterThan(0);
    expect(out.opNodes!.length).toBeLessThanOrEqual(MAX_NODE_LABELS);
    expect(out.opNodes!.every(l => l.fade === 0.5)).toBe(true);
    // an edge word never overlaps a placed node label (same greedy pass, node labels first)
    for (const e of out.edges) {
      const ep = flat(e.position)!;
      for (const l of out.opNodes!) {
        const lp = flat(l.position)!;
        const cy = lp.y + l.radiusPx + 4 + 7;
        const near = Math.abs(ep.x - lp.x) < (e.text.length * 6.6 + l.text.length * 6.6) / 2 && Math.abs(ep.y - cy) < 14;
        expect(near).toBe(false);
      }
    }
  });
  it('a label that would run off the canvas is dropped, not clipped', () => {
    const nodes = model.nodes.map(n => ({ position: n.position, radiusPx: 8, id: n.country }));
    const out = placeLensLabels({ opNodes: src, edges: [], hosts: [], nodes }, () => ({ x: 2, y: 2 }), size);
    expect(out.opNodes).toEqual([]);
  });
  it('stablePlacement notices a changed node label', () => {
    const a = { ...NO_LABELS, opNodes: [{ id: 'DE', text: 'DE 3', position: [10, 51] as [number, number], radiusPx: 8 }] };
    const same = { ...NO_LABELS, opNodes: [{ id: 'DE', text: 'DE 3', position: [10, 51] as [number, number], radiusPx: 8 }] };
    const changed = { ...NO_LABELS, opNodes: [{ id: 'DE', text: 'DE 4', position: [10, 51] as [number, number], radiusPx: 8 }] };
    expect(stablePlacement(a, same)).toBe(a);
    expect(stablePlacement(a, changed)).toBe(changed);
  });
  it('the layer draws them under the node, beneath the label offset', () => {
    const labels = { ...NO_LABELS, opNodes: [{ id: 'DE', text: 'DE 3', position: [10, 51] as [number, number], radiusPx: 9 }] };
    const p = layerProps(base({ operations: true }, { labels }), 'ops-node-labels')!;
    expect(p.data).toBe(labels.opNodes);
    expect((p.getPixelOffset as (l: unknown) => number[])(labels.opNodes[0])).toEqual([0, 13]);
    expect(layerProps(base({ operations: true }), 'ops-node-labels')).toBeUndefined();
  });
});

describe('edge labels on the globe sit on the great-circle arc that is drawn', () => {
  const m = buildOperationsModel([op('t', ['US', 'JP']), op('u', ['GB', 'AU'])], []);
  const edges = visibleEdges(m, null);
  it('the flat source anchors on the flat path, the globe source on the great circle', () => {
    for (const e of edges) {
      const flat = edgeLabelSources(edges, '', 'flat').find(s => s.id === e.id)!;
      const globe = edgeLabelSources(edges, '', 'globe').find(s => s.id === e.id)!;
      const gc = globeEdgePath(e).path;
      const mid = Math.floor(gc.length / 2);
      expect(globe.position).toEqual([gc[mid]![0], gc[mid]![1]]);
      expect(globe.before).toEqual([gc[mid - 1]![0], gc[mid - 1]![1]]);
      expect(globe.after).toEqual([gc[mid + 1]![0], gc[mid + 1]![1]]);
      expect(flat.position).toEqual(e.midpoint);
    }
  });
  it('for a long pair the two anchors differ (the flat polyline is not the great circle)', () => {
    const e = edges.find(x => x.a === 'JP' || x.b === 'JP')!;
    const flat = edgeLabelSources(edges, '', 'flat').find(s => s.id === e.id)!;
    const globe = edgeLabelSources(edges, '', 'globe').find(s => s.id === e.id)!;
    expect(Math.hypot(flat.position[0] - globe.position[0], flat.position[1] - globe.position[1])).toBeGreaterThan(1);
  });
  it('is memoised per projection', () => {
    expect(edgeLabelSources(edges, '', 'globe')).toBe(edgeLabelSources(edges, '', 'globe'));
    expect(edgeLabelSources(edges, '', 'globe')).not.toBe(edgeLabelSources(edges, '', 'flat'));
  });
});
