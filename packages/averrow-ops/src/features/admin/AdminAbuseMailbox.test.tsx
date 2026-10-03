import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { AdminAbuseMailbox, DeterminationPanel, DeterminationBadge } from './AdminAbuseMailbox';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ isSuperAdmin: true, loading: false }) }));

const refetch = vi.fn();
const idle = { data: undefined, isLoading: false, isError: false, error: null };
const summaryFailed = {
  data: undefined, isLoading: false, error: new Error('SELF_ORG_NOT_PROVISIONED'), refetch,
};
const summaryOk = {
  data: {
    alias: null,
    totals: { total: 0 },
    unbound: { total: 0 },
  },
  isLoading: false, error: null, refetch,
};
const failed = (message: string) => ({
  data: undefined, isLoading: false, isError: true, error: new Error(message), refetch,
});
const state = {
  summary: summaryFailed as unknown,
  messages: idle as unknown,
  intel: idle as unknown,
};
vi.mock('@/hooks/useAdminAbuseMailbox', () => ({
  useAdminAbuseMailboxSummary: () => state.summary,
  useAdminAbuseMailboxMessages: () => state.messages,
  useAdminAbuseMailboxMessageDetail: () => idle,
  useAdminAbuseMailboxIntel: () => state.intel,
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

describe('AdminAbuseMailbox messages / intel failure', () => {
  beforeEach(() => {
    refetch.mockClear();
    state.summary = summaryOk;
    state.messages = idle;
    state.intel = idle;
  });

  it('shows an error with retry when messages fail, and never an empty "Inbox (0)"', async () => {
    state.messages = failed('boom 500');
    renderWithProviders(<AdminAbuseMailbox />);

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load messages");
    expect(screen.queryByText(/Inbox\s*\(0\)/i)).toBeNull();
    expect(screen.getByRole('heading', { name: /Inbox/i })).toHaveTextContent('(—)');

    await userEvent.setup().click(screen.getByRole('button', { name: "Try again: Couldn't load messages" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an error card with retry when intel fails', async () => {
    state.intel = failed('intel 500');
    renderWithProviders(<AdminAbuseMailbox />);

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load intel highlights");
    await userEvent.setup().click(screen.getByRole('button', { name: "Try again: Couldn't load intel highlights" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('DeterminationPanel', () => {
  const d = {
    label: 'Likely phishing',
    tone: 'threat' as const,
    lead: 'This message shows strong phishing indicators.',
    analyst_note: 'Reviewed automatically.',
    next_steps: ['Do not click links', 'Delete the message'],
    action_label: 'Reported to our threat team',
  };

  it('renders verdict, note, next steps, action and sent time', () => {
    renderWithProviders(<DeterminationPanel determination={d} sentAt="2026-10-01 10:00:00" />);
    expect(screen.getByText('Likely phishing')).toBeInTheDocument();
    expect(screen.getByText(d.lead)).toBeInTheDocument();
    expect(screen.getByText('Analyst note')).toBeInTheDocument();
    expect(screen.getByText('Do not click links')).toBeInTheDocument();
    expect(screen.getByText('Reported to our threat team')).toBeInTheDocument();
    expect(screen.getByText(/2026-10-01 10:00:00/)).toBeInTheDocument();
  });

  it('shows "Not sent yet" when no sent timestamp', () => {
    renderWithProviders(<DeterminationPanel determination={d} sentAt={null} />);
    expect(screen.getByText(/Not sent yet/)).toBeInTheDocument();
  });

  it('shows pending state when determination is null or missing', () => {
    renderWithProviders(<DeterminationPanel determination={null} sentAt={null} />);
    expect(screen.getByText(/Pending — no determination yet/)).toBeInTheDocument();
  });

  it('badge tolerates an unknown tone', () => {
    renderWithProviders(<DeterminationBadge determination={{ ...d, tone: 'bogus' as never }} />);
    expect(screen.getByTestId('determination-badge')).toHaveTextContent('Likely phishing');
  });
});
