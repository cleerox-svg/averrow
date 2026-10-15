import { describe, it, expect } from 'vitest';
import {
  parseEventKinds, serializeEventKinds, visibleKinds, eventAge, eventAgeSpoken, groupByAge, orderQueue, holdFor, stepIndex, freshCriticals,
  eventTargetPatch, eventFlyPoint, eventFallbackSel, totalCount, viaLine, railLimit, splitLeadEntity, emptyFeedCopy, chipCountText, SEVERITY_LABEL,
  EVENT_KINDS, EVENTS_DEFAULT_LIMIT, type ObservatoryEvent,
} from './events';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ev = (id: string, over: Partial<ObservatoryEvent> = {}): ObservatoryEvent => ({
  id, kind: 'fast', severity: 'high', title: `title ${id}`, entity: { type: 'domain', id, name: id },
  place: { country_code: 'US', country_name: 'United States', lat: 38, lng: -97 }, count: 1, occurred_at: ago(1), source: 'sentinel',
  target: { lens: 'threats', select: 'country:US' }, ...over,
});

describe('ev kinds', () => {
  it('parses known kinds only, in canonical order, deduplicated', () => {
    expect(parseEventKinds('spike,critical,critical,bogus')).toEqual(['critical', 'spike']);
    expect(parseEventKinds(' Fast , TAKEDOWN ')).toEqual(['fast', 'takedown']);
    expect(parseEventKinds('')).toEqual([]);
    expect(parseEventKinds(null)).toEqual([]);
  });
  it('naming every kind is no filter; serialising an empty / full list writes nothing', () => {
    expect(parseEventKinds(EVENT_KINDS.join(','))).toEqual([]);
    expect(serializeEventKinds([])).toBeNull();
    expect(serializeEventKinds([...EVENT_KINDS])).toBeNull();
    expect(serializeEventKinds(['spike', 'critical'])).toBe('critical,spike');
  });
  it('kinds the server withheld are not offered', () => {
    expect(visibleKinds(['takedown'])).toEqual(['critical', 'operation', 'fast', 'lookalike', 'actor', 'spike']);
    expect(visibleKinds([])).toEqual([...EVENT_KINDS]);
  });
});

describe('ages and groups', () => {
  it('formats relative ages', () => {
    expect(eventAge(ago(0), NOW)).toBe('now');
    expect(eventAge(ago(2), NOW)).toBe('2m');
    expect(eventAge(ago(59), NOW)).toBe('59m');
    expect(eventAge(ago(180), NOW)).toBe('3h');
    expect(eventAge(ago(60 * 50), NOW)).toBe('2d');
    expect(eventAge('not a date', NOW)).toBe('');
    expect(eventAgeSpoken(ago(1), NOW)).toBe('1 minute ago');
    expect(eventAgeSpoken(ago(180), NOW)).toBe('3 hours ago');
  });
  it('splits into last 15 min / 15–45 min / older at the boundaries, dropping empty groups', () => {
    const list = [ev('a', { occurred_at: ago(0) }), ev('b', { occurred_at: ago(14.9) }), ev('c', { occurred_at: ago(15) }), ev('d', { occurred_at: ago(44.9) }), ev('e', { occurred_at: ago(45) }), ev('f', { occurred_at: ago(600) })];
    const g = groupByAge(list, NOW);
    expect(g.map(x => [x.key, x.label, x.events.map(e => e.id)])).toEqual([
      ['recent', 'Last 15 min', ['a', 'b']], ['mid', '15–45 min', ['c', 'd']], ['older', 'Older', ['e', 'f']],
    ]);
    expect(groupByAge([ev('x', { occurred_at: ago(3) })], NOW).map(x => x.key)).toEqual(['recent']);
    expect(groupByAge([], NOW)).toEqual([]);
  });
  it('totals record counts, falling back to the item count', () => {
    expect(totalCount({ critical: 12, fast: 3 }, 2)).toBe(15);
    expect(totalCount({}, 4)).toBe(4);
  });
  it('writes the rail attribution and sizes the page per period', () => {
    expect(viaLine({ source: 'sparrow' })).toBe('via Sparrow');
    expect(viaLine({ source: 'lookalike_scanner' })).toBe('via lookalike scanner');
    expect(viaLine({ source: 'cloudflare_radar' })).toBe('via Cloudflare Radar');
    expect(SEVERITY_LABEL.critical).toBe('Critical');
    expect(railLimit('7d')).toBe(100);
  });
  it('the rail\'s 1h view asks for exactly the warmed default page (so it shares the headline bar\'s key)', () => {
    expect(railLimit('1h')).toBe(EVENTS_DEFAULT_LIMIT);
    expect(railLimit('1h')).toBe(40);
  });
  it('spells a chip count: records, in items', () => {
    expect(chipCountText('critical', 17, 3)).toBe('17 critical records in 3 items');
    expect(chipCountText('fast', 1, 1)).toBe('1 fast record in 1 item');
  });
  it('splits the leading entity off a title (also "Operation X" for an operation named X)', () => {
    expect(splitLeadEntity('Acme Bank targeted by 12 new phishing pages', 'Acme Bank')).toEqual(['Acme Bank', ' targeted by 12 new phishing pages']);
    expect(splitLeadEntity('Operation Invoice kit linked to TA4903', 'Invoice kit')).toEqual(['Operation Invoice kit', ' linked to TA4903']);
    expect(splitLeadEntity('Vietnam at 4.2× its usual share', 'Vietnam')[0]).toBe('Vietnam');
    expect(splitLeadEntity('A different sentence', 'Acme Bank')).toEqual(['', 'A different sentence']);
    expect(splitLeadEntity('Anything', '')).toEqual(['', 'Anything']);
    expect(splitLeadEntity('Anything', null)).toEqual(['', 'Anything']);
  });
  it('empty copy is true to the server window, never "the last hour"', () => {
    expect(emptyFeedCopy('1h')).toBe('No new threat events in the past hour or so');
    expect(emptyFeedCopy('24h')).toBe('No new threat events in the past day or so');
    expect(emptyFeedCopy('7d')).toBe('No new threat events in the past week');
    expect(emptyFeedCopy('1h', ['actor', 'spike'])).toBe('No actors or spikes events in the past hour or so');
  });
});

describe('headline queue', () => {
  const a = ev('a'), b = ev('b', { severity: 'critical', kind: 'critical' }), c = ev('c'), d = ev('d', { severity: 'critical', kind: 'critical' });
  it('critical events go first, each group keeps the server (newest-first) order', () => {
    expect(orderQueue([a, b, c, d]).map(e => e.id)).toEqual(['b', 'd', 'a', 'c']);
  });
  it('holds critical events for 12s and the rest for 6s', () => {
    expect(holdFor(b)).toBe(12_000);
    expect(holdFor(a)).toBe(6_000);
  });
  it('steps with wrap-around and falls back when the current event is gone', () => {
    const q = orderQueue([a, b, c, d]);
    expect(stepIndex(q, 'c', 1)).toBe(0);
    expect(stepIndex(q, 'b', -1)).toBe(3);
    expect(stepIndex(q, 'gone', 1, 2)).toBe(2);
    expect(stepIndex(q, null, 1, 99)).toBe(3);
    expect(stepIndex([], 'a', 1)).toBe(-1);
  });
  it('finds unseen critical events only', () => {
    expect(freshCriticals([a, b, d], new Set(['d'])).map(e => e.id)).toEqual(['b']);
    expect(freshCriticals([a, c], new Set())).toEqual([]);
  });
});

describe('click target', () => {
  const view = { view: 'points', measure: 'index' };
  it('applies the lens and the sel, clearing node / arc', () => {
    expect(eventTargetPatch(ev('a', { target: { lens: 'actors', select: 'actor:TA4903' } }), view)).toEqual({ lens: 'actors', node: null, arc: null, sel: 'actor:TA4903' });
    expect(eventTargetPatch(ev('a', { target: { lens: 'movement', select: 'move:evt_9' } }), view).sel).toBe('move:evt_9');
  });
  it('falls back to the event country when the server gave no usable select', () => {
    expect(eventTargetPatch(ev('a', { target: { lens: 'threats' } }), view).sel).toBe('country:US');
    expect(eventTargetPatch(ev('a', { target: { lens: 'threats', select: 'garbage' } }), view).sel).toBe('country:US');
    expect(eventTargetPatch(ev('a', { target: { lens: 'threats', select: 'country:usa' } }), view).sel).toBe('country:US');
    expect(eventTargetPatch(ev('a', { target: { lens: 'threats' }, place: { country_code: null, country_name: null, lat: null, lng: null } }), view).sel).toBeNull();
  });
  it('an unknown lens means threats', () => {
    expect(eventTargetPatch(ev('a', { target: { lens: 'nonsense' } }), view).lens).toBe('threats');
  });
  it('leaves a scene that cannot hold a selection', () => {
    expect(eventTargetPatch(ev('a'), { view: 'heat', measure: 'index' }).view).toBe('points');
    expect(eventTargetPatch(ev('a'), { view: 'fast', measure: 'index' }).view).toBeUndefined();
    expect(eventTargetPatch(ev('a', { target: { lens: 'baseline', select: 'country:VN' } }), { view: 'points', measure: 'bot' }).measure).toBe('index');
    expect(eventTargetPatch(ev('a', { target: { lens: 'hosting' } }), { view: 'points', measure: 'bot' }).measure).toBeUndefined();
  });
  it('keeps the event\'s country as the fallback for a sel the lens cannot resolve', () => {
    expect(eventFallbackSel(ev('a'), 'move:evt_9')).toBe('country:US');
    expect(eventFallbackSel(ev('a'), 'provider:hp_1')).toBe('country:US');
    // Already the country: nothing to fall back to. No country: nowhere to fall back.
    expect(eventFallbackSel(ev('a'), 'country:US')).toBeNull();
    expect(eventFallbackSel(ev('a', { place: { country_code: null, country_name: null, lat: null, lng: null } }), 'move:evt_9')).toBeNull();
    expect(eventFallbackSel(ev('a', { place: { country_code: 'usa', country_name: null, lat: null, lng: null } }), 'move:evt_9')).toBeNull();
  });
  it('flies to the event point, else its country, else nowhere', () => {
    expect(eventFlyPoint(ev('a'))).toEqual([-97, 38]);
    const c = eventFlyPoint(ev('a', { place: { country_code: 'NL', country_name: 'Netherlands', lat: null, lng: null } }));
    expect(c).not.toBeNull();
    expect(eventFlyPoint(ev('a', { place: { country_code: null, country_name: null, lat: null, lng: null } }))).toBeNull();
    expect(eventFlyPoint(ev('a', { place: { country_code: 'ZZ', country_name: null, lat: null, lng: null } }))).toBeNull();
  });
});
