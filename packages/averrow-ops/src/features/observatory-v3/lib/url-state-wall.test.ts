import { describe, it, expect } from 'vitest';
import {
  parseObservatoryParams, applyObservatoryState, mergeObservatoryState, OWNED_KEYS, DEFAULT_STATE,
  parseSeverities, parseTypes, parseBrand, defaultProjectionFor,
} from './url-state';

const parse = (qs: string) => parseObservatoryParams(new URLSearchParams(qs));
const roundTrip = (qs: string) => applyObservatoryState(new URLSearchParams(), parse(qs)).toString();

describe('wall=1', () => {
  it('is an owned key and defaults the projection to the globe', () => {
    expect(OWNED_KEYS).toContain('wall');
    const s = parse('wall=1');
    expect(s.wall).toBe(true);
    expect(s.proj).toBe('globe');
    expect(defaultProjectionFor(true)).toBe('globe');
    expect(defaultProjectionFor(false)).toBe('flat');
  });
  it('the globe is not written back on a wall link; flat is (it is not the wall default)', () => {
    expect(roundTrip('wall=1')).toBe('wall=1');
    expect(roundTrip('wall=1&proj=globe')).toBe('wall=1');
    expect(roundTrip('wall=1&proj=flat')).toBe('proj=flat&wall=1');
  });
  it('without wall nothing changes: flat default, globe written', () => {
    expect(parse('').wall).toBe(false);
    expect(parse('').proj).toBe('flat');
    expect(roundTrip('proj=globe')).toBe('proj=globe');
    expect(roundTrip('wall=0')).toBe('');
  });
  it('leaves keys that are not ours alone', () => {
    const out = applyObservatoryState(new URLSearchParams('foo=1&wall=1'), parse('wall=1'));
    expect(out.get('foo')).toBe('1');
  });
  it('a patch can turn it off and keeps the projection in view', () => {
    const next = mergeObservatoryState(parse('wall=1'), { wall: false });
    expect(next.wall).toBe(false);
    expect(applyObservatoryState(new URLSearchParams(), next).toString()).toBe('proj=globe');
  });
});

describe('sev / type / brand', () => {
  it('are owned keys', () => {
    for (const k of ['sev', 'type', 'brand']) expect(OWNED_KEYS).toContain(k);
  });
  it('sev: known ids only, in severity order; all four = none', () => {
    expect(parseSeverities('high,critical,bogus')).toEqual(['critical', 'high']);
    expect(parseSeverities('critical,high,medium,low')).toEqual([]);
    expect(parseSeverities(null)).toEqual([]);
    expect(roundTrip('sev=high,critical')).toBe('sev=critical%2Chigh');
    expect(roundTrip('sev=critical,high,medium,low')).toBe('');
  });
  it('type: only the API\'s threat types, sorted and unique', () => {
    expect(parseTypes('phishing,c2,phishing,not_a_type,web_attack')).toEqual(['c2', 'phishing']);
    expect(roundTrip('type=phishing,c2')).toBe('type=c2%2Cphishing');
  });
  it('brand: one well-formed id, nothing else', () => {
    expect(parseBrand('brand_123')).toBe('brand_123');
    expect(parseBrand(' PayPal Inc ')).toBeNull();
    expect(parseBrand('a/b')).toBeNull();
    expect(parseBrand('')).toBeNull();
    expect(parseBrand('x'.repeat(129))).toBeNull();
    expect(roundTrip('brand=b_1')).toBe('brand=b_1');
  });
  it('defaults write nothing', () => {
    expect(DEFAULT_STATE.sev).toEqual([]);
    expect(DEFAULT_STATE.type).toEqual([]);
    expect(DEFAULT_STATE.brand).toBeNull();
    expect(roundTrip('')).toBe('');
  });
  it('a type / brand change clears the selection (its data changed); a severity change does not', () => {
    const base = { ...parse('node=10.00,20.00') };
    expect(mergeObservatoryState(base, { type: ['c2'] }).node).toBeNull();
    expect(mergeObservatoryState(base, { brand: 'b_1' }).node).toBeNull();
    expect(mergeObservatoryState(base, { sev: ['critical'] }).node).toBe('10.00,20.00');
  });
  it('a patch is normalised the way the URL would read it back', () => {
    const next = mergeObservatoryState(parse(''), { sev: ['low', 'critical'], type: ['phishing', 'c2'] });
    expect(next.sev).toEqual(['critical', 'low']);
    expect(next.type).toEqual(['c2', 'phishing']);
  });
});
