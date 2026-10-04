// Members — the worker masks an Averrow staff seat (e.g. the lead-conversion
// placeholder) as { user_id: null, email: null, user_name: "Averrow SOC",
// is_averrow: true }. The page must render it without crashing, offer no
// manage controls on it, and never list it as a transfer-ownership target.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/members', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/members')>();
  return {
    ...actual,
    useOrgMembers: vi.fn(),
    useOrgInvites: vi.fn(),
    useInviteMember: vi.fn(),
    useRevokeInvite: vi.fn(),
    useResendInvite: vi.fn(),
    useRemoveMember: vi.fn(),
    useUpdateMemberRole: vi.fn(),
    useTransferOwnership: vi.fn(),
  };
});

import { useAuth } from '@/lib/auth';
import {
  useOrgMembers, useOrgInvites, useInviteMember, useRevokeInvite, useResendInvite,
  useRemoveMember, useUpdateMemberRole, useTransferOwnership, type OrgMember,
} from '@/lib/members';
import { Members } from './Members';

const mutationStub = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null };

function member(overrides: Partial<OrgMember>): OrgMember {
  return {
    id: 'm', user_id: 'u', user_name: 'Name', email: 'n@cust.example', role: 'viewer',
    status: 'active', invited_at: null, accepted_at: null, last_active_at: null,
    ...overrides,
  };
}

const MEMBERS: OrgMember[] = [
  member({ id: 'm_self', user_id: 't_alice', user_name: 'Alice Owner', email: 'alice@cust.example', role: 'owner' }),
  // Non-owner role on purpose: the owner rule alone would already hide controls.
  member({ id: 'm_soc', user_id: null, user_name: 'Averrow SOC', email: null, role: 'admin', is_averrow: true }),
  member({ id: 'm_bob', user_id: 't_bob', user_name: 'Bob Customer', email: 'bob@cust.example', role: 'analyst' }),
];

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    user: {
      id: 't_alice', email: 'alice@cust.example', name: 'Alice Owner', role: 'client',
      organization: { id: 7, name: 'Acme', slug: 'acme', plan: 'business', role: 'owner' },
    },
    hasOrg: true,
    loading: false,
  } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useOrgMembers).mockReturnValue(
    { data: MEMBERS, isLoading: false, error: null } as unknown as ReturnType<typeof useOrgMembers>,
  );
  vi.mocked(useOrgInvites).mockReturnValue(
    { data: [], isLoading: false, error: null } as unknown as ReturnType<typeof useOrgInvites>,
  );
  for (const hook of [useInviteMember, useRevokeInvite, useResendInvite, useRemoveMember, useUpdateMemberRole, useTransferOwnership]) {
    vi.mocked(hook).mockReturnValue(mutationStub as never);
  }
});

function memberRow(name: string): HTMLElement {
  // The first occurrence is the Active members list (transfer section follows).
  const el = screen.getAllByText(name)[0]!;
  const row = el.closest('div.flex.items-center.gap-3');
  if (!(row instanceof HTMLElement)) throw new Error(`row for ${name} not found`);
  return row;
}

describe('Members — masked Averrow seat', () => {
  it('renders the Averrow row without crashing and without manage controls', () => {
    renderWithProviders(<Members />);
    const soc = memberRow('Averrow SOC');
    expect(within(soc).getByText('Averrow security operations')).toBeInTheDocument();
    expect(within(soc).queryByTitle('Remove member')).not.toBeInTheDocument();
    expect(within(soc).getByRole('button', { name: 'Admin' })).toBeDisabled();

    // A real customer member stays manageable (control proves the gate is specific).
    const bob = memberRow('Bob Customer');
    expect(within(bob).getByTitle('Remove member')).toBeInTheDocument();
    expect(within(bob).getByRole('button', { name: 'Analyst' })).toBeEnabled();
  });

  it('excludes the Averrow seat from transfer-ownership candidates', () => {
    renderWithProviders(<Members />);
    const heading = screen.getByRole('heading', { name: 'Transfer ownership' });
    const section = heading.closest('section');
    if (!(section instanceof HTMLElement)) throw new Error('transfer section not found');
    const targets = within(section).getAllByRole('button').filter((b) => /Transfer/.test(b.textContent ?? ''));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toHaveTextContent('Bob Customer');
    expect(within(section).queryByText('Averrow SOC')).not.toBeInTheDocument();
  });
});
