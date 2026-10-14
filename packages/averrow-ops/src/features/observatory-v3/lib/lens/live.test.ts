import { describe, it, expect } from 'vitest';
import type { LiveThreatEntry } from '@/hooks/useObservatory';
import { diffLive, announcePings, SEEN_CAP } from './live';
import { getCountryCentroid } from '@/lib/country-centroids';

const live = (id: string, o: Partial<LiveThreatEntry> = {}): LiveThreatEntry => ({
  id, threat_type: 'phishing', severity: 'high', country_code: 'DE', created_at: '2026-10-14 10:00:00', malicious_domain: 'evil.example', ...o,
});

describe('diffLive', () => {
  it('the first batch only seeds the seen-set (nothing "just arrived")', () => {
    const seen = new Set<string>();
    expect(diffLive(seen, [live('a'), live('b')], false)).toEqual([]);
    expect(seen.size).toBe(2);
  });
  it('after priming, only unseen ids are new and carry their origin centroid + severity colour', () => {
    const seen = new Set(['a']);
    const fresh = diffLive(seen, [live('a'), live('b', { severity: 'critical', country_code: 'us' })], true);
    expect(fresh.map(f => f.id)).toEqual(['b']);
    expect(fresh[0].position).toEqual(getCountryCentroid('US'));
    expect(fresh[0].color[0]).toBe(200); // critical red
    expect(diffLive(seen, [live('b')], true)).toEqual([]); // not new twice
  });
  it('an unknown country is announced but not drawable', () => {
    const [p] = diffLive(new Set(), [live('z', { country_code: null })], true);
    expect(p.position).toBeNull();
  });
  it('bounds the seen-set', () => {
    const seen = new Set<string>();
    diffLive(seen, Array.from({ length: SEEN_CAP + 50 }, (_, i) => live(`i${i}`)), false);
    expect(seen.size).toBe(SEEN_CAP);
    expect(seen.has('i0')).toBe(false);
    expect(seen.has(`i${SEEN_CAP + 49}`)).toBe(true);
  });
  it('tolerates undefined data', () => {
    expect(diffLive(new Set(), undefined, true)).toEqual([]);
  });
});

describe('announcePings', () => {
  const [a, b, c] = diffLive(new Set(), [live('1'), live('2', { threat_type: 'c2' }), live('3')], true);
  it('describes a single ping in full', () => {
    expect(announcePings([a])).toBe('New phishing threat from DE: evil.example');
  });
  it('summarises a burst by type', () => {
    expect(announcePings([a, b, c])).toBe('3 new threats: 2 phishing, 1 c2');
  });
  it('is empty for nothing', () => {
    expect(announcePings([])).toBe('');
  });
});
