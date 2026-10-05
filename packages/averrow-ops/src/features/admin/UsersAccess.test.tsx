import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Link } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ role: 'super_admin', isSuperAdmin: true }));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u_me', email: 'me@averrow.com', role: mocks.role, name: 'Me' },
    isSuperAdmin: mocks.isSuperAdmin,
  }),
}));

import { api } from '@/lib/api';
import { UsersAccess } from './UsersAccess';

const get = api.get as ReturnType<typeof vi.fn>;
const patch = api.patch as ReturnType<typeof vi.fn>;
const post = api.post as ReturnType<typeof vi.fn>;
const del = api.delete as ReturnType<typeof vi.fn>;

const mkUser = (id: string, name: string, role: string, status = 'active') => ({
  id, email: `${id}@averrow.com`, name, role, status,
  created_at: '2026-01-01 00:00:00', last_login: null, last_active: '2026-10-01 00:00:00', invited_by: null,
});
const USERS = [
  mkUser('u_me', 'Me Self', mocks.role),
  mkUser('u_sa', 'Sam Super', 'super_admin'),
  mkUser('u_ad', 'Ada Admin', 'admin'),
  mkUser('u_an', 'Ann Analyst', 'analyst'),
];
const INVITES = [
  { id: 'inv1', email: 'new@averrow.com', role: 'analyst', status: 'pending', created_at: '2026-10-04 00:00:00', expires_at: '2099-10-07 00:00:00', accepted_at: null, invited_by_email: 'boss@averrow.com' },
];

type Mode = 'ok' | 'pending' | 'reject' | 'empty';
let usersMode: Mode;
let invitesMode: Mode;

function setupApi() {
  get.mockImplementation((url: string) => {
    if (url.startsWith('/api/admin/users')) {
      if (usersMode === 'pending') return new Promise(() => {});
      if (usersMode === 'reject') return Promise.reject(new Error('boom'));
      const role = new URL(url, 'http://x').searchParams.get('role');
      const users = usersMode === 'empty' ? [] : USERS.filter((u) => u.role === role);
      return Promise.resolve({ success: true, data: { users, total: users.length } });
    }
    if (url.startsWith('/api/admin/invites')) {
      if (invitesMode === 'pending') return new Promise(() => {});
      if (invitesMode === 'reject') return Promise.reject(new Error('boom'));
      return Promise.resolve({ success: true, data: invitesMode === 'empty' ? [] : INVITES });
    }
    return Promise.resolve({ success: true });
  });
  patch.mockResolvedValue({ success: true, data: USERS[3] });
  post.mockResolvedValue({ success: true, data: { id: 'inv2' } });
  del.mockResolvedValue({ success: true, data: { id: 'inv1' } });
}

function renderPage(url = '/admin/users?tab=staff', extra?: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <UsersAccess />
        {extra}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const asRole = (role: string, isSuperAdmin = false) => { mocks.role = role; mocks.isSuperAdmin = isSuperAdmin; };
const usersCalls = () => get.mock.calls.filter(([u]) => String(u).startsWith('/api/admin/users')).length;
const invitesCalls = () => get.mock.calls.filter(([u]) => String(u).startsWith('/api/admin/invites')).length;

beforeEach(() => {
  vi.clearAllMocks();
  usersMode = 'ok';
  invitesMode = 'ok';
  asRole('super_admin', true);
  setupApi();
});
afterEach(() => { window.matchMedia = undefined as unknown as typeof window.matchMedia; });

describe('UsersAccess: tabs and ?tab mapping', () => {
  it('uses the new copy and drops every customer-org surface', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Users & Access' })).toBeInTheDocument();
    expect(screen.getByText('Manage staff and invites.')).toBeInTheDocument();
    for (const gone of [/brands/i, /sso/i, /webhooks/i, /integrations/i, /api keys/i, /coming soon/i, /danger/i]) {
      expect(screen.queryByRole('tab', { name: gone })).not.toBeInTheDocument();
    }
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Staff', 'Invites']);
  });

  it.each([
    ['?tab=members', 'Staff'],
    ['?tab=staff', 'Staff'],
    ['?tab=invites', 'Invites'],
    ['?tab=api-keys', 'Staff'],   // removed tab id -> default
    ['?tab=sso', 'Staff'],
    ['', 'Staff'],
  ])('maps %s onto the %s tab', async (qs, tab) => {
    renderPage(`/admin/users${qs}`);
    await waitFor(() => expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true'));
  });

  it('follows a ?tab= change while mounted and writes the tab to the URL on click', async () => {
    renderPage('/admin/users?tab=members', <Link to="/admin/users?tab=invites">go invites</Link>);
    expect(await screen.findByRole('tab', { name: 'Staff' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.setup().click(screen.getByRole('link', { name: 'go invites' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Invites' })).toHaveAttribute('aria-selected', 'true'));
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Staff' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Staff' })).toHaveAttribute('aria-selected', 'true'));
  });
});

describe('UsersAccess: permission gating', () => {
  it('admin sees Staff and Invites', async () => {
    asRole('admin');
    renderPage();
    expect(await screen.findByRole('tab', { name: 'Staff' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Invites' })).toBeInTheDocument();
  });

  it('sales (manage_invites, not admin) gets Invites only and never calls the users API', async () => {
    asRole('sales');
    renderPage('/admin/users?tab=staff');
    expect(await screen.findByRole('tab', { name: 'Invites' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Staff' })).not.toBeInTheDocument();
    await screen.findByText('new@averrow.com');
    expect(usersCalls()).toBe(0);
  });

  it.each(['analyst', 'support', 'billing', 'auditor'])('%s sees a locked state and makes no API calls', async (role) => {
    asRole(role);
    renderPage();
    expect(await screen.findByText('Admin access required')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(usersCalls() + invitesCalls()).toBe(0);
  });

  it('super_admin can edit roles and statuses of other staff, not self', async () => {
    renderPage();
    await screen.findByText('Ann Analyst');
    expect(screen.getByLabelText('Role for Ann Analyst')).toBeInTheDocument();
    expect(screen.getByLabelText('Role for Ada Admin')).toBeInTheDocument();
    expect(screen.getByLabelText('Status for Sam Super')).toBeInTheDocument();
    expect(screen.queryByLabelText(/for Me Self/)).not.toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
  });

  it('a plain admin may manage analyst status only; admin/super_admin rows and all role changes are read-only', async () => {
    asRole('admin');
    renderPage();
    await screen.findByText('Ann Analyst');
    expect(screen.getByLabelText('Status for Ann Analyst')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Role for/)).not.toBeInTheDocument();     // only `analyst` is grantable
    expect(screen.queryByLabelText('Status for Ada Admin')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Status for Sam Super')).not.toBeInTheDocument();
  });

  it('invite roles: super_admin may grant all three, admin only analyst', async () => {
    renderPage('/admin/users?tab=invites');
    const sel = await screen.findByLabelText('Role');
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['Analyst', 'Admin', 'Super admin']);
  });

  it('invite roles for admin are limited to Analyst', async () => {
    asRole('admin');
    renderPage('/admin/users?tab=invites');
    const sel = await screen.findByLabelText('Role');
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['Analyst']);
  });
});

describe('UsersAccess: staff changes confirm before the guarded PATCH', () => {
  it('suspending asks first; Cancel sends nothing; Confirm sends the status', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ann Analyst');
    await user.selectOptions(screen.getByLabelText('Status for Ann Analyst'), 'suspended');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Suspend Ann Analyst?')).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(patch).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText('Status for Ann Analyst'), 'suspended');
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/admin/users/u_an', { status: 'suspended' }));
  });

  it('deactivation is confirmed with its own copy', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ann Analyst');
    await user.selectOptions(screen.getByLabelText('Status for Ann Analyst'), 'deactivated');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Deactivate Ann Analyst?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/admin/users/u_an', { status: 'deactivated' }));
  });

  it('demoting an admin is a confirmed danger action; the role is only sent on confirm', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ada Admin');
    await user.selectOptions(screen.getByLabelText('Role for Ada Admin'), 'analyst');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Change Ada Admin to Analyst?')).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Make Analyst' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/admin/users/u_ad', { role: 'analyst' }));
  });

  it('reactivating restores access immediately (no confirm)', async () => {
    usersMode = 'ok';
    USERS[3]!.status = 'suspended';
    try {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Ann Analyst');
      await user.selectOptions(screen.getByLabelText('Status for Ann Analyst'), 'active');
      await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/admin/users/u_an', { status: 'active' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      USERS[3]!.status = 'active';
    }
  });

  it('keeps the dialog open with the server message when the guarded PATCH is refused', async () => {
    patch.mockResolvedValue({ success: false, error: 'Only super admins can change the role or status of an admin' });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ann Analyst');
    await user.selectOptions(screen.getByLabelText('Status for Ann Analyst'), 'suspended');
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText(/Only super admins can change/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the revocation_pending warning and can force sign-out', async () => {
    patch.mockResolvedValue({ success: true, data: USERS[2], revocation_pending: true, warning: 'Role updated, but existing sessions could not be revoked.' });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ada Admin');
    await user.selectOptions(screen.getByLabelText('Role for Ada Admin'), 'analyst');
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Make Analyst' }));
    expect(await screen.findByText('Sessions not yet revoked')).toBeInTheDocument();
    expect(screen.getByText(/could not be revoked/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/admin/users/u_ad/force-logout'));
  });
});

describe('UsersAccess: staff list states', () => {
  it('loading shows neither the empty nor the error copy', async () => {
    usersMode = 'pending';
    renderPage();
    expect(await screen.findByText('Loading staff…')).toBeInTheDocument();
    expect(screen.queryByText('No staff yet')).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load staff")).not.toBeInTheDocument();
  });

  it('error renders an alert with retry, never the empty copy', async () => {
    usersMode = 'reject';
    renderPage();
    expect(await screen.findByText("Couldn't load staff")).toBeInTheDocument();
    expect(screen.queryByText('No staff yet')).not.toBeInTheDocument();
    const before = usersCalls();
    await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(usersCalls()).toBeGreaterThan(before));
  });

  it('empty renders the invite hint', async () => {
    usersMode = 'empty';
    renderPage();
    expect(await screen.findByText('No staff yet')).toBeInTheDocument();
  });

  it('under 640px renders a card list with the same labelled controls', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width: 639px'), media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    renderPage();
    const list = await screen.findByRole('list', { name: 'Staff' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status for Ann Analyst')).toBeInTheDocument();
  });
});

describe('UsersAccess: invites tab', () => {
  it('lists pending invites; Revoke confirms before DELETE', async () => {
    const user = userEvent.setup();
    renderPage('/admin/users?tab=invites');
    expect(await screen.findByText('new@averrow.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke invite for new@averrow.com' }));
    const dialog = await screen.findByRole('dialog');
    expect(del).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke invite' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/admin/invites/inv1'));
  });

  it('Cancel on the revoke dialog sends nothing', async () => {
    const user = userEvent.setup();
    renderPage('/admin/users?tab=invites');
    await user.click(await screen.findByRole('button', { name: 'Revoke invite for new@averrow.com' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(del).not.toHaveBeenCalled();
  });

  it('sends an invite for a valid email only', async () => {
    const user = userEvent.setup();
    renderPage('/admin/users?tab=invites');
    const send = await screen.findByRole('button', { name: 'Send invite' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('Email'), 'nope');
    expect(send).toBeDisabled();
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'fresh@averrow.com');
    await user.click(send);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/admin/invites', { email: 'fresh@averrow.com', role: 'analyst' }));
  });

  it('error renders retry (not the empty copy); empty renders the empty copy', async () => {
    invitesMode = 'reject';
    const { unmount } = renderPage('/admin/users?tab=invites');
    expect(await screen.findByText("Couldn't load invites")).toBeInTheDocument();
    expect(screen.queryByText('No pending invites')).not.toBeInTheDocument();
    unmount();

    invitesMode = 'empty';
    renderPage('/admin/users?tab=invites');
    expect(await screen.findByText('No pending invites')).toBeInTheDocument();
  });

  it('loading shows neither empty nor error', async () => {
    invitesMode = 'pending';
    renderPage('/admin/users?tab=invites');
    await screen.findByText('Loading invites…');
    expect(screen.queryByText('No pending invites')).not.toBeInTheDocument();
  });
});
