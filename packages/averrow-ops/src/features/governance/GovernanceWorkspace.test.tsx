import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ role: 'analyst', isSuperAdmin: false }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { role: mocks.role }, isSuperAdmin: mocks.isSuperAdmin }),
}));
vi.mock('@/features/admin/AdminAudit', () => ({ AdminAudit: () => <div>audit-pane</div> }));
vi.mock('@/features/admin/PricingConfig', () => ({ PricingConfig: () => <div>pricing-pane</div> }));
vi.mock('@/features/admin/NotificationCenter', () => ({ NotificationCenter: () => <div>notif-pane</div> }));
vi.mock('@/features/admin/PlatformUsers', () => ({ PlatformUsers: () => <div>users-pane</div> }));

import { GovernanceWorkspace } from './GovernanceWorkspace';

function mount(role: string, isSuperAdmin = false) {
  mocks.role = role;
  mocks.isSuperAdmin = isSuperAdmin;
  return render(
    <MemoryRouter initialEntries={['/admin/governance?tab=audit']}>
      <Routes>
        <Route path="/admin/governance" element={<GovernanceWorkspace />} />
        <Route path="/admin" element={<div>admin-home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GovernanceWorkspace role gating', () => {
  it('shows Audit Log to admins', async () => {
    mount('admin');
    expect(await screen.findByRole('button', { name: /Audit Log/ })).toBeInTheDocument();
  });

  it('shows Audit Log to analysts, who hold view_audit, but not Users', async () => {
    mount('analyst');
    expect(await screen.findByText('audit-pane')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Users/ })).toBeNull();
  });

  it('hides Audit Log from staff without view_audit who still have another tab', async () => {
    mount('billing');
    expect(await screen.findByRole('button', { name: /Pricing/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Audit Log/ })).toBeNull();
    expect(screen.queryByText('audit-pane')).toBeNull();
  });

  it('redirects to /admin when a staff role has no visible tab', async () => {
    mount('support');
    expect(await screen.findByText('admin-home')).toBeInTheDocument();
  });
});
