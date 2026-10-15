import { describe, it, expect } from 'vitest';
import { trendView } from './trend';
import { moveLabelText, moveLabelMinZoom, buildMovementModel } from './lens/movement';
import { ringRadiusPx, RING_RADIUS_PX, ImpactRingSpawner } from '../anim/impact-rings';
import { RingBuffer, DEFAULT_RING_RADIUS_PX } from '../anim/ring-buffer';
import { replayDotState, sampleDots, POP_UNITS, SETTLE_ALPHA, SETTLE_RADIUS_PX, MAX_REPLAY_DOTS } from '../anim/replay-dots';
import { moveLabelSources } from '../layers/lens-labels';
import { placeLensLabels, stablePlacement, NO_LABELS } from '../layers/lens-labels';
import type { Movement } from '@/hooks/useObservatoryLenses';
import type { ArrivalEvent } from '../anim/arrivals';

describe('trendView: vs prior period', () => {
  it('up and down with the rounded percentage', () => {
    expect(trendView({ current: 120, prior: 100, delta_pct: 20 })).toMatchObject({ direction: 'up', text: '▲ 20%' });
    expect(trendView({ current: 90, prior: 100, delta_pct: -10.04 })).toMatchObject({ direction: 'down', text: '▼ 10%' });
  });
  it('"new" when there was nothing before and there is something now', () => {
    expect(trendView({ current: 5, prior: 0, delta_pct: null })).toMatchObject({ direction: 'new', text: 'new' });
  });
  it('nothing at all when absent, or with no activity in either window', () => {
    expect(trendView(undefined)).toBeNull();
    expect(trendView(null)).toBeNull();
    expect(trendView({ current: 0, prior: 0, delta_pct: null })).toBeNull();
  });
  it('flat', () => {
    expect(trendView({ current: 100, prior: 100, delta_pct: 0 })).toMatchObject({ direction: 'flat', text: 'no change' });
  });
});

const mv = (over: Partial<Movement> = {}): Movement => ({
  id: 'm1', kind: 'infra_movement', cluster_id: 'c', cluster_name: 'Cluster', at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  from: { asns: ['AS1'], countries: ['NL'] }, to: { asns: ['AS4837'], countries: ['CN'] },
  counts: { new_asns: 1, new_ips: 3, new_serials: 0 }, payload_v: 2, ...over,
});

describe('Movement hop labels', () => {
  it('says what moved: "+3 IPs · AS4837"', () => {
    expect(moveLabelText(mv())).toBe('+3 IPs · AS4837');
  });
  it('singular, certs when there are no IPs, an ASN count when none is named, nothing when nothing is known', () => {
    expect(moveLabelText(mv({ counts: { new_asns: 0, new_ips: 1, new_serials: 0 } }))).toBe('+1 IP · AS4837');
    expect(moveLabelText(mv({ counts: { new_asns: 0, new_ips: 0, new_serials: 2 } }))).toBe('+2 certs · AS4837');
    expect(moveLabelText(mv({ to: { asns: [], countries: ['CN'] }, counts: { new_asns: 2, new_ips: 3, new_serials: 0 } }))).toBe('+3 IPs · +2 ASNs');
    expect(moveLabelText(mv({ to: { asns: [], countries: ['CN'] }, counts: { new_asns: 0, new_ips: 0, new_serials: 0 } }))).toBe('');
    expect(moveLabelText(mv({ to: { asns: ['4837'], countries: ['CN'] } }))).toContain('AS4837');
  });
  it('every hop carries its event\'s label, and one source is made per event (its longest hop), selected first', () => {
    const model = buildMovementModel([mv(), mv({ id: 'm2', counts: { new_asns: 0, new_ips: 9, new_serials: 0 }, to: { asns: ['AS9'], countries: ['US'] } })], { nowMs: Date.now(), periodMs: 7 * 864e5 });
    expect(model.hops.every(h => h.label !== '')).toBe(true);
    const sources = moveLabelSources(model, '');
    expect(sources.map(s => s.id.split(':')[0]).sort()).toEqual(['m1', 'm2']);
    expect(sources[0]!.text).toBe('+9 IPs · AS9'); // bigger move first
    expect(moveLabelSources(model, 'm1')[0]!.id.startsWith('m1')).toBe(true); // the selected event outranks it
  });
  it('is placed in screen space, and left out at the world view', () => {
    const model = buildMovementModel([mv()], { nowMs: Date.now(), periodMs: 7 * 864e5 });
    const moves = moveLabelSources(model, '');
    const size = { width: 1200, height: 700 };
    let i = 0;
    // each lng/lat maps far apart on screen so the hop is long enough to carry its words
    const project = ([lng, lat]: [number, number]) => ({ x: 600 + lng * 3, y: 350 - lat * 3 + (i++ % 2) });
    const placed = placeLensLabels({ edges: [], hosts: [], nodes: [], moves }, project, size);
    expect(placed.moves?.[0]?.text).toBe('+3 IPs · AS4837');
    expect(moveLabelMinZoom('flat', size)).toBeGreaterThan(1);
    expect(moveLabelMinZoom('globe', size)).toBeGreaterThan(0);
    // none placed: the key is absent, like the other label sets
    expect(placeLensLabels({ edges: [], hosts: [], nodes: [] }, project, size)).toEqual({ ...NO_LABELS });
    // stablePlacement notices a changed movement label
    expect(stablePlacement(placed, { ...placed, moves: [] })).not.toBe(placed);
    expect(stablePlacement(placed, { ...placed })).toBe(placed);
  });
});

describe('impact ring size follows arc volume', () => {
  it('log-scaled between the min and the max, never outside', () => {
    const d = RING_RADIUS_PX.desktop;
    expect(ringRadiusPx(1, false)).toBe(d.min);
    expect(ringRadiusPx(0, false)).toBe(d.min);
    expect(ringRadiusPx(1000, false)).toBe(d.max);
    expect(ringRadiusPx(1e9, false)).toBe(d.max);
    const mid = ringRadiusPx(30, false)!;
    expect(mid).toBeGreaterThan(d.min);
    expect(mid).toBeLessThan(d.max);
    expect(ringRadiusPx(1000, true)).toBe(RING_RADIUS_PX.mobile.max);
    expect(ringRadiusPx(undefined, false)).toBeUndefined();
    expect(ringRadiusPx(Number.NaN, false)).toBeUndefined();
  });
  it('the spawner writes each ring\'s own radius; a ring without one gets the default', () => {
    const buf = new RingBuffer(4);
    const ev = (key: string, volume?: number): ArrivalEvent => ({ time: 0, lng: 1, lat: 2, color: [255, 0, 0, 255], key, volume });
    const sp = new ImpactRingSpawner(buf, { radiusFor: e => ringRadiusPx(e.volume, false) });
    sp.spawn([ev('a', 1000), ev('b', 1), ev('c')], 10);
    const info = (i: number) => ({ index: i, target: [] as number[] });
    expect(buf.getRadius(0, info(0))).toBe(RING_RADIUS_PX.desktop.max);
    expect(buf.getRadius(0, info(1))).toBe(RING_RADIUS_PX.desktop.min);
    expect(buf.getRadius(0, info(2))).toBe(DEFAULT_RING_RADIUS_PX);
  });
});

describe('replay dots: pop in at the timestamp, settle faint', () => {
  it('hidden before their time', () => {
    expect(replayDotState(10, 50, false)).toEqual({ radius: 0, alpha: 0 });
  });
  it('pop: bigger and brighter than settled while young, settled after POP_UNITS', () => {
    const young = replayDotState(60, 50, false);
    expect(young.radius).toBeGreaterThan(SETTLE_RADIUS_PX);
    expect(young.alpha).toBeGreaterThan(SETTLE_ALPHA);
    const old = replayDotState(50 + POP_UNITS, 50, false);
    expect(old).toEqual({ radius: SETTLE_RADIUS_PX, alpha: SETTLE_ALPHA });
    expect(replayDotState(3000, 50, false)).toEqual(old);
  });
  it('the pop rises then falls (a pop, not a ramp)', () => {
    const [start, peak, late] = [0, 8, 39].map(a => replayDotState(100 + a, 100, false).radius);
    expect(peak).toBeGreaterThan(start!);
    expect(peak).toBeGreaterThan(late!);
    expect(late).toBeGreaterThan(SETTLE_RADIUS_PX - 0.01);
  });
  it('static under reduced motion: always settled, never hidden, no time gate', () => {
    expect(replayDotState(0, 3000, true)).toEqual({ radius: SETTLE_RADIUS_PX, alpha: SETTLE_ALPHA });
    expect(replayDotState(3000, 0, true)).toEqual({ radius: SETTLE_RADIUS_PX, alpha: SETTLE_ALPHA });
  });
  it('a heavy period is sampled evenly down to the cap, in time order', () => {
    const many: ArrivalEvent[] = Array.from({ length: 5000 }, (_, i) => ({ time: i, lng: 0, lat: 0, color: [1, 1, 1, 1], key: String(i) }));
    const out = sampleDots(many);
    expect(out).toHaveLength(MAX_REPLAY_DOTS);
    expect(out[0]!.time).toBe(0);
    expect(out.every((e, i) => i === 0 || e.time > out[i - 1]!.time)).toBe(true);
    expect(sampleDots(many.slice(0, 10))).toHaveLength(10);
  });
});
