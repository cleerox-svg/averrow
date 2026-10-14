import { describe, it, expect } from 'vitest';
import type { Movement } from '@/hooks/useObservatoryLenses';
import { buildMovementModel, eventUnits, HOP_UNITS, hopLabel } from './movement';
import { ArrivalScheduler } from '../../anim/arrivals';
import { CYCLE_LENGTH } from '../trips';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = 86_400_000;
const mv = (o: Partial<Movement> & { id: string }): Movement => ({
  kind: 'infra_movement', cluster_id: 'c1', cluster_name: 'Cluster', at: '2026-10-11T00:00:00Z',
  from: { asns: [], countries: [] }, to: { asns: [], countries: [] },
  counts: { new_asns: 0, new_ips: 0, new_serials: 0 }, payload_v: 2, ...o,
});
const build = (list: Movement[]) => buildMovementModel(list, { nowMs: NOW, periodMs: 7 * DAY });

describe('eventUnits', () => {
  it('maps the event time inside the period linearly onto the cycle', () => {
    expect(eventUnits(NOW - 7 * DAY, NOW, 7 * DAY)).toBe(0);
    expect(eventUnits(NOW - 3.5 * DAY, NOW, 7 * DAY)).toBeCloseTo(CYCLE_LENGTH / 2);
    expect(eventUnits(NOW, NOW, 7 * DAY)).toBe(CYCLE_LENGTH);
  });
  it('clamps events outside the window and bad input', () => {
    expect(eventUnits(NOW - 30 * DAY, NOW, 7 * DAY)).toBe(0);
    expect(eventUnits(NaN, NOW, 7 * DAY)).toBe(0);
    expect(eventUnits(NOW, NOW, 0)).toBe(0);
  });
});

describe('buildMovementModel', () => {
  it('sequences the hops of one event back to back', () => {
    const m = build([mv({ id: 'e', from: { asns: [], countries: ['MD', 'RU'] }, to: { asns: [], countries: ['NL'] } })]);
    expect(m.hops.filter(h => !h.id.endsWith(':w')).map(h => [h.fromCc, h.toCc, h.index])).toEqual([['MD', 'NL', 0], ['RU', 'NL', 1]]);
    const [h0, h1] = m.hops;
    expect(h1.startUnits - h0.startUnits).toBe(HOP_UNITS);
    expect(h0.timestamps[0]).toBe(h0.startUnits);
    expect(h0.timestamps.at(-1)).toBeCloseTo(h0.startUnits + HOP_UNITS);
    expect(hopLabel(h1)).toBe('2');
  });
  it('draws a v1 event (empty `from`) as a static pulse at `to`, never as a trail', () => {
    const m = build([mv({ id: 'v1', payload_v: 1, to: { asns: [], countries: ['NL', 'DE'] } })]);
    expect(m.hops).toHaveLength(0);
    expect(m.pulses.map(p => [p.cc, p.kind])).toEqual([['NL', 'arrival'], ['DE', 'arrival']]);
  });
  it('marks dormancy at the old location', () => {
    const m = build([mv({ id: 'd', kind: 'dormancy', from: { asns: ['AS1'], countries: ['RU'] } })]);
    expect(m.pulses).toEqual([expect.objectContaining({ cc: 'RU', kind: 'dormant' })]);
    expect(m.hops).toHaveLength(0);
  });
  it('a move inside one country is a pulse, and an event with nothing placeable is counted', () => {
    const m = build([
      mv({ id: 'same', from: { asns: [], countries: ['NL'] }, to: { asns: [], countries: ['NL'] } }),
      mv({ id: 'none', from: { asns: [], countries: ['ZZ'] }, to: { asns: [], countries: ['QQ'] } }),
    ]);
    expect(m.pulses.map(p => p.eventId)).toEqual(['same']);
    expect(m.unplaced).toBe(1);
  });
  it('emits a wrapped twin for a hop that runs past the end of the cycle', () => {
    const m = build([mv({ id: 'late', at: '2026-10-14T11:59:00Z', from: { asns: [], countries: ['MD'] }, to: { asns: [], countries: ['NL'] } })]);
    const twin = m.hops.find(h => h.id.endsWith(':w'))!;
    expect(twin).toBeDefined();
    expect(twin.timestamps[0]).toBeCloseTo(m.hops[0].timestamps[0] - CYCLE_LENGTH);
  });
  it('ring events (departure ghost + landing) are sorted and feed the arrival scheduler', () => {
    const m = build([
      mv({ id: 'b', at: '2026-10-13T00:00:00Z', from: { asns: [], countries: ['MD'] }, to: { asns: [], countries: ['NL'] } }),
      mv({ id: 'a', at: '2026-10-09T00:00:00Z', from: { asns: [], countries: ['RU'] }, to: { asns: [], countries: ['DE'] } }),
    ]);
    const times = m.ringEvents.map(e => e.time);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(m.ringEvents).toHaveLength(4);
    const sched = new ArrivalScheduler(m.ringEvents, CYCLE_LENGTH);
    const out = sched.collect(m.ringEvents[0].time - 1, m.ringEvents[0].time + 1);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].key.startsWith('g:')).toBe(true);
  });
});
