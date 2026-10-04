// Bell triage row: copy matches Home / sidebar / Console ("N alerts awaiting
// triage") and the summary is only fetched/shown for roles holding edit_alerts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useAlertTriageSummary: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/hooks/useAlerts', () => ({ useAlertTriageSummary: mocks.useAlertTriageSummary }));
vi.mock('@/hooks/useWindowWidth', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useNotifications', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    OPS_AUDIENCE_FILTER: ['platform'],
    useUnreadCount: () => ({ data: 0 }),
    useNotifications: () => ({ data: { notifications: [], unread_count: 0 }, isLoading: false, isError: false }),
    useMarkRead: mutation,
    useMarkAllRead: mutation,
    useSnoozeNotification: mutation,
    useMarkDone: mutation,
  };
});

import { NotificationBell } from './NotificationBell';

function open(role: string, summary: { new_count: number; critical_count: number }) {
  mocks.useAuth.mockReturnValue({ user: { id: 'u1', role } });
  mocks.useAlertTriageSummary.mockReturnValue({ data: summary });
  render(<MemoryRouter><NotificationBell /></MemoryRouter>);
  return userEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
}

describe('NotificationBell triage row', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads "N alerts awaiting triage" (plural)', async () => {
    await open('analyst', { new_count: 7, critical_count: 2 });
    expect(await screen.findByText('7 alerts awaiting triage')).toBeInTheDocument();
    expect(screen.queryByText(/signals? need triage/)).not.toBeInTheDocument();
  });

  it('singularises for one alert', async () => {
    await open('analyst', { new_count: 1, critical_count: 0 });
    expect(await screen.findByText('1 alert awaiting triage')).toBeInTheDocument();
  });

  it.each(['super_admin', 'admin', 'analyst', 'support'])('%s fetches the summary', async (role) => {
    await open(role, { new_count: 3, critical_count: 0 });
    expect(mocks.useAlertTriageSummary).toHaveBeenCalledWith({ enabled: true });
    expect(await screen.findByText('3 alerts awaiting triage')).toBeInTheDocument();
  });

  it.each(['sales', 'billing', 'auditor'])('%s does not fetch or show the triage row', async (role) => {
    await open(role, { new_count: 3, critical_count: 1 });
    expect(mocks.useAlertTriageSummary).toHaveBeenCalledWith({ enabled: false });
    expect(mocks.useAlertTriageSummary).not.toHaveBeenCalledWith({ enabled: true });
    expect(screen.queryByText(/awaiting triage/)).not.toBeInTheDocument();
  });
});
