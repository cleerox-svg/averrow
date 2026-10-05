import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ROLE_LABELS, USER_ROLES, roleLabel } from '@averrow/shared';

const logout = vi.fn(() => Promise.resolve());
const switchAccount = vi.fn(() => Promise.resolve());
let role = 'sales';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.co', name: 'A B', role },
    logout,
    switchAccount,
  }),
}));
vi.mock('@/hooks/useWindowWidth', () => ({ useIsMobile: () => false }));

import { UserAvatar } from './UserAvatar';

function open() {
  render(<MemoryRouter><UserAvatar /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /user menu/i }));
}

describe('role labels', () => {
  it('covers all 8 roles', () => {
    expect(USER_ROLES).toHaveLength(8);
    expect(USER_ROLES.map(r => ROLE_LABELS[r])).toEqual([
      'Super Admin', 'Admin', 'Analyst', 'Sales', 'Support', 'Billing', 'Auditor', 'Client',
    ]);
  });
  it('falls back to the raw key for unknown roles', () => {
    expect(roleLabel('mystery')).toBe('mystery');
  });
});

describe('UserAvatar profile menu', () => {
  beforeEach(() => { logout.mockClear(); switchAccount.mockClear(); });

  it('shows the real role label, not "Client"', () => {
    role = 'auditor';
    open();
    expect(screen.getByText('Auditor')).toBeTruthy();
  });

  it('Switch account calls switchAccount, not logout', () => {
    role = 'analyst';
    open();
    fireEvent.click(screen.getByText('Switch account'));
    expect(switchAccount).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
  });

  it('Logout calls logout only', () => {
    role = 'analyst';
    open();
    fireEvent.click(screen.getByText('Logout'));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(switchAccount).not.toHaveBeenCalled();
  });
});

describe('UserAvatar menu — account links', () => {
  function Where() {
    return <div data-testid="where">{useLocation().pathname}</div>;
  }
  function openWithLocation() {
    render(<MemoryRouter initialEntries={['/']}><Where /><UserAvatar /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /user menu/i }));
  }

  it('offers the four settings pages, no Organization / API Keys, no profile picture', () => {
    role = 'admin';
    openWithLocation();
    for (const label of ['Profile', 'Security', 'Notifications', 'Devices & App']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.queryByText('Organization')).toBeNull();
    expect(screen.queryByText('API Keys')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it.each([
    ['Profile', '/settings/profile'],
    ['Security', '/settings/security'],
    ['Notifications', '/settings/notifications'],
    ['Devices & App', '/settings/devices'],
  ])('%s navigates to %s', (label, path) => {
    role = 'admin';
    openWithLocation();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByTestId('where').textContent).toBe(path);
  });
});
