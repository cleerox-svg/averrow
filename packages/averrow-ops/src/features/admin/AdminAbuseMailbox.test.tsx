import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { AdminAbuseMailbox } from './AdminAbuseMailbox';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ isSuperAdmin: true, loading: false }) }));

const refetch = vi.fn();
const idle = { data: undefined, isLoading: false, error: null };
vi.mock('@/hooks/useAdminAbuseMailbox', () => ({
  useAdminAbuseMailboxSummary: () => ({
    data: undefined, isLoading: false, error: new Error('SELF_ORG_NOT_PROVISIONED'), refetch,
  }),
  useAdminAbuseMailboxMessages: () => idle,
  useAdminAbuseMailboxMessageDetail: () => idle,
  useAdminAbuseMailboxIntel: () => idle,
  useUnthrottleAbuseMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateAbuseMessageStatus: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkUpdateAbuseMessageStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe('AdminAbuseMailbox summary failure', () => {
  it('uses the shared error state with retry and keeps the migration hint in a <details>', async () => {
    renderWithProviders(<AdminAbuseMailbox />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load abuse mailbox");
    expect(screen.getByRole('alert')).toHaveTextContent('SELF_ORG_NOT_PROVISIONED');

    const hint = screen.getByText(/run migration 0180/);
    expect(hint.closest('details')).not.toBeNull();
    expect(hint.closest('details')).not.toHaveAttribute('open');

    await userEvent.setup().click(screen.getByRole('button', { name: "Try again: Couldn't load abuse mailbox" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
