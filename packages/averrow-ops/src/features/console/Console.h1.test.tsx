// The Console owns the view's single <h1>; the pane mounted under the active
// tab renders its PageHeader embedded (no second h1), for every tab.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { PageHeader } from '@/design-system/components';
import { Console } from './Console';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ isSuperAdmin: true, user: { role: 'super_admin' } }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => ({ success: true, data: [] })) } }));
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const pane = (name: string) => () => (
  <PageHeader title={`${name} pane`} subtitle={`${name} sub`} actions={<button type="button">{name} action</button>} />
);
vi.mock('@/features/alerts/Alerts', () => ({ Alerts: pane('Alerts') }));
vi.mock('@/features/threats/Threats', () => ({ Threats: pane('Threats') }));
vi.mock('@/features/admin-incidents/Incidents', () => ({ AdminIncidents: pane('Incidents') }));
vi.mock('@/features/takedowns/Takedowns', () => ({ Takedowns: pane('Takedowns') }));

describe('Console — one h1 per tab', () => {
  it.each(['Alerts', 'Threats', 'Incidents', 'Takedowns'])('%s tab renders exactly one h1 and keeps the pane actions', async (name) => {
    renderWithProviders(<Console />);
    if (name !== 'Alerts') await userEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
    expect(await screen.findByRole('button', { name: `${name} action` })).toBeInTheDocument();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Console');
    expect(screen.queryByText(`${name} sub`)).not.toBeInTheDocument();
  });
});
