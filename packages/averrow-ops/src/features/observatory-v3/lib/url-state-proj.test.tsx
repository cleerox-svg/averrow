import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { lensPreset } from './lenses';
import { applyObservatoryState, mergeObservatoryState, parseObservatoryParams, DEFAULT_STATE, useObservatoryUrlState } from './url-state';

const parse = (qs: string) => parseObservatoryParams(new URLSearchParams(qs));

describe('proj (map projection) param', () => {
  it('defaults to flat: every pre-globe link opens on the flat map', () => {
    expect(DEFAULT_STATE.proj).toBe('flat');
    expect(parse('').proj).toBe('flat');
    expect(parse('lens=operations&period=30d&sel=op:cluster_1').proj).toBe('flat');
    expect(parse('mode=heatmap&layers=nodes').proj).toBe('flat');
  });

  it('reads proj=globe on any lens', () => {
    expect(parse('proj=globe').proj).toBe('globe');
    expect(parse('lens=baseline&measure=bot&proj=globe')).toMatchObject({ proj: 'globe', lens: 'baseline', measure: 'bot' });
    expect(parse('proj=flat').proj).toBe('flat');
  });

  it('falls back to flat for unknown values', () => {
    expect(parse('proj=mercator').proj).toBe('flat');
    expect(parse('proj=').proj).toBe('flat');
    expect(parse('proj=GLOBE').proj).toBe('flat');
  });

  it('writes only the non-default value, next to the other state', () => {
    expect(applyObservatoryState(new URLSearchParams(), { ...DEFAULT_STATE, proj: 'globe' }).toString()).toBe('proj=globe');
    expect(applyObservatoryState(new URLSearchParams('proj=globe'), DEFAULT_STATE).has('proj')).toBe(false);
    const both = applyObservatoryState(new URLSearchParams(), { ...DEFAULT_STATE, lens: 'hosting', layers: lensPreset('hosting'), proj: 'globe' });
    expect(both.get('lens')).toBe('hosting');
    expect(both.get('proj')).toBe('globe');
  });

  it('round-trips parse -> apply -> parse', () => {
    const s = parse('lens=campaigns&proj=globe&period=24h');
    expect(parse(applyObservatoryState(new URLSearchParams(), s).toString())).toEqual(s);
  });

  it('is a view setting, not a scene change: switching it keeps the selection, the lens and the layers', () => {
    const prev = { ...DEFAULT_STATE, lens: 'operations' as const, layers: lensPreset('operations'), sel: 'op:cluster_1' };
    const next = mergeObservatoryState(prev, { proj: 'globe' });
    expect(next.proj).toBe('globe');
    expect(next.sel).toBe('op:cluster_1');
    expect(next.lens).toBe('operations');
    expect(next.layers).toEqual(prev.layers);
    expect(mergeObservatoryState(next, { proj: 'flat' }).proj).toBe('flat');
  });

  it('changing the lens keeps the projection (the globe is a standing choice)', () => {
    expect(mergeObservatoryState({ ...DEFAULT_STATE, proj: 'globe' }, { lens: 'hosting' }).proj).toBe('globe');
  });

  it('is an owned key: a junk value is rewritten away and foreign params are left alone', () => {
    const out = applyObservatoryState(new URLSearchParams('proj=junk&utm=1'), parse('proj=junk&utm=1'));
    expect(out.has('proj')).toBe(false);
    expect(out.get('utm')).toBe('1');
  });

  it('the hook switches projection through the URL', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={['/observatory?lens=hosting']}>{children}</MemoryRouter>;
    const { result } = renderHook(() => useObservatoryUrlState(), { wrapper });
    expect(result.current.state.proj).toBe('flat');
    act(() => result.current.update({ proj: 'globe' }));
    expect(result.current.state.proj).toBe('globe');
    expect(result.current.state.lens).toBe('hosting');
    act(() => result.current.update({ proj: 'flat' }));
    expect(result.current.state.proj).toBe('flat');
  });
});
