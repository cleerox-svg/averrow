// The deployment-approval endpoint is super_admin-only. The banner on the
// Agents page used to call it for every staff user; now only super_admin
// fires the request (everyone else would just get a 403 envelope).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { PendingApprovalsBanner, StalledRunsBanner } from './Agents';

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

  it('renders a medium Banner with a single Review link to the approvals page', async () => {
    get.mockResolvedValue({ success: true, data: { pending: [{ agent_id: 'a' }], total: 1 } });
    auth.mockReturnValue({ user: { role: 'super_admin' }, isSuperAdmin: true });
    renderWithProviders(<PendingApprovalsBanner />);
    const region = await screen.findByRole('region', { name: 'Agent deployment approvals' });
    expect(region).toHaveAttribute('data-tone', 'medium');
    expect(region).toHaveTextContent('1 agent awaiting deployment review');
    expect(region).toHaveTextContent('Newly deployed agents are blocked until a super admin approves them.');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/agents/approvals');
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

describe('Agents StalledRunsBanner', () => {
  const run = (i: number) => ({ id: i, agent_id: `agent_${i}`, started_at: new Date(Date.now() - 30 * 60_000).toISOString() });

  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ success: true, data: { pending: [{ agent_id: 'a' }, { agent_id: 'b' }], total: 2 } });
  });

  it('renders nothing without stalled runs', () => {
    auth.mockReturnValue({ user: { role: 'analyst' }, isSuperAdmin: false });
    renderWithProviders(<StalledRunsBanner stalled={[]} />);
    expect(screen.queryByRole('status', { name: 'Stalled agent runs' })).not.toBeInTheDocument();
  });

  it('is an inline high-tone status Banner with a list, no pulse, no alert role', () => {
    auth.mockReturnValue({ user: { role: 'analyst' }, isSuperAdmin: false });
    const { rerender } = renderWithProviders(<StalledRunsBanner stalled={[run(1)]} />);
    const region = screen.getByRole('status', { name: 'Stalled agent runs' });
    expect(region).toHaveAttribute('data-tone', 'high');
    expect(region).toHaveAttribute('data-variant', 'inline');
    expect(region).toHaveAttribute('role', 'status');
    expect(region.querySelector('[style*="live-ping"]')).toBeNull();
    expect(region).toHaveTextContent('1 stalled run, stuck for over 15 minutes');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    rerender(<StalledRunsBanner stalled={[run(1), run(2)]} />);
    expect(screen.getByRole('status', { name: 'Stalled agent runs' })).toHaveTextContent('2 stalled runs');
  });

  it('lists at most 8 runs and summarises the rest', () => {
    auth.mockReturnValue({ user: { role: 'analyst' }, isSuperAdmin: false });
    renderWithProviders(<StalledRunsBanner stalled={Array.from({ length: 11 }, (_, i) => run(i))} />);
    const region = screen.getByRole('status', { name: 'Stalled agent runs' });
    expect(region).toHaveTextContent('agent_7');
    expect(region).not.toHaveTextContent('agent_8');
    expect(region).toHaveTextContent('+3 more');
  });

  it('folds pending approvals into its footer for super_admin (single banner)', async () => {
    auth.mockReturnValue({ user: { role: 'super_admin' }, isSuperAdmin: true });
    renderWithProviders(<StalledRunsBanner stalled={[run(1)]} />);
    expect(await screen.findByText(/Also: 2 deployments awaiting approval/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/agents/approvals');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('shows no approvals line for roles that cannot see approvals', async () => {
    auth.mockReturnValue({ user: { role: 'admin' }, isSuperAdmin: false });
    renderWithProviders(<StalledRunsBanner stalled={[run(1)]} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/awaiting approval/)).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});
