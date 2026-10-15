import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ThreatPoint } from '@/hooks/useObservatory';
import {
  NodeSlotRegistry, nodeTransitions, NODE_TRANSITION_MS, isGhost, isGhostNode, useSlottedNodes,
} from './node-transitions';

const n = (lat: number, count = 5, sev = 'high'): ThreatPoint => ({
  lat, lng: 10, threat_count: count, top_severity: sev, critical: 0, high: count, medium: 0, low: 0, country_code: 'NL', top_threat_type: 'phishing',
});

describe('nodeTransitions: the deck.gl config for the nodes layer', () => {
  it('eases radius and colour over ~500 ms', () => {
    const t = nodeTransitions(false)!;
    expect(NODE_TRANSITION_MS).toBe(500);
    expect(t.getRadius.duration).toBe(500);
    expect(t.getFillColor.duration).toBe(500);
    expect(t.getRadius.easing(0)).toBe(0);
    expect(t.getRadius.easing(1)).toBe(1);
    expect(t.getRadius.easing(0.5)).toBeGreaterThan(0.5); // ease-out
  });
  it('is undefined (instant) under reduced motion', () => {
    expect(nodeTransitions(true)).toBeUndefined();
  });
});

describe('NodeSlotRegistry: a stable slot per node id, so deck.gl interpolates a node with itself', () => {
  it('the same node keeps the same index across different data sets', () => {
    const reg = new NodeSlotRegistry();
    const a = n(1); const b = n(2); const c = n(3);
    const first = reg.layout([a, b, c], false).data;
    const second = reg.layout([c, a], false).data; // b left, order changed
    expect(first.map(x => x.lat)).toEqual([1, 2, 3]);
    expect(second.map(x => x.lat)).toEqual([1, 2, 3]);
    expect(second[0]).toBe(a);
    expect(second[2]).toBe(c);
  });

  it('a node absent from the new data stays as a ghost (zero count) so it can fade out', () => {
    const reg = new NodeSlotRegistry();
    reg.layout([n(1), n(2)], false);
    const out = reg.layout([n(1)], false).data;
    expect(out).toHaveLength(2);
    expect(isGhost(out[1]!)).toBe(true);
    expect(out[1]).toMatchObject({ lat: 2, threat_count: 0, critical: 0, high: 0 });
    expect(isGhostNode(out[1])).toBe(true);
    expect(isGhostNode(out[0])).toBe(false);
  });

  it('the first layout is never deferred (the initial load does not animate in)', () => {
    const reg = new NodeSlotRegistry();
    const out = reg.layout([n(1), n(2)], true);
    expect(out.deferred).toBe(0);
    expect(out.data.every(d => !isGhost(d))).toBe(true);
  });

  it('later, a node new in the data is first held as a ghost, then shown for real (so it eases in)', () => {
    const reg = new NodeSlotRegistry();
    reg.layout([n(1)], true);
    const held = reg.layout([n(1), n(2)], true);
    expect(held.deferred).toBe(1);
    expect(isGhost(held.data[1]!)).toBe(true);
    const shown = reg.layout([n(1), n(2)], true);
    expect(shown.deferred).toBe(0);
    expect(isGhost(shown.data[1]!)).toBe(false);
  });

  it('hands the input back unchanged when nothing is missing or held (identity shared)', () => {
    const reg = new NodeSlotRegistry();
    const nodes = [n(1), n(2)];
    expect(reg.layout(nodes, true).data).toBe(nodes);
  });

  it('starts over (instantly) when the registry would overflow', () => {
    const reg = new NodeSlotRegistry(3);
    reg.layout([n(1), n(2), n(3)], false);
    const out = reg.layout([n(10), n(11)], true);
    expect(out.data.map(d => d.lat)).toEqual([10, 11]);
    expect(out.deferred).toBe(0);
  });

  it('isGhostNode ignores things that are not nodes', () => {
    expect(isGhostNode(null)).toBe(false);
    expect(isGhostNode({ threat_count: 0 })).toBe(false); // a lens object, not a node
    expect(isGhostNode('x')).toBe(false);
  });
});

describe('useSlottedNodes', () => {
  it('under reduced motion it is the plain array', () => {
    const nodes = [n(1)];
    const { result, rerender } = renderHook(({ list }) => useSlottedNodes(list, false), { initialProps: { list: nodes } });
    expect(result.current).toBe(nodes);
    const next = [n(1), n(2)];
    rerender({ list: next });
    expect(result.current).toBe(next);
  });

  it('keeps a leaver as a ghost, and fills a newcomer in one frame after holding it back', async () => {
    const { result, rerender } = renderHook(({ list }) => useSlottedNodes(list, true), { initialProps: { list: [n(1), n(2)] } });
    rerender({ list: [n(1), n(3)] }); // 2 leaves, 3 arrives
    expect(result.current.map(d => [d.lat, d.threat_count > 0])).toEqual([[1, true], [2, false], [3, false]]);
    await act(async () => { await new Promise(r => setTimeout(r, 40)); });
    expect(result.current.map(d => [d.lat, d.threat_count > 0])).toEqual([[1, true], [2, false], [3, true]]);
  });
});
