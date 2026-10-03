import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { Notifications } from './NotificationsInbox';
import type { Notification } from '@/lib/notifications';

// Proof-site coverage for the shared PageState kit: a failed query with no
// data must show the error state, never the "Inbox zero." empty state.

vi.mock('@/lib/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notifications')>();
  return { ...actual, useTenantNotifications: vi.fn() };
});

import { useTenantNotifications } from '@/lib/notifications';

const mockQuery = (q: Record<string, unknown>) =>
  vi.mocked(useTenantNotifications).mockReturnValue({
    data: undefined, isLoading: false, error: null, refetch: vi.fn(), ...q,
  } as never);

const note = (o: Partial<Notification> = {}): Notification => ({
  id: 'n1', user_id: 'u1', type: 'alert_digest', severity: 'high',
  title: 'Digest ready', message: '3 new alerts', link: null,
  recommended_action: null, state: 'unread', group_key: null,
  snoozed_until: null, created_at: new Date().toISOString(), ...o,
});

describe('Tenant Notifications inbox states', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an error state (not empty) when the query fails with no data', () => {
    mockQuery({ error: new Error('boom') });
    renderWithProviders(<Notifications />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load notifications");
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByText('Inbox zero.')).not.toBeInTheDocument();
    expect(screen.queryByText('No notifications waiting for you.')).not.toBeInTheDocument();
  });

  it('retries via the Try again button', async () => {
    const refetch = vi.fn();
    mockQuery({ error: new Error('boom'), refetch });
    renderWithProviders(<Notifications />);
    await userEvent.setup().click(screen.getByRole('button', { name: /^Try again/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when the query succeeds with no items', () => {
    mockQuery({ data: { notifications: [], unread_count: 0 } });
    renderWithProviders(<Notifications />);
    expect(screen.getByRole('status')).toHaveTextContent('Inbox zero.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load notifications")).not.toBeInTheDocument();
  });

  it('shows a loading state while loading', () => {
    mockQuery({ isLoading: true });
    renderWithProviders(<Notifications />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Inbox zero.')).not.toBeInTheDocument();
  });

  it('keeps the stale list AND surfaces an inline error with retry when a background refetch fails', async () => {
    const refetch = vi.fn();
    mockQuery({ data: { notifications: [note()], unread_count: 1 }, error: new Error('refetch failed'), refetch });
    renderWithProviders(<Notifications />);
    expect(screen.getByText('Digest ready')).toBeInTheDocument();
    // Stale-data banner is polite (role=status), not an assertive alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const alert = screen.getByRole('status');
    expect(alert).toHaveTextContent('refetch failed');
    // Error sits above the stale list.
    expect(alert.compareDocumentPosition(screen.getByText('Digest ready')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: /^Try again/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows no error banner when data is present and there is no error', () => {
    mockQuery({ data: { notifications: [note()], unread_count: 1 } });
    renderWithProviders(<Notifications />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders rows and neither empty nor error state when there is data', () => {
    mockQuery({ data: { notifications: [note(), note({ id: 'n2', title: 'Second' })], unread_count: 2 } });
    renderWithProviders(<Notifications />);
    expect(screen.getByText('Digest ready')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('Inbox zero.')).not.toBeInTheDocument();
  });
});
