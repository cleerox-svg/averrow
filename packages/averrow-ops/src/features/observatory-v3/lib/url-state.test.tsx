import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  parseObservatoryParams, applyObservatoryState, mergeObservatoryState, DEFAULT_STATE,
  nodeKey, arcKey, useObservatoryUrlState,
} from './url-state';

const parse = (qs: string) => parseObservatoryParams(new URLSearchParams(qs));

describe('parseObservatoryParams', () => {
  it('returns defaults for an empty query', () => {
    expect(parse('')).toEqual(DEFAULT_STATE);
  });

  it('reads valid params', () => {
    const s = parse('period=30d&source=feeds&mode=heatmap&colorBy=type&layers=nodes,beams');
    expect(s).toMatchObject({ period: '30d', source: 'feeds', mode: 'heatmap', colorBy: 'type' });
    expect(s.layers).toEqual({ nodes: true, particles: false, beams: true });
  });

  it('falls back to defaults for invalid values', () => {
    const s = parse('period=1y&source=evil&mode=globe&colorBy=rainbow&layers=garbage');
    expect(s).toEqual(DEFAULT_STATE);
  });

  it('layers=none turns every layer off', () => {
    expect(parse('layers=none').layers).toEqual({ nodes: false, particles: false, beams: false });
  });

  it('keeps node/arc only in global mode and validates the node key', () => {
    expect(parse('node=40.71,-74.01').node).toBe('40.71,-74.01');
    expect(parse('node=not-a-key').node).toBeNull();
    expect(parse('mode=heatmap&node=40.71,-74.01').node).toBeNull();
    expect(parse('arc=phishing|paypal|10.0,20.0|high').arc).toBe('phishing|paypal|10.0,20.0|high');
    expect(parse('arc=' + 'x'.repeat(500)).arc).toBeNull();
  });

  it('node wins over arc when both are present', () => {
    const s = parse('node=1.00,2.00&arc=a|b|1.0,2.0|low');
    expect(s.node).toBe('1.00,2.00');
    expect(s.arc).toBeNull();
  });
});

describe('applyObservatoryState', () => {
  it('writes only non-default values and round-trips', () => {
    const state = parse('period=90d&source=spam_trap&colorBy=type&layers=nodes&arc=a|b|1.0,2.0|low');
    const out = applyObservatoryState(new URLSearchParams(), state);
    expect(out.get('period')).toBe('90d');
    expect(out.has('mode')).toBe(false);
    expect(parseObservatoryParams(out)).toEqual(state);
  });

  it('writes nothing for the default state', () => {
    expect(applyObservatoryState(new URLSearchParams(), DEFAULT_STATE).toString()).toBe('');
  });

  it('preserves foreign params and canonicalises ours', () => {
    const out = applyObservatoryState(new URLSearchParams('foo=bar&period=zzz'), parse('period=zzz'));
    expect(out.toString()).toBe('foo=bar');
  });
});

describe('mergeObservatoryState', () => {
  const selected = { ...DEFAULT_STATE, node: '1.00,2.00' };

  it('clears the selection when period, source or mode changes', () => {
    expect(mergeObservatoryState(selected, { period: '24h' }).node).toBeNull();
    expect(mergeObservatoryState(selected, { source: 'feeds' }).node).toBeNull();
    expect(mergeObservatoryState(selected, { mode: 'heatmap' }).node).toBeNull();
  });

  it('keeps the selection for unrelated changes and no-op period sets', () => {
    expect(mergeObservatoryState(selected, { colorBy: 'type' }).node).toBe('1.00,2.00');
    expect(mergeObservatoryState(selected, { period: '7d' }).node).toBe('1.00,2.00');
    expect(mergeObservatoryState(selected, { layers: { beams: true } }).layers.beams).toBe(true);
  });

  it('selecting a node clears the arc and vice-versa', () => {
    const withArc = { ...DEFAULT_STATE, arc: 'a|b|1.0,2.0|low' };
    expect(mergeObservatoryState(withArc, { node: '3.00,4.00' })).toMatchObject({ node: '3.00,4.00', arc: null });
    expect(mergeObservatoryState(selected, { arc: 'x|y|1.0,2.0|low' })).toMatchObject({ node: null, arc: 'x|y|1.0,2.0|low' });
  });

  it('a patch that sets a selection survives a simultaneous view change', () => {
    expect(mergeObservatoryState(DEFAULT_STATE, { period: '24h', node: '1.00,2.00' }).node).toBe('1.00,2.00');
  });
});

describe('keys', () => {
  it('nodeKey rounds to 2dp', () => {
    expect(nodeKey({ lat: 40.7128, lng: -74.006 })).toBe('40.71,-74.01');
  });
  it('arcKey is stable and distinguishes severity', () => {
    const a = { threat_type: 'phishing', severity: 'high', brand_name: 'PayPal', sourcePosition: [10.04, 20.06] as [number, number] };
    expect(arcKey(a)).toBe('phishing|PayPal|10.0,20.1|high');
    expect(arcKey({ ...a, severity: 'low' })).not.toBe(arcKey(a));
  });
});

describe('useObservatoryUrlState', () => {
  function setup(initial: string) {
    const loc: { search: string } = { search: '' };
    function Probe({ children }: { children: ReactNode }) {
      loc.search = useLocation().search;
      return <>{children}</>;
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[`/observatory${initial}`]}><Probe>{children}</Probe></MemoryRouter>
    );
    return { loc, ...renderHook(() => useObservatoryUrlState(), { wrapper }) };
  }

  it('reads state from the URL and updates it', () => {
    const { result, loc } = setup('?period=24h');
    expect(result.current.state.period).toBe('24h');
    act(() => result.current.update({ source: 'feeds' }));
    expect(result.current.state.source).toBe('feeds');
    expect(loc.search).toContain('source=feeds');
    expect(loc.search).toContain('period=24h');
  });

  it('canonicalises a garbage URL on mount', () => {
    const { loc } = setup('?period=bogus&mode=heatmap');
    expect(loc.search).toBe('?mode=heatmap');
  });
});
