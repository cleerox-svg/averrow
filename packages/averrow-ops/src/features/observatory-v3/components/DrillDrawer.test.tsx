import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
    expect(screen.getByRole('heading', { name: 'credential harvesting' })).toBeInTheDocument();
    expect(screen.getByText('PayPal')).toBeInTheDocument();
    expect(screen.getByText(/approximate/i)).toBeInTheDocument();
    expect(screen.getAllByText('critical').some(el => el.style.color === 'var(--sev-critical-text)')).toBe(true);
  });

  it('opens with a hero: two stat tiles, a status badge and one primary action', () => {
    mount({ kind: 'operation', id: 'x', op: { id: 'x', name: 'OP ONE', component_id: null, kind: 'cert_serial', status: 'active', confidence_score: 82, threat_count: 420, actor: null, countries: ['NL', 'DE'], asns: ['AS1'], last_seen: null, last_movement_pivot_at: null } });
    const hero = document.querySelector('[data-hero]') as HTMLElement;
    expect(hero.querySelectorAll('.ds-stat')).toHaveLength(2);
    expect(within(hero).getByText('Threats')).toBeInTheDocument();
    expect(within(hero).getByText('Confidence')).toBeInTheDocument();
    expect(within(hero).getByText('82%')).toBeInTheDocument();
    expect(within(hero).getByText('active')).toBeInTheDocument();
    const cta = within(hero).getByRole('link', { name: 'Open operation →' });
    expect(cta).toHaveAttribute('href', '/campaigns/x');
  });

  it('the eyebrow is not repeated as a section title', () => {
    mount({ kind: 'operation', id: 'x', op: { id: 'x', name: 'OP', component_id: null, kind: 'asn', status: 'active', confidence_score: 50, threat_count: 1, actor: null, countries: ['NL'], asns: [], last_seen: null, last_movement_pivot_at: null } });
    expect(screen.getAllByText('Operation')).toHaveLength(1); // the eyebrow only
    mount({ kind: 'provider', id: 'p1', provider: prov });
    expect(screen.queryAllByRole('heading', { level: 3, name: 'Provider' })).toHaveLength(0);
  });

  it('chips collapse behind "+N more" after six, and the button reveals the rest', async () => {
    const countries = ['NL', 'DE', 'FR', 'GB', 'US', 'JP', 'BR', 'IN'];
    mount({ kind: 'operation', id: 'x', op: { id: 'x', name: 'OP', component_id: null, kind: 'asn', status: 'active', confidence_score: 50, threat_count: 1, actor: null, countries, asns: [], last_seen: null, last_movement_pivot_at: null } });
    expect(screen.queryByText('Brazil')).not.toBeInTheDocument();
    expect(screen.queryByText('India')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(screen.getByText('Brazil')).toBeInTheDocument();
    expect(screen.getByText('India')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more/ })).not.toBeInTheDocument();
  });

  it('related objects re-target the drawer', async () => {
    const { onSelect } = mount({ kind: 'arc', arc });
    await userEvent.click(screen.getByRole('button', { name: 'Open Netherlands' }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'country', code: 'NL' });
  });

  it('closes on Escape and via a close button whose title says so (no "Esc to close" footer)', async () => {
    const { onClose } = mount({ kind: 'country', code: 'DE' });
    expect(screen.queryByText(/Esc to close/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close details' })).toHaveAttribute('title', 'Close (Esc)');
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

  it('when the opener is gone (a side-panel row that unmounted), focus goes to the stable fallback, not <body>', () => {
    const row = document.createElement('button');
    const toggle = document.createElement('button');
    document.body.append(row, toggle);
    row.focus();
    const { unmount } = render(
      <MemoryRouter><DrillDrawer target={{ kind: 'country', code: 'DE' }} data={{}} onClose={vi.fn()} onSelect={vi.fn()} variant="dock" fallbackFocus={() => toggle} /></MemoryRouter>,
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
    row.remove(); // the panel row is replaced by the drawer
    unmount();
    expect(toggle).toHaveFocus();
    toggle.remove();
  });

  it('opened from the search box: focus returns to the search control, which stays mounted', () => {
    const search = document.createElement('input');
    document.body.appendChild(search);
    search.focus();
    const { unmount } = render(
      <MemoryRouter><DrillDrawer target={{ kind: 'country', code: 'DE' }} data={{}} onClose={vi.fn()} onSelect={vi.fn()} variant="overlay" fallbackFocus={() => null} /></MemoryRouter>,
    );
    unmount();
    expect(search).toHaveFocus();
    search.remove();
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

  it('the dock and the tablet overlay animate in (instant under reduced motion)', () => {
    const { unmount } = mount({ kind: 'country', code: 'DE' });
    expect(screen.getByRole('dialog').className).toMatch(/animate-drawer-in/);
    expect(screen.getByRole('dialog').className).toMatch(/motion-reduce:animate-none/);
    unmount();
    mount({ kind: 'country', code: 'DE' }, { variant: 'overlay' });
    expect(screen.getByRole('dialog').className).toMatch(/rounded-xl/);
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
