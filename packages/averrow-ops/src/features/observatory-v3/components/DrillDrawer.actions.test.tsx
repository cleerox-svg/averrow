import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ThreatPoint } from '@/hooks/useObservatory';

vi.mock('@/hooks/useObservatoryLenses', async orig => ({
  ...(await orig<typeof import('@/hooks/useObservatoryLenses')>()),
  useActorDetail: () => ({ data: undefined, error: null, isLoading: true, refetch: vi.fn() }),
}));

import { DrillDrawer, threatsCountry, threatsHref, copyCurrentLink } from './DrillDrawer';

const node: ThreatPoint = { lat: 52, lng: 5, threat_count: 9, top_severity: 'high', critical: 0, high: 9, medium: 0, low: 0, country_code: 'NL', top_threat_type: 'phishing' };

function mount(target: React.ComponentProps<typeof DrillDrawer>['target'], extra: Partial<React.ComponentProps<typeof DrillDrawer>> = {}) {
  return render(
    <MemoryRouter><div><DrillDrawer target={target} data={{}} onClose={vi.fn()} onSelect={vi.fn()} variant="dock" {...extra} /></div></MemoryRouter>,
  );
}

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('DrillDrawer: Copy link', () => {
  it('copies the current URL and says so (button text and an aria-live message)', async () => {
    mount({ kind: 'node', node });
    await userEvent.click(screen.getByRole('button', { name: /copy link/i }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(await screen.findByRole('button', { name: /link copied/i })).toBeInTheDocument();
    expect(screen.getAllByRole('status').some(el => /copied to the clipboard/i.test(el.textContent ?? ''))).toBe(true);
  });

  it('is there for every kind of target', () => {
    mount({ kind: 'country', code: 'NL' });
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
  });

  it('says so when the clipboard refuses', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    mount({ kind: 'country', code: 'NL' });
    await userEvent.click(screen.getByRole('button', { name: /copy link/i }));
    expect(await screen.findByText(/copy failed/i)).toBeInTheDocument();
    expect(screen.getAllByRole('status').some(el => /could not copy/i.test(el.textContent ?? ''))).toBe(true);
  });

  it('copyCurrentLink: false without a clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    expect(await copyCurrentLink()).toBe(false);
  });
});

describe('DrillDrawer: Open in Threats', () => {
  it('node and country targets link to the Threats list for their country', () => {
    const { unmount } = mount({ kind: 'country', code: 'NL' });
    const link = screen.getByRole('link', { name: /open in threats/i });
    expect(link.getAttribute('href')).toBe(threatsHref('NL'));
    expect(threatsHref('NL')).toBe('/console?tab=threats&country=NL');
    unmount();
    mount({ kind: 'node', node });
    expect(screen.getByRole('link', { name: /open in threats/i }).getAttribute('href')).toBe('/console?tab=threats&country=NL');
  });

  it('carries the active brand filter as brand_id', () => {
    expect(threatsHref('NL', 'b_1')).toBe('/console?tab=threats&country=NL&brand_id=b_1');
    expect(threatsHref('NL', null)).toBe('/console?tab=threats&country=NL');
    mount({ kind: 'country', code: 'NL' }, { brandId: 'b_1' });
    expect(screen.getByRole('link', { name: /open in threats/i }).getAttribute('href')).toBe('/console?tab=threats&country=NL&brand_id=b_1');
  });

  it('a node with no country, and the other kinds, have no such link', () => {
    mount({ kind: 'node', node: { ...node, country_code: null } });
    expect(screen.queryByRole('link', { name: /open in threats/i })).toBeNull();
    expect(threatsCountry({ kind: 'provider', id: 'p', provider: null })).toBeNull();
    expect(threatsCountry({ kind: 'node', node })).toBe('NL');
  });
});

describe('DrillDrawer: vs prior period (optional trend)', () => {
  it('renders nothing without a trend', () => {
    mount({ kind: 'country', code: 'NL' });
    expect(screen.queryByText(/vs prior period/i)).toBeNull();
  });
  it('renders ▲ / ▼ and "new" from the trend prop', () => {
    const { unmount } = mount({ kind: 'country', code: 'NL' }, { trend: { current: 120, prior: 100, delta_pct: 20 } });
    expect(screen.getByText(/vs prior period/i).parentElement).toHaveTextContent('▲ 20%');
    unmount();
    const second = mount({ kind: 'country', code: 'NL' }, { trend: { current: 7, prior: 0, delta_pct: null } });
    expect(screen.getByText(/vs prior period/i).parentElement).toHaveTextContent('new');
    second.unmount();
    mount({ kind: 'country', code: 'NL' }, { trend: { current: 0, prior: 0, delta_pct: null } });
    expect(screen.queryByText(/vs prior period/i)).toBeNull();
  });
});

void waitFor;
