import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: null, loading: false, logout: vi.fn() }) }));
vi.mock('@/lib/modules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/modules')>();
  return {
    ...actual,
    useTenantModules: () => ({
      isLoading: false,
      data: {
        modules: [
          { module_key: 'domain', status: 'active', metrics: [] },
          { module_key: 'social', status: 'trial', metrics: [] },
          { module_key: 'trademark', status: 'suspended', metrics: [] },
          { module_key: 'dark_web', status: 'not_entitled', metrics: [] },
        ],
      },
    }),
  };
});
vi.mock('@/lib/auditLog', () => ({ useCanViewAudit: () => false }));
vi.mock('@/lib/useTheme', () => ({ useTheme: () => ({ theme: 'dark', cycle: vi.fn() }) }));

describe('Sidebar module sections', () => {
  it('keeps a suspended module in Modules with a Suspended badge, not under Unlock', () => {
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    const section = (label: string) => screen.getByText(label, { selector: 'div' }).parentElement as HTMLElement;
    const modules = section('Modules');
    const unlock = section('Unlock');
    expect(within(modules).getByText('Trademark Infringement')).toBeTruthy();
    expect(within(modules).getByText('Suspended')).toBeTruthy();
    expect(within(modules).getByText('Trial')).toBeTruthy();
    expect(within(unlock).queryByText('Trademark Infringement')).toBeNull();
    expect(within(unlock).getByText('Dark Web Monitoring')).toBeTruthy();
    expect(within(unlock).queryByText('Suspended')).toBeNull();
  });
});
