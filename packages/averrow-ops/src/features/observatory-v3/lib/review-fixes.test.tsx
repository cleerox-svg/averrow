// Review fixes for the Observatory polish PR: brand ids, ghost nodes, label caps, shortcuts, idle-spin exemption, chip row insets.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ArcData, ThreatPoint } from '@/hooks/useObservatory';
import type { Movement } from '@/hooks/useObservatoryLenses';
import { NodeSlotRegistry, NODE_TRANSITION_MS, isGhost, useSlottedNodesGen } from './node-transitions';
import { isProjectionKey, type KeyLike } from './shortcuts';
import { isMapGesture } from './use-idle-spin';
import { buildSearchIndex, runSearch } from './search';
import { computeLayout, cameraInsets, CHIP_ROW_GAP } from './layout';
import { buildMovementModel, moveLabelMinZoom, MOVE_LABEL_MIN_ZOOM_FLAT, moveLabelText } from './lens/movement';
import { moveLabelSources, placeLensLabels, tiltOf, MAX_MOVE_LABELS, MOVE_LABEL_MAX_TILT } from '../layers/lens-labels';
import { replayDotState, SETTLE_ALPHA, SETTLE_RADIUS_PX } from '../anim/replay-dots';

const n = (lat: number, count = 5): ThreatPoint => ({
  lat, lng: 10, threat_count: count, top_severity: 'high', critical: 0, high: count, medium: 0, low: 0, country_code: 'NL', top_threat_type: 'phishing',
});

afterEach(() => { vi.useRealTimers(); });

describe('ghost nodes do not accumulate', () => {
  it('compact() drops a slot once its fade is over, and keeps the rest in order', () => {
    const reg = new NodeSlotRegistry();
    reg.layout([n(1), n(2), n(3)], false, 0);
    const out = reg.layout([n(1), n(3)], false, 100); // 2 leaves at t=100
    expect(out.data.map(d => isGhost(d))).toEqual([false, true, false]);
    expect(reg.ghostCount).toBe(1);
    expect(reg.compact(100 + NODE_TRANSITION_MS - 1)).toBe(false); // still fading
    expect(reg.compact(100 + NODE_TRANSITION_MS)).toBe(true);
    expect(reg.size).toBe(2);
    expect(reg.ghostCount).toBe(0);
    const again = reg.layout([n(1), n(3)], false, 1000);
    expect(again.data.map(d => d.lat)).toEqual([1, 3]);
    // a returning node simply gets a new slot
    expect(reg.layout([n(1), n(2), n(3)], false, 1100).data.map(d => d.lat)).toEqual([1, 3, 2]);
  });

  it('a node that comes back before its fade ends keeps its slot (no longer a ghost)', () => {
    const reg = new NodeSlotRegistry();
    reg.layout([n(1), n(2)], false, 0);
    reg.layout([n(1)], false, 10);
    reg.layout([n(1), n(2)], false, 20);
    expect(reg.ghostCount).toBe(0);
    expect(reg.compact(10_000)).toBe(false);
  });

  it('the hook removes ghosts after NODE_TRANSITION_MS and bumps the generation (the layer is re-created)', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ list }) => useSlottedNodesGen(list, true), { initialProps: { list: [n(1), n(2)] } });
    expect(result.current.generation).toBe(0);
    rerender({ list: [n(1)] });
    expect(result.current.nodes).toHaveLength(2); // the leaver is a ghost for now
    act(() => { vi.advanceTimersByTime(NODE_TRANSITION_MS + 60); });
    expect(result.current.nodes.map(d => d.lat)).toEqual([1]);
    expect(result.current.generation).toBe(1);
  });
});

describe('shortcuts / idle spin', () => {
  it('a key-less keydown (Chrome autofill) is not the projection key and does not throw', () => {
    const e = { key: undefined, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: document.body } as unknown as KeyLike;
    expect(isProjectionKey(e)).toBe(false);
  });

  it('only the projection toggle is exempt from the idle-spin gesture rule; rail buttons are gestures', () => {
    const rail = document.createElement('button');
    rail.setAttribute('data-control', 'beams');
    const toggle = document.createElement('button');
    toggle.setAttribute('data-control', 'projection');
    toggle.setAttribute('data-spin-exempt', '');
    document.body.append(rail, toggle);
    expect(isMapGesture(rail)).toBe(true);
    expect(isMapGesture(toggle)).toBe(false);
    rail.remove(); toggle.remove();
  });
});

describe('brand filter carries the brand id', () => {
  const arc = (id: string | undefined, name: string, volume: number): ArcData => ({
    sourcePosition: [5, 52], targetPosition: [-100, 40], threat_type: 'phishing', severity: 'high', source_region: 'NL',
    target_brand: name, brand_name: name, volume, ...(id ? { target_brand_id: id } : null),
  });

  it('a short name resolves to its own id, and two brands with one name stay two entries', () => {
    const index = buildSearchIndex({ arcs: [arc('b_ing', 'ING', 10), arc('b_ing', 'ING', 5), arc('b_ing2', 'ING', 3), arc('b_king', 'Kingfisher', 20)] });
    const hits = runSearch(index, 'ing').filter(r => r.kind === 'brand');
    const ing = hits.filter(r => r.label === 'ING');
    expect(ing.map(r => r.brandId).sort()).toEqual(['b_ing', 'b_ing2']);
    expect(ing.find(r => r.brandId === 'b_ing')!.sublabel).toBe('15 threats targeted');
    expect(hits.find(r => r.label === 'Kingfisher')!.brandId).toBe('b_king');
  });

  it('an arc cached without an id still searches, but has no brandId to filter by', () => {
    const index = buildSearchIndex({ arcs: [arc(undefined, 'Legacy', 4)] });
    const r = runSearch(index, 'legacy')[0]!;
    expect(r.kind).toBe('brand');
    expect(r.brandId).toBeUndefined();
  });
});

describe('camera top inset includes the chip row', () => {
  it('adds the row height and a gap; nothing when there are no chips', () => {
    const layout = computeLayout({ mapWidth: 1200, viewportWidth: 1400, viewportHeight: 900 });
    const base = cameraInsets({ layout, rightSlotOpen: false, showTimeline: false, sheetPx: 0 });
    expect(base.top).toBe(layout.topInset);
    expect(cameraInsets({ layout, rightSlotOpen: false, showTimeline: false, sheetPx: 0, chipRowHeight: 0 }).top).toBe(layout.topInset);
    expect(cameraInsets({ layout, rightSlotOpen: false, showTimeline: false, sheetPx: 0, chipRowHeight: 26 }).top).toBe(layout.topInset + 26 + CHIP_ROW_GAP);
  });
});

describe('movement labels', () => {
  const mv = (id: string, ips: number, from: string, to: string, hoursAgo: number): Movement => ({
    id, kind: 'infra_movement', cluster_id: `c${id}`, cluster_name: `Cluster ${id}`, at: new Date(Date.now() - hoursAgo * 3600e3).toISOString(),
    from: { asns: [], countries: [from] }, to: { asns: ['AS4837'], countries: [to] },
    counts: { new_asns: 1, new_ips: ips, new_serials: 0 }, payload_v: 2,
  });

  it('the flat map shows them from zoom 2.2', () => {
    expect(MOVE_LABEL_MIN_ZOOM_FLAT).toBe(2.2);
    expect(moveLabelMinZoom('flat', { width: 1200, height: 700 })).toBe(2.2);
  });

  it('asn text goes through the shared normaliser', () => {
    expect(moveLabelText({ counts: { new_ips: 0, new_serials: 0, new_asns: 0 }, to: { asns: ['4837'] } } as Pick<Movement, 'counts' | 'to'>)).toBe('AS4837');
  });

  it('keeps the top 3, plus the selected one', () => {
    const events = [mv('e1', 9, 'RU', 'US', 5), mv('e2', 8, 'CN', 'DE', 10), mv('e3', 7, 'IR', 'FR', 15), mv('e4', 6, 'KP', 'GB', 20), mv('e5', 1, 'BR', 'ES', 25)];
    const model = buildMovementModel(events, { nowMs: Date.now(), periodMs: 7 * 864e5 });
    const size = { width: 4000, height: 3000 };
    // far-apart, long hops: nothing is too short or collides, so only the cap decides
    const project = ([lng, lat]: [number, number]) => ({ x: 2000 + lng * 10, y: 1500 - lat * 10 });
    const plain = placeLensLabels({ edges: [], hosts: [], nodes: [], moves: moveLabelSources(model, '') }, project, size);
    expect(MAX_MOVE_LABELS).toBe(3);
    expect(plain.moves).toHaveLength(MAX_MOVE_LABELS);
    const sources = moveLabelSources(model, 'e5');
    expect(sources.filter(s => s.selected)).toHaveLength(1);
    const withSel = placeLensLabels({ edges: [], hosts: [], nodes: [], moves: sources }, project, size);
    expect(withSel.moves).toHaveLength(MAX_MOVE_LABELS + 1);
    expect(withSel.moves![0]!.id).toBe(sources.find(s => s.selected)!.id); // the selected one is placed first
  });

  it('a label never leans past 35 degrees and is never upside down', () => {
    expect(MOVE_LABEL_MAX_TILT).toBe(35);
    expect(tiltOf({ x: 0, y: 0 }, { x: 100, y: 100 })).toBe(35); // steep down-right
    expect(tiltOf({ x: 0, y: 0 }, { x: 100, y: -100 })).toBe(-35);
    expect(tiltOf({ x: 100, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(0); // westward: flipped upright
    expect(tiltOf({ x: 0, y: 0 }, { x: 100, y: 10 })).toBeCloseTo(5.71, 1);
    expect(tiltOf({ x: 100, y: 100 }, { x: 0, y: 0 })).toBe(35);
  });
});

describe('replay dots settle brighter and larger', () => {
  it('settled alpha ~90 and radius ~2.6', () => {
    expect(SETTLE_ALPHA).toBe(90);
    expect(SETTLE_RADIUS_PX).toBe(2.6);
    expect(replayDotState(1000, 0, false)).toEqual({ radius: 2.6, alpha: 90 });
  });
});
