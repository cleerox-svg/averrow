import { describe, it, expect } from 'vitest';
import { legendSummary, type SummaryInput } from './legend-summary';

const ok = { isLoading: false, error: null };
const base: SummaryInput = {
  lens: 'threats', view: 'points', measure: 'index', nodes: 12, threats: ok,
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
