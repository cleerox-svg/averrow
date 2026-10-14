import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ArcData } from '@/hooks/useObservatory';
import type { ProviderGeo } from '@/hooks/useObservatoryLenses';

vi.mock('@/hooks/useObservatoryLenses', async orig => ({
  ...(await orig<typeof import('@/hooks/useObservatoryLenses')>()),
  useActorDetail: () => ({ data: undefined, error: null, isLoading: true, refetch: vi.fn() }),
}));

import { DrillDrawer, shouldHandleEscape } from './DrillDrawer';

const arc: ArcData = {
  sourcePosition: [10, 20], targetPosition: [-100, 40], threat_type: 'credential_harvesting', severity: 'critical',
  source_region: 'NL', target_brand: 'b', brand_name: 'PayPal', volume: 7, target_precision: 'country',
};
const prov: ProviderGeo = {
  id: 'p1', name: 'Host', asn: 'AS1', country: 'NL', active_threat_count: 5, total_threat_count: 9, trend_7d: 1, trend_30d: 2,
  is_bulletproof: true, reputation_score: null, takedown: { share: 0.62, median_hours: 31, n: 141 },
};
const mount = (target: React.ComponentProps<typeof DrillDrawer>['target'], extra: Partial<React.ComponentProps<typeof DrillDrawer>> = {}) => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const view = render(
    <MemoryRouter><div data-testid="map-root"><DrillDrawer target={target} data={{}} onClose={onClose} onSelect={onSelect} variant="dock" {...extra} /></div></MemoryRouter>,
  );
  return { onClose, onSelect, ...view };
};

describe('DrillDrawer', () => {
  it('shows arc details incl. the approximate-target note and theme-aware severity text', () => {
    mount({ kind: 'arc', arc });
    expect(screen.getByText('credential harvesting')).toBeInTheDocument();
    expect(screen.getByText('PayPal')).toBeInTheDocument();
    expect(screen.getByText(/approximate/i)).toBeInTheDocument();
    expect(screen.getByText('critical').style.color).toBe('var(--sev-critical-text)');
  });

  it('related objects re-target the drawer', async () => {
    const { onSelect } = mount({ kind: 'arc', arc });
    await userEvent.click(screen.getByRole('button', { name: 'Open Netherlands' }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'country', code: 'NL' });
  });

  it('closes on Escape and via an accessible close button', async () => {
    const { onClose } = mount({ kind: 'country', code: 'DE' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus in on open and restores it to the opener on close (also under StrictMode)', () => {
    const outer = document.createElement('button');
    document.body.appendChild(outer);
    outer.focus();
    const { unmount } = render(
      <React.StrictMode><MemoryRouter><DrillDrawer target={{ kind: 'country', code: 'DE' }} data={{}} onClose={vi.fn()} onSelect={vi.fn()} variant="dock" /></MemoryRouter></React.StrictMode>,
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
    unmount();
    expect(outer).toHaveFocus();
    outer.remove();
  });

  it('a pending lens object shows a loading state, not an error', () => {
    mount({ kind: 'operation', id: 'x', op: null });
    expect(screen.getByText(/Loading operation/)).toBeInTheDocument();
  });

  it('an actor still loading is a status, and the sheet variant has no dialog role of its own', () => {
    mount({ kind: 'actor', id: 'a', name: 'APT' }, { variant: 'sheet' });
    expect(screen.getByText('Loading actor…')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('takedown outcomes need manage_takedowns', () => {
    it('holders see the success share and median time', () => {
      mount({ kind: 'provider', id: 'p1', provider: prov }, { canSeeTakedowns: true });
      expect(screen.getByRole('img', { name: 'Taken down: 62%' })).toBeInTheDocument();
      expect(screen.getByText('31h')).toBeInTheDocument();
    });
    it('other roles see a neutral note: no numbers, no error, no "none recorded" claim', () => {
      mount({ kind: 'provider', id: 'p1', provider: { ...prov, takedown: null } }, { canSeeTakedowns: false });
      expect(screen.getByText(/roles that manage takedowns/)).toBeInTheDocument();
      expect(screen.queryByText(/No resolved takedowns/)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    it('a holder with no takedown data is told there are none recorded', () => {
      mount({ kind: 'provider', id: 'p1', provider: { ...prov, takedown: null } }, { canSeeTakedowns: true });
      expect(screen.getByText(/No resolved takedowns recorded/)).toBeInTheDocument();
    });
  });
});

describe('shouldHandleEscape scoping', () => {
  it('ignores handled Escapes, other dialogs and unrelated controls; accepts the map area and the drawer', () => {
    const map = document.createElement('div');
    const drawer = document.createElement('div');
    const inside = document.createElement('button');
    drawer.appendChild(inside);
    map.appendChild(drawer);
    const outer = document.createElement('button');
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    const field = document.createElement('input');
    other.appendChild(field);
    document.body.append(map, outer, other);
    const k = (target: Element | null, over: Partial<KeyboardEvent> = {}) => shouldHandleEscape({ key: 'Escape', defaultPrevented: false, target, ...over } as unknown as KeyboardEvent, drawer);
    expect(k(inside)).toBe(true);
    expect(k(map)).toBe(true);
    expect(k(document.body)).toBe(true);
    expect(k(outer)).toBe(false);
    expect(k(field)).toBe(false);
    expect(k(inside, { defaultPrevented: true })).toBe(false);
    expect(shouldHandleEscape({ key: 'Enter', defaultPrevented: false, target: inside } as unknown as KeyboardEvent, drawer)).toBe(false);
    map.remove(); outer.remove(); other.remove();
  });
});
