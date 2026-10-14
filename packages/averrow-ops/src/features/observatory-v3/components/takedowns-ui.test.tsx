import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ProviderGeo, TakedownGeoRow } from '@/hooks/useObservatoryLenses';

vi.mock('@/hooks/useObservatoryLenses', async orig => ({
  ...(await orig<typeof import('@/hooks/useObservatoryLenses')>()),
  useActorDetail: () => ({ data: undefined, error: null, isLoading: true, refetch: vi.fn() }),
}));

import { ControlRail, type ControlRailProps } from './ControlRail';
import { DrillDrawer } from './DrillDrawer';
import { TakedownCountrySection, TakedownProviderSection } from './LensLegend';
import { lensPreset } from '../lib/lenses';
import { buildHostingModel } from '../lib/lens/hosting';
import { buildTakedownCountryModel, buildTakedownProviderModel, TAKEDOWN_MIN_RESOLVED } from '../lib/lens/takedowns';

const railProps = (over: Partial<ControlRailProps> = {}): ControlRailProps => ({
  lens: 'baseline', layers: lensPreset('baseline'), view: 'points', measure: 'index', colorBy: 'severity', reducedMotion: false,
  onLayers: vi.fn(), onView: vi.fn(), onMeasure: vi.fn(), onColorBy: vi.fn(), ...over,
});

describe('ControlRail: Takedowns measures need manage_takedowns', () => {
  it('Baseline: holders get a fourth measure; everyone else keeps the three they had', async () => {
    const onMeasure = vi.fn();
    const { unmount } = render(<ControlRail {...railProps({ canSeeTakedowns: true, onMeasure })} />);
    const group = screen.getByRole('group', { name: 'Baseline measure' });
    expect(within(group).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Over-index', 'Raw', 'Bot share', 'Takedowns']);
    await userEvent.click(within(group).getByRole('button', { name: 'Takedowns' }));
    expect(onMeasure).toHaveBeenCalledWith('takedowns');
    expect(screen.getByRole('status')).toHaveTextContent('Baseline: takedown outcomes');
    unmount();
    render(<ControlRail {...railProps({ canSeeTakedowns: false })} />);
    expect(screen.queryByRole('button', { name: 'Takedowns' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Baseline measure' })).getAllByRole('button')).toHaveLength(3);
  });
  it('Hosting: holders choose Active threats | Takedowns; for everyone else the lens has no measure control at all', async () => {
    const onMeasure = vi.fn();
    const { unmount } = render(<ControlRail {...railProps({ lens: 'hosting', layers: lensPreset('hosting'), canSeeTakedowns: true, onMeasure })} />);
    const group = screen.getByRole('group', { name: 'Hosting measure' });
    expect(within(group).getByRole('button', { name: 'Active threats' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(group).getByRole('button', { name: 'Takedowns' }));
    expect(onMeasure).toHaveBeenLastCalledWith('takedowns');
    await userEvent.click(within(group).getByRole('button', { name: 'Active threats' }));
    expect(onMeasure).toHaveBeenLastCalledWith('index');
    unmount();
    render(<ControlRail {...railProps({ lens: 'hosting', layers: lensPreset('hosting'), canSeeTakedowns: false })} />);
    expect(screen.queryByRole('group', { name: 'Hosting measure' })).not.toBeInTheDocument();
  });
  it('the pressed state follows the measure on both lenses', () => {
    render(<ControlRail {...railProps({ lens: 'hosting', layers: lensPreset('hosting'), canSeeTakedowns: true, measure: 'takedowns' })} />);
    expect(screen.getByRole('button', { name: 'Takedowns' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Active threats' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('phone panel layout labels the four baseline measures, in two columns so no label is squeezed', () => {
    render(<ControlRail {...railProps({ canSeeTakedowns: true, layout: 'panel' })} />);
    expect(screen.getByRole('button', { name: 'Takedowns' })).toHaveTextContent('Takedowns');
    expect(screen.getByRole('group', { name: 'Baseline measure' }).className).toContain('grid-cols-2');
  });
  it('three measures keep the single row', () => {
    render(<ControlRail {...railProps({ canSeeTakedowns: false, layout: 'panel' })} />);
    expect(screen.getByRole('group', { name: 'Baseline measure' }).className).not.toContain('grid-cols-2');
  });
});

const trow = (key: string, td: number, refused: number, expired = 0, over: Partial<TakedownGeoRow> = {}): TakedownGeoRow => {
  const resolved = td + refused + expired;
  return { key, label: `Label ${key}`, country: 'NL', lat: 1, lng: 2, submitted: resolved + 2, taken_down: td, refused, expired, pending: 2, share: resolved ? td / resolved : null, median_hours: 30, ...over };
};
const q = { isLoading: false, error: null, refetch: vi.fn() };
const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('takedown legend sections', () => {
  it('country: scale, the grey threshold, the window, counts and unmappable takedowns', () => {
    const model = buildTakedownCountryModel([trow('US', 30, 10), trow('DE', 1, 1), trow('unknown', 4, 4)]);
    wrap(<TakedownCountrySection s={{ model, q }} window="30d" />);
    expect(screen.getByRole('img', { name: /Colour scale: dark green/ })).toBeInTheDocument();
    expect(screen.getByText(`Grey: fewer than ${TAKEDOWN_MIN_RESOLVED} resolved takedowns, too few for a rate (countries left out of the ranking)`)).toBeInTheDocument();
    expect(screen.getByText(/last 30d \(whole UTC days\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 country with a rate, 1 too small/)).toBeInTheDocument();
    expect(screen.getByText(/10 takedowns have no known country/)).toBeInTheDocument();
  });
  it('country: empty / loading / error', () => {
    wrap(<TakedownCountrySection s={{ model: buildTakedownCountryModel([]), q }} window="90d" />);
    expect(screen.getByRole('status')).toHaveTextContent('No takedowns were submitted in the last 90d.');
  });
  it('provider: the arc key, the window and the undrawn hosts', () => {
    const prov = (id: string): ProviderGeo => ({ id, name: id, asn: 'AS1', country: 'NL', active_threat_count: 5, total_threat_count: 5, trend_7d: 0, trend_30d: 0, is_bulletproof: false, reputation_score: null, takedown: null });
    const model = buildTakedownProviderModel(buildHostingModel([prov('a')]), [trow('a', 10, 10), trow('ghost', 1, 40)]);
    wrap(<TakedownProviderSection s={{ model, q }} window="90d" />);
    expect(screen.getByText(/Green arc: the same share/)).toBeInTheDocument();
    expect(screen.getByText(/Ring size = active threats/)).toBeInTheDocument();
    expect(screen.getByText(/last 90d/)).toBeInTheDocument();
    expect(screen.getByText(/1 more host has a takedown history but no active threats, and is listed in the panel only/)).toBeInTheDocument();
  });
  it('provider: loading and error states', () => {
    wrap(<TakedownProviderSection s={{ model: null, q: { ...q, isLoading: true } }} window="30d" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading takedown outcomes…');
  });
});

describe('DrillDrawer takedown sections', () => {
  const prov: ProviderGeo = {
    id: 'p1', name: 'Host', asn: 'AS1', country: 'NL', active_threat_count: 5, total_threat_count: 9, trend_7d: 1, trend_30d: 2,
    is_bulletproof: false, reputation_score: null, takedown: { share: 0.62, median_hours: 31, n: 141 },
  };
  const mount = (target: React.ComponentProps<typeof DrillDrawer>['target'], data: React.ComponentProps<typeof DrillDrawer>['data'], canSeeTakedowns: boolean) =>
    render(<MemoryRouter><div data-testid="map-root"><DrillDrawer target={target} data={data} onClose={vi.fn()} onSelect={vi.fn()} variant="dock" canSeeTakedowns={canSeeTakedowns} /></div></MemoryRouter>);

  describe('country', () => {
    const target = { kind: 'country' as const, code: 'NL' };
    it('shows the success rate, volume, pending and median for a holder', () => {
      mount(target, { takedownCountries: [trow('NL', 30, 10)], takedownWindow: '30d' }, true);
      expect(screen.getByRole('heading', { name: 'Takedowns · 30d' })).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Taken down: 75%' })).toBeInTheDocument();
      expect(screen.getByText('75% of resolved')).toBeInTheDocument();
      expect(screen.getByText('40 resolved')).toBeInTheDocument();
      expect(screen.getByText('Submitted').nextSibling).toHaveTextContent('42');
      expect(screen.getByText('Median time to take down').nextSibling).toHaveTextContent('30h');
    });
    it('a small sample is told why there is no rate (no bar)', () => {
      mount(target, { takedownCountries: [trow('NL', 1, 1)], takedownWindow: '30d' }, true);
      expect(screen.getByText(`Too few resolved takedowns for a rate (2 of ${TAKEDOWN_MIN_RESOLVED} needed).`)).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: /Taken down/ })).not.toBeInTheDocument();
    });
    it('a holder with no row for the country is told none were submitted', () => {
      mount(target, { takedownCountries: [trow('DE', 5, 5)], takedownWindow: '90d' }, true);
      expect(screen.getByText(/No takedowns were submitted for this country in this window/)).toBeInTheDocument();
    });
    it('loading and failed states are different', () => {
      const { unmount } = mount(target, {}, true);
      expect(screen.getByText('Loading takedown outcomes…')).toBeInTheDocument();
      unmount();
      mount(target, { takedownCountriesError: true }, true);
      expect(screen.getByText('Takedown outcomes failed to load.')).toBeInTheDocument();
    });
    it('other roles: a neutral note, never numbers, "none submitted", loading or an error', () => {
      mount(target, { takedownCountries: [trow('NL', 30, 10)], takedownCountriesError: true }, false);
      expect(screen.getByText(/roles that manage takedowns/)).toBeInTheDocument();
      expect(screen.queryByText(/75%/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Loading takedown|failed to load|No takedowns were submitted/)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('provider', () => {
    const target = { kind: 'provider' as const, id: 'p1', provider: prov };
    it('prefers the per-window takedowns-geo row (the same numbers as the map) and labels the window', () => {
      mount(target, { takedownProviders: [trow('p1', 8, 2)], takedownWindow: '30d' }, true);
      expect(screen.getByRole('heading', { name: 'Takedowns · 30d' })).toBeInTheDocument();
      expect(screen.getByText('80% of resolved')).toBeInTheDocument();
      expect(screen.queryByText('62% of resolved')).not.toBeInTheDocument();
    });
    it('falls back to the providers-geo field (90 days) when the measure is off or the host has no row', () => {
      const { unmount } = mount(target, {}, true);
      expect(screen.getByText('62% of resolved')).toBeInTheDocument();
      unmount();
      mount(target, { takedownProviders: [trow('other', 8, 2)], takedownWindow: '30d' }, true);
      expect(screen.getByText('62% of resolved')).toBeInTheDocument();
    });
    it('other roles never see the per-window row either', () => {
      mount(target, { takedownProviders: [trow('p1', 8, 2)], takedownWindow: '30d' }, false);
      expect(screen.getByText(/roles that manage takedowns/)).toBeInTheDocument();
      expect(screen.queryByText('80% of resolved')).not.toBeInTheDocument();
    });
  });
});
