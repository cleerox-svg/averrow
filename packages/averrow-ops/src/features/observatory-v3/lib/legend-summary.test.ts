import { describe, it, expect } from 'vitest';
import { legendSummary, type SummaryInput } from './legend-summary';

const ok = { isLoading: false, error: null };
const base: SummaryInput = {
  lens: 'threats', view: 'points', measure: 'index', nodes: 12, threats: ok, velocity: { ...ok, count: null },
  takedowns: { countries: { ...ok, count: null }, providers: { ...ok, count: null } },
  operations: { ...ok, count: null }, movement: { ...ok, count: null, events: 0 }, hosting: { ...ok, count: null },
  baseline: { ...ok, count: null }, bot: { ...ok, count: null }, campaigns: { ...ok, count: null },
  actors: { ...ok, selected: false, countries: null, empty: false },
};

describe('legendSummary: the closed chip tells the truth', () => {
  it('counts what is drawn', () => {
    expect(legendSummary(base)).toEqual({ text: '12 nodes', tone: 'ok' });
    expect(legendSummary({ ...base, lens: 'hosting', hosting: { ...ok, count: 1 } })).toEqual({ text: '1 provider', tone: 'ok' });
    expect(legendSummary({ ...base, lens: 'baseline', baseline: { ...ok, count: 40 } })).toEqual({ text: '40 countries', tone: 'ok' });
    expect(legendSummary({ ...base, lens: 'baseline', measure: 'bot', bot: { ...ok, count: 90 } })).toEqual({ text: '90 countries', tone: 'ok' });
    expect(legendSummary({ ...base, view: 'heat' })).toEqual({ text: 'density', tone: 'ok' });
  });
  it('loading and failed are visible on the closed chip', () => {
    expect(legendSummary({ ...base, lens: 'operations', operations: { isLoading: true, error: null, count: null } })).toEqual({ text: 'loading…', tone: 'loading' });
    expect(legendSummary({ ...base, lens: 'operations', operations: { isLoading: false, error: new Error('x'), count: null } })).toEqual({ text: 'failed to load', tone: 'error' });
    // a background refresh failing keeps the numbers it has
    expect(legendSummary({ ...base, lens: 'operations', operations: { isLoading: false, error: new Error('x'), count: 4 } }).tone).toBe('ok');
  });
  it('an empty lens never reads as all clear', () => {
    expect(legendSummary({ ...base, lens: 'campaigns', campaigns: { ...ok, count: 0 } })).toEqual({ text: 'none placeable', tone: 'empty' });
    expect(legendSummary({ ...base, nodes: 0 })).toEqual({ text: 'nothing mapped', tone: 'empty' });
    expect(legendSummary({ ...base, lens: 'movement', movement: { ...ok, count: 0, events: 0 } }).text).toBe('no moves');
    expect(legendSummary({ ...base, lens: 'movement', movement: { ...ok, count: 0, events: 3 } }).text).toBe('none placeable');
  });
  it('actors: pick one first; then loading / failure / no attributed infrastructure / a count', () => {
    expect(legendSummary({ ...base, lens: 'actors' })).toEqual({ text: 'pick an actor', tone: 'empty' });
    const sel = { selected: true, countries: null as number | null, empty: false };
    expect(legendSummary({ ...base, lens: 'actors', actors: { isLoading: true, error: null, ...sel } }).tone).toBe('loading');
    expect(legendSummary({ ...base, lens: 'actors', actors: { isLoading: false, error: new Error('x'), ...sel } }).tone).toBe('error');
    expect(legendSummary({ ...base, lens: 'actors', actors: { ...ok, selected: true, countries: 0, empty: true } }).text).toBe('no attributed infra');
    expect(legendSummary({ ...base, lens: 'actors', actors: { ...ok, selected: true, countries: 3, empty: false } }).text).toBe('3 countries');
  });
});

describe('legendSummary: Fast weaponization view', () => {
  const fast = { ...base, view: 'fast' as const };
  it('counts countries; empty reads as coverage still filling, never as "none"', () => {
    expect(legendSummary({ ...fast, velocity: { ...ok, count: 7 } })).toEqual({ text: '7 countries', tone: 'ok' });
    expect(legendSummary({ ...fast, velocity: { ...ok, count: 1 } })).toEqual({ text: '1 country', tone: 'ok' });
    expect(legendSummary({ ...fast, velocity: { ...ok, count: 0 } })).toEqual({ text: 'coverage filling', tone: 'empty' });
  });
  it('loading and failure states', () => {
    expect(legendSummary({ ...fast, velocity: { isLoading: true, error: null, count: null } })).toEqual({ text: 'loading…', tone: 'loading' });
    expect(legendSummary({ ...fast, velocity: { isLoading: false, error: new Error('x'), count: null } })).toEqual({ text: 'failed to load', tone: 'error' });
  });
  it('the Points view still reads the nodes, not the velocity query', () => {
    expect(legendSummary({ ...base, velocity: { ...ok, count: 9 } })).toEqual({ text: '12 nodes', tone: 'ok' });
  });
});

describe('legendSummary: takedown outcomes', () => {
  it('Baseline > Takedowns counts countries with a takedown history; Hosting > Takedowns counts hosts', () => {
    const bt = { ...base, lens: 'baseline' as const, measure: 'takedowns' as const };
    expect(legendSummary({ ...bt, takedowns: { ...base.takedowns, countries: { ...ok, count: 12 } } })).toEqual({ text: '12 countries', tone: 'ok' });
    expect(legendSummary({ ...bt, takedowns: { ...base.takedowns, countries: { ...ok, count: 0 } } })).toEqual({ text: 'no takedowns', tone: 'empty' });
    const ht = { ...base, lens: 'hosting' as const, measure: 'takedowns' as const };
    expect(legendSummary({ ...ht, takedowns: { ...base.takedowns, providers: { ...ok, count: 3 } } })).toEqual({ text: '3 hosts', tone: 'ok' });
    expect(legendSummary({ ...ht, takedowns: { ...base.takedowns, providers: { isLoading: true, error: null, count: null } } })).toEqual({ text: 'loading…', tone: 'loading' });
    expect(legendSummary({ ...ht, takedowns: { ...base.takedowns, providers: { isLoading: false, error: new Error('x'), count: null } } })).toEqual({ text: 'failed to load', tone: 'error' });
  });
  it('the default measures still read the lens\'s own data', () => {
    expect(legendSummary({ ...base, lens: 'hosting', hosting: { ...ok, count: 4 } })).toEqual({ text: '4 providers', tone: 'ok' });
    expect(legendSummary({ ...base, lens: 'baseline', baseline: { ...ok, count: 9 } })).toEqual({ text: '9 countries', tone: 'ok' });
  });
});
