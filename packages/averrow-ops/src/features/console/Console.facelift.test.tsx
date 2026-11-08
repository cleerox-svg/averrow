// Phase 6 screen 3a: Console chrome. Sentence-case crumb, no looping "LIVE"
// ping, neutral KPI tile, and a real kit tablist with arrow-key navigation.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { Console } from './Console';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ isSuperAdmin: true, user: { role: 'super_admin' } }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/features/admin-incidents/Incidents', () => ({ AdminIncidents: () => <div>INCIDENTS PANE</div> }));
vi.mock('@/features/alerts/Alerts', () => ({ Alerts: () => <div>ALERTS PANE</div> }));
vi.mock('@/features/threats/Threats', () => ({ Threats: () => <div>THREATS PANE</div> }));
vi.mock('@/features/takedowns/Takedowns', () => ({ Takedowns: () => <div>TAKEDOWNS PANE</div> }));

import { api } from '@/lib/api';
const get = api.get as unknown as ReturnType<typeof vi.fn>;

beforeAll(() => stubMatchMedia(true));
beforeEach(() => {
  vi.clearAllMocks();
  window.history.pushState({}, '', '/');
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/alerts/triage-summary')) return { success: true, data: { new_count: 4, critical_count: 1 } };
    return { success: true, data: [] };
  });
});

describe('Console chrome', () => {
  it('renders a sentence-case crumb and no looping LIVE indicator', async () => {
    const { container } = renderWithProviders(<Console />);
    expect(await screen.findByText('SOC console')).toHaveClass('console-crumb');
    expect(container.querySelector('.console-live')).toBeNull();
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  });

  it('console.css no longer loops the Console chrome and holds no colour literals', () => {
    const css = readFileSync(resolve(__dirname, 'console.css'), 'utf8');
    // `.console-live` stays only for TabbedWorkspace (admin pages), not Console.
    expect(readFileSync(resolve(__dirname, 'Console.tsx'), 'utf8')).not.toMatch(/console-live|console-ping/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  it('the Open alerts tile is neutral, not amber', async () => {
    renderWithProviders(<Console />);
    const tile = (await screen.findByText('Open alerts')).closest('.ds-stat') as HTMLElement;
    expect(tile).not.toBeNull();
    expect(tile.getAttribute('style') ?? '').not.toContain('var(--amber)');
  });

  it('tabs are a tablist with aria-selected and arrow-key navigation', async () => {
    renderWithProviders(<Console />);
    const list = await screen.findByRole('tablist', { name: 'Console sections' });
    const tabs = screen.getAllByRole('tab');
    expect(list).toContainElement(tabs[0]!);
    expect(tabs.map(t => t.textContent)).toEqual(['Alerts', 'Threats', 'Incidents', 'Takedowns']);
    expect(screen.getByRole('tab', { name: 'Alerts' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Threats' })).toHaveAttribute('aria-selected', 'false');

    screen.getByRole('tab', { name: 'Alerts' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Threats' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(window.location.search).toBe('?tab=threats'));
    expect(await screen.findByText('THREATS PANE')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Threats' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Threats');
  });

  it('no tab points at a panel that is not rendered (no dangling aria-controls)', async () => {
    renderWithProviders(<Console />);
    await screen.findByRole('tablist', { name: 'Console sections' });
    for (const tab of screen.getAllByRole('tab')) expect(tab).not.toHaveAttribute('aria-controls');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('?tab= deep links select the matching tab', async () => {
    window.history.pushState({}, '', '/?tab=takedowns');
    renderWithProviders(<Console />);
    expect(await screen.findByRole('tab', { name: 'Takedowns', selected: true })).toBeInTheDocument();
  });
});
