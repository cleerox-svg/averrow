import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { noLayers, lensPreset } from './lenses';
import {
  parseSel, selValue,
  parseObservatoryParams, applyObservatoryState, mergeObservatoryState, DEFAULT_STATE, mapModeOf,
  nodeKey, arcKey, useObservatoryUrlState,
} from './url-state';

const parse = (qs: string) => parseObservatoryParams(new URLSearchParams(qs));

describe('parseObservatoryParams', () => {
  it('returns defaults for an empty query', () => {
    expect(parse('')).toEqual(DEFAULT_STATE);
  });

  it('reads valid params', () => {
    const s = parse('period=30d&source=feeds&view=heat&colorBy=type&layers=nodes,beams');
    expect(s).toMatchObject({ period: '30d', source: 'feeds', lens: 'threats', view: 'heat', colorBy: 'type' });
    expect(mapModeOf(s)).toBe('heatmap');
    expect(s.layers).toEqual({ ...noLayers(), nodes: true, beams: true });
  });

  it('falls back to defaults for invalid values', () => {
    const s = parse('period=1y&source=evil&mode=globe&colorBy=rainbow&layers=garbage');
    expect(s).toEqual(DEFAULT_STATE);
  });

  it('layers=none turns every layer off', () => {
    expect(parse('layers=none').layers).toEqual(noLayers());
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

describe('lens, sel and measure params', () => {
  it('reads a lens and defaults its layers to the lens preset', () => {
    const s = parse('lens=hosting');
    expect(s.lens).toBe('hosting');
    expect(s.layers).toEqual(lensPreset('hosting'));
    expect(s.layers.nodes).toBe(false);
  });
  it('explicit layers override the preset; unknown lens falls back to threats', () => {
    expect(parse('lens=operations&layers=nodes,operations').layers).toMatchObject({ nodes: true, operations: true, hosting: false });
    expect(parse('lens=nope').lens).toBe('threats');
  });
  it('an old mode= link wins over lens= and names a lens + option', () => {
    expect(parse('mode=heatmap&lens=hosting')).toMatchObject({ lens: 'threats', view: 'heat' });
  });
  it('validates sel (kind, country code shape) and keeps it global-only', () => {
    expect(parse('sel=country:US').sel).toBe('country:US');
    expect(parse('sel=country:usa').sel).toBeNull();
    expect(parse('sel=op:abc-123').sel).toBe('op:abc-123');
    expect(parse('sel=weird:1').sel).toBeNull();
    expect(parse('mode=heatmap&sel=country:US').sel).toBeNull();
  });
  it('node and arc outrank sel', () => {
    expect(parse('node=1.00,2.00&sel=country:US')).toMatchObject({ node: '1.00,2.00', sel: null });
    expect(parse('arc=a|b|1.0,2.0|low&sel=country:US')).toMatchObject({ arc: 'a|b|1.0,2.0|low', sel: null });
  });
  it('parseSel / selValue round-trip and reject junk', () => {
    expect(parseSel(selValue('provider', 'p/1'))).toEqual({ kind: 'provider', id: 'p/1' });
    expect(parseSel('')).toBeNull();
    expect(parseSel('op:' + 'x'.repeat(200))).toBeNull();
  });
  it('round-trips a lens view and writes only non-defaults', () => {
    const state = parse('lens=baseline&measure=raw&period=30d&sel=country:DE');
    const out = applyObservatoryState(new URLSearchParams(), state);
    expect(out.get('lens')).toBe('baseline');
    expect(out.has('layers')).toBe(false); // equals the lens preset
    expect(out.get('measure')).toBe('raw');
    expect(parseObservatoryParams(out)).toEqual(state);
  });
  it('writes layers when they differ from the lens preset', () => {
    const out = applyObservatoryState(new URLSearchParams(), parse('lens=operations&layers=nodes,operations'));
    expect(out.get('layers')).toBe('nodes,operations');
  });
  it('threats-lens URLs stay backward compatible (no lens param, old layers syntax)', () => {
    const out = applyObservatoryState(new URLSearchParams(), parse('layers=nodes,beams&node=40.71,-74.01'));
    expect(out.toString()).toBe('layers=nodes%2Cbeams&node=40.71%2C-74.01');
  });
});

describe('lens options and legacy mode links', () => {
  it('mode=heatmap is the Threats lens with the Heat view', () => {
    const s = parse('mode=heatmap&period=30d');
    expect(s).toMatchObject({ lens: 'threats', view: 'heat', measure: 'index' });
    expect(mapModeOf(s)).toBe('heatmap');
  });
  it('mode=bot_density is the Baseline lens with the Bot share measure and its layer preset', () => {
    const s = parse('mode=bot_density');
    expect(s).toMatchObject({ lens: 'baseline', view: 'points', measure: 'bot' });
    expect(s.layers).toEqual(lensPreset('baseline'));
    expect(mapModeOf(s)).toBe('bot_density');
  });
  it('mode=global is a no-op', () => {
    expect(parse('mode=global&lens=hosting').lens).toBe('hosting');
  });
  it('view only exists on Threats and measure only on Baseline', () => {
    expect(parse('lens=hosting&view=heat').view).toBe('points');
    expect(parse('lens=hosting&measure=bot').measure).toBe('index');
    expect(parse('lens=baseline&measure=bot').measure).toBe('bot');
    expect(parse('lens=baseline&measure=nope').measure).toBe('index');
  });
  it('writes the canonical option params (never mode=) and round-trips', () => {
    const heat = applyObservatoryState(new URLSearchParams('mode=heatmap'), parse('mode=heatmap'));
    expect(heat.toString()).toBe('view=heat');
    expect(parseObservatoryParams(heat)).toEqual(parse('mode=heatmap'));
    const bot = applyObservatoryState(new URLSearchParams(), parse('mode=bot_density'));
    expect(bot.toString()).toBe('lens=baseline&measure=bot');
    expect(parseObservatoryParams(bot)).toEqual(parse('mode=bot_density'));
  });
  it('selection is dropped on the heat and bot-share scenes', () => {
    expect(parse('view=heat&sel=country:US').sel).toBeNull();
    expect(parse('lens=baseline&measure=bot&sel=country:US').sel).toBeNull();
    expect(parse('lens=baseline&measure=raw&sel=country:US').sel).toBe('country:US');
  });
});

describe('applyObservatoryState', () => {
  it('writes only non-default values and round-trips', () => {
    const state = parse('period=90d&source=spam_trap&colorBy=type&layers=nodes&arc=a|b|1.0,2.0|low');
    const out = applyObservatoryState(new URLSearchParams(), state);
    expect(out.get('period')).toBe('90d');
    expect(out.has('mode')).toBe(false);
    expect(out.has('view')).toBe(false);
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
    expect(mergeObservatoryState(selected, { view: 'heat' }).node).toBeNull();
    expect(mergeObservatoryState(selected, { mode: 'heatmap' }).node).toBeNull();
  });

  it('keeps the selection for unrelated changes and no-op period sets', () => {
    expect(mergeObservatoryState(selected, { colorBy: 'type' }).node).toBe('1.00,2.00');
    expect(mergeObservatoryState(selected, { period: '7d' }).node).toBe('1.00,2.00');
    expect(mergeObservatoryState(selected, { layers: { beams: true } }).layers.beams).toBe(true);
  });

  it('choosing a lens resets the layers to its preset and clears the selection', () => {
    const base = { ...DEFAULT_STATE, sel: 'country:US', layers: { ...DEFAULT_STATE.layers, beams: true } };
    const next = mergeObservatoryState(base, { lens: 'hosting' });
    expect(next.layers).toEqual(lensPreset('hosting'));
    expect(next.sel).toBeNull();
    // ...unless the same patch says otherwise.
    expect(mergeObservatoryState(base, { lens: 'hosting', layers: { nodes: true }, sel: 'provider:p1' })).toMatchObject({
      sel: 'provider:p1', layers: { nodes: true, hosting: false },
    });
  });

  it('choosing a lens resets the previous lens option; an option only exists on its lens', () => {
    const heat = { ...DEFAULT_STATE, view: 'heat' as const };
    expect(mergeObservatoryState(heat, { lens: 'actors' })).toMatchObject({ lens: 'actors', view: 'points' });
    const bot = { ...DEFAULT_STATE, lens: 'baseline' as const, measure: 'bot' as const, layers: lensPreset('baseline') };
    expect(mergeObservatoryState(bot, { lens: 'threats' })).toMatchObject({ lens: 'threats', measure: 'index' });
    expect(mergeObservatoryState(DEFAULT_STATE, { lens: 'hosting', view: 'heat' }).view).toBe('points');
    expect(mergeObservatoryState(DEFAULT_STATE, { lens: 'baseline', measure: 'raw' })).toMatchObject({ lens: 'baseline', measure: 'raw' });
  });
  it('the legacy mode shorthand maps to lens + option; heat and bot-share scenes drop the selection', () => {
    expect(mergeObservatoryState(DEFAULT_STATE, { mode: 'bot_density' })).toMatchObject({ lens: 'baseline', measure: 'bot' });
    expect(mergeObservatoryState(DEFAULT_STATE, { mode: 'heatmap' })).toMatchObject({ lens: 'threats', view: 'heat' });
    expect(mergeObservatoryState({ ...DEFAULT_STATE, view: 'heat' }, { mode: 'global' })).toMatchObject({ lens: 'threats', view: 'points' });
    expect(mergeObservatoryState({ ...DEFAULT_STATE, sel: 'country:US' }, { view: 'heat', sel: 'country:DE' }).sel).toBeNull();
  });

  it('selecting one kind of object clears the others', () => {
    const withSel = { ...DEFAULT_STATE, sel: 'country:US' };
    expect(mergeObservatoryState(withSel, { node: '1.00,2.00' })).toMatchObject({ node: '1.00,2.00', sel: null });
    expect(mergeObservatoryState(selected, { sel: 'op:x' })).toMatchObject({ node: null, sel: 'op:x' });
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
    expect(loc.search).toBe('?view=heat');
  });
});
