import { describe, it, expect } from 'vitest';
import type { ActorDetail } from '@/hooks/useObservatoryLenses';
import { buildActorModel, confidenceValue, confidenceBand } from './actors';

const detail = (o: Partial<ActorDetail> = {}): ActorDetail => ({
  actor: { id: 'apt1', name: 'APT One', aliases: [], affiliation: null, country_code: null, capability: null, attribution_confidence: null, status: null, description: null, first_seen: null, last_seen: null },
  infrastructure: [], clusters: [], attributions: { by_confidence: {}, by_source: {} }, ...o,
});

describe('confidenceValue', () => {
  it('reads words, 0..1 and 0..100 numbers; null when unreadable', () => {
    expect(confidenceValue('High')).toBe(0.85);
    expect(confidenceValue('confirmed')).toBe(1);
    expect(confidenceValue(70)).toBe(0.7);
    expect(confidenceValue(0.4)).toBe(0.4);
    expect(confidenceValue('55')).toBe(0.55);
    expect(confidenceValue('???')).toBeNull();
    expect(confidenceValue(null)).toBeNull();
  });
  it('bands', () => {
    expect(confidenceBand(0.9)).toBe('high');
    expect(confidenceBand(0.6)).toBe('medium');
    expect(confidenceBand(0.2)).toBe('low');
    expect(confidenceBand(null)).toBe('unknown');
  });
});

describe('buildActorModel', () => {
  it('lights countries from infrastructure and clusters, keeping the best confidence', () => {
    const m = buildActorModel(detail({
      infrastructure: [
        { asn: 'AS1', country_code: 'NL', hosting_provider: 'H1', confidence: 'low', last_observed: '2026-10-01' },
        { asn: 'AS2', country_code: 'nl', hosting_provider: 'H2', confidence: 'high', last_observed: '2026-10-02' },
        { asn: null, country_code: 'RU', hosting_provider: null, confidence: 'medium', last_observed: '2026-10-02' },
      ],
      clusters: [{ id: 'c1', countries: ['NL', 'MD'], asns: ['AS1'], confidence_score: 40 }],
    }));
    const nl = m.countries.find(c => c.country === 'NL')!;
    expect(nl.items).toBe(3);
    expect(nl.confidence).toBe(0.85);
    expect(nl.asns).toEqual(['AS1', 'AS2']);
    expect(m.countries.map(c => c.country)).toContain('MD');
    expect(m.asns).toHaveLength(2);
    expect(m.empty).toBe(false);
  });
  it('counts unplaceable items and reports an empty actor as empty (not as "no activity")', () => {
    const m = buildActorModel(detail({
      infrastructure: [{ asn: 'AS9', country_code: null, hosting_provider: null, confidence: 'low', last_observed: '2026-10-01' }],
    }));
    expect(m.unplaced).toBe(1);
    expect(m.empty).toBe(true);
    expect(m.countries).toEqual([]);
  });
  it('all countries of one actor share a heartbeat phase', () => {
    const m = buildActorModel(detail({ clusters: [{ id: 'c', countries: ['NL', 'US'], asns: [], confidence_score: null }] }));
    expect(new Set(m.countries.map(c => c.phase)).size).toBe(1);
  });
});
