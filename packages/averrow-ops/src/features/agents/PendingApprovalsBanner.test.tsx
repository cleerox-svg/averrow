// The deployment-approval endpoint is super_admin-only. The banner on the
// Agents page used to call it for every staff user; now only super_admin
// fires the request (everyone else would just get a 403 envelope).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { PendingApprovalsBanner } from './Agents';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const get = api.get as unknown as ReturnType<typeof vi.fn>;
const auth = useAuth as unknown as ReturnType<typeof vi.fn>;

describe('Agents PendingApprovalsBanner role gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ success: true, data: { pending: [{ agent_id: 'a' }, { agent_id: 'b' }], total: 2 } });
  });

  it('super_admin fetches the pending approvals and sees the banner', async () => {
    auth.mockReturnValue({ user: { role: 'super_admin' }, isSuperAdmin: true });
    renderWithProviders(<PendingApprovalsBanner />);
    expect(await screen.findByText('2 agents awaiting deployment review')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/admin/agents/approvals/pending');
  });

  it.each(['admin', 'analyst', 'sales', 'support', 'billing', 'auditor'])('%s never fires the request and sees no banner', async (role) => {
    auth.mockReturnValue({ user: { role }, isSuperAdmin: false });
    renderWithProviders(<PendingApprovalsBanner />);
    // Give a (wrongly) enabled query time to fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(get).not.toHaveBeenCalled();
    expect(screen.queryByText(/awaiting deployment review/)).not.toBeInTheDocument();
  });
});
