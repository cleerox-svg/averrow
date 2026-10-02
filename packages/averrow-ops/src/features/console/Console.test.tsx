// KPI error-state coverage for the ops SOC Console hero: a failed open-alerts
// query must show "Couldn't load" instead of a silent "—".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { Console } from './Console';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('react-countup', () => ({
  default: ({ end }: { end: number }) => <span>{end}</span>,
}));
vi.mock('@/features/console/views/ConsoleIncidents', () => ({ ConsoleIncidents: () => null }));
vi.mock('@/features/alerts/Alerts', () => ({ Alerts: () => null }));
vi.mock('@/features/threats/Threats', () => ({ Threats: () => null }));
vi.mock('@/features/takedowns/Takedowns', () => ({ Takedowns: () => null }));

import { api } from '@/lib/api';

const get = api.get as unknown as ReturnType<typeof vi.fn>;

function route(opts: { alerts: 'ok' | 'fail' | 'json500'; incidents: 'ok' | 'fail' | 'json500' }) {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/alerts/triage-summary')) {
      if (opts.alerts === 'fail') throw new Error('alerts down');
      if (opts.alerts === 'json500') return { success: false, error: 'internal' };
      return { success: true, data: { new_count: 42, critical_count: 1 } };
    }
    if (url.startsWith('/api/admin/incidents')) {
      if (opts.incidents === 'fail') throw new Error('incidents down');
      if (opts.incidents === 'json500') return { success: false, error: 'internal' };
      return { success: true, data: [{ id: 'a', severity: 'critical' }, { id: 'b', severity: 'low' }] };
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe('Console — KPI tile error states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags only the open-alerts tile when the alerts query fails', async () => {
    route({ alerts: 'fail', incidents: 'ok' });
    renderWithProviders(<Console />);

    await waitFor(() => expect(screen.getAllByText("Couldn't load")).toHaveLength(1));
    expect(screen.queryByText('awaiting triage')).not.toBeInTheDocument();
    expect(screen.getByText('need eyes now')).toBeInTheDocument();
  });

  it('flags every tile when both queries fail', async () => {
    route({ alerts: 'fail', incidents: 'fail' });
    renderWithProviders(<Console />);

    await waitFor(() => expect(screen.getAllByText("Couldn't load")).toHaveLength(3));
  });

  it('flags every tile on JSON { success:false } 500s', async () => {
    route({ alerts: 'json500', incidents: 'json500' });
    renderWithProviders(<Console />);

    await waitFor(() => expect(screen.getAllByText("Couldn't load")).toHaveLength(3));
  });

  it('renders numbers and no error text on success', async () => {
    route({ alerts: 'ok', incidents: 'ok' });
    renderWithProviders(<Console />);

    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument());
    expect(screen.queryByText("Couldn't load")).not.toBeInTheDocument();
    expect(screen.getByText('awaiting triage')).toBeInTheDocument();
  });
});
