// Route-level check that retired standalone list paths land on the right
// workspace tab (query string + hash preserved) and that detail routes are
// left alone.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router-dom';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ isAuthenticated: true, loading: false }) }));
vi.mock('@/components/layout/ShellV4', () => ({ ShellV4: () => <Outlet /> }));
vi.mock('@/pages/Login', () => ({ Login: () => null }));

function Probe({ name }: { name: string }) {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="where">{`${name}|${pathname}${search}${hash}`}</div>;
}
vi.mock('@/features/console/Console', () => ({ Console: () => <Probe name="console" /> }));
vi.mock('@/features/explore/ExploreWorkspace', () => ({ ExploreWorkspace: () => <Probe name="explore" /> }));
vi.mock('@/features/coverage/CoverageWorkspace', () => ({ CoverageWorkspace: () => <Probe name="coverage" /> }));
vi.mock('@/features/operations/OperationsWorkspace', () => ({ OperationsWorkspace: () => <Probe name="operations" /> }));
vi.mock('@/features/governance/GovernanceWorkspace', () => ({ GovernanceWorkspace: () => <Probe name="governance" /> }));
vi.mock('@/features/brands/BrandDetail', () => ({ BrandDetailV3: () => <Probe name="brand-detail" /> }));
vi.mock('@/features/settings/Notifications', () => ({ Notifications: () => <Probe name="inbox" /> }));

import App from './App';
import { LEGACY_TAB_PATHS, WORKSPACE_TABS } from '@/lib/workspaceRoutes';

async function landing(path: string) {
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
  return (await screen.findByTestId('where')).textContent;
}

describe('every LEGACY_TAB_PATHS entry redirects to its workspace tab', () => {
  it.each(Object.entries(LEGACY_TAB_PATHS))('%s -> %s', async (from, key) => {
    const t = WORKSPACE_TABS[key];
    const text = await landing(from);
    expect(text?.split('|')[1]).toBe(`${t.path}?tab=${t.tab}`);
  });
});

describe('standalone list paths redirect to workspace tabs', () => {
  it.each([
    ['/alerts?severity=critical', 'console|/console?tab=alerts&severity=critical'],
    ['/threats?q=evil.com#r1', 'console|/console?tab=threats&q=evil.com#r1'],
    ['/admin/incidents', 'console|/console?tab=incidents'],
    ['/admin/takedowns?scope=prospect', 'console|/console?tab=takedowns&scope=prospect'],
    ['/threat-actors?focus=t1', 'explore|/explore?tab=actors&focus=t1'],
    ['/providers/p1', 'explore|/explore?tab=providers&focus=p1'],
    ['/trends?tab=junk', 'coverage|/coverage?tab=trends'],
    ['/intelligence', 'coverage|/coverage?tab=trends'],
    ['/feeds', 'operations|/admin/operations?tab=feeds'],
    ['/admin/integrations', 'operations|/admin/operations?tab=takedown-integrations'],
    ['/admin/audit?window=7d', 'governance|/admin/governance?tab=audit&window=7d'],
    ['/admin/platform-users', 'governance|/admin/governance?tab=users'],
    ['/admin/feeds', 'operations|/admin/operations?tab=feeds'],
    ['/admin/agents', 'operations|/admin/operations?tab=agents'],
  ])('%s -> %s', async (from, expected) => {
    expect(await landing(from)).toBe(expected);
  });

  it('leaves detail routes and the user inbox alone', async () => {
    expect(await landing('/brands/b_1?tab=risk')).toBe('brand-detail|/brands/b_1?tab=risk');
  });
  it('keeps /notifications as the personal inbox (not Platform Notifications)', async () => {
    expect(await landing('/notifications')).toBe('inbox|/notifications');
  });
});
