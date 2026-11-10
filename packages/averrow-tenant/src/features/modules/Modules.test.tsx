import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderWithProviders } from '@/test/utils';
import { Modules, fillTrendDays, weekdayUtc } from './Modules';
import type { TenantModulesResponse } from '@/lib/modules';
import type { DashboardResponse } from '@/lib/dashboard';

// Facelift Phase 6 screen 4: the tenant Workspace overview. Asserts the
// observable contract (copy, roles, tokens) plus static guards that keep raw
// colours and unscoped CSS out of the screen.

const auth = vi.hoisted(() => ({
  state: {
    user: { id: 'u1', organization: { id: 'org1', name: 'Acme' } },
    hasOrg: true,
    loading: false,
  } as { user: unknown; hasOrg: boolean; loading: boolean },
}));
const modulesHook = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
const dashboardHook = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));

vi.mock('@/lib/auth', () => ({ useAuth: () => auth.state }));
vi.mock('@/lib/modules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/modules')>();
  return { ...actual, useTenantModules: () => modulesHook.result };
});
vi.mock('@/lib/dashboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dashboard')>();
  return { ...actual, useTenantDashboard: () => dashboardHook.result };
});

function modulesData(signed: boolean): TenantModulesResponse {
  return {
    org_id: 1,
    modules: [
      { module_key: 'domain', status: 'active', metrics: [{ module_key: 'domain', metric_key: 'scans', label: 'Scans', unit: 'n', is_billable: 0, description: null, value_this_month: 12 }] },
      { module_key: 'social', status: 'trial', metrics: [] },
      { module_key: 'dark_web', status: 'not_entitled', metrics: [] },
    ],
    takedown_authorization: signed
      ? { signed: true, modules_covered: ['domain', 'social'] }
      : { signed: false },
  };
}

const dashboard: DashboardResponse = {
  total_brands: 1,
  total_active_threats: 14,
  total_alerts_open: 3,
  total_social_profiles: 4,
  total_impersonation_alerts: 2,
  avg_exposure_score: 55,
  brands: [{
    id: 'b1', name: 'Acme', canonical_domain: 'acme.test', sector: null, threat_count: 20,
    exposure_score: 72, email_security_grade: null, social_risk_score: null, last_social_scan: null,
    last_threat_seen: null, is_primary: 1, active_threats: 14, social_profiles_count: 4, impersonation_count: 2,
  }],
  recent_alerts: [
    { id: 'a1', title: 'Fake login page', severity: 'high', alert_type: 'lookalike_domain_active', status: 'new', created_at: '2026-11-03T10:00:00Z', brand_name: 'Acme' },
    { id: 'a2', title: 'Odd handle', severity: '', alert_type: 'social_impersonation', status: 'new', created_at: '2026-11-03T11:00:00Z', brand_name: 'Acme' },
  ],
  threat_trend: [
    { date: '2026-11-02', count: 3 },
    { date: '2026-11-03', count: 9 },
  ],
};

function setup(signed = false, opts: { modules?: TenantModulesResponse; dashboard?: Partial<DashboardResponse> | null } = {}) {
  auth.state = { user: { id: 'u1', organization: { id: 'org1', name: 'Acme' } }, hasOrg: true, loading: false };
  modulesHook.result = { data: opts.modules ?? modulesData(signed), isLoading: false, error: null, refetch: vi.fn() };
  dashboardHook.result = {
    data: opts.dashboard === null ? undefined : { ...dashboard, ...opts.dashboard },
    isLoading: false, error: null, refetch: vi.fn(),
  };
  return renderWithProviders(<Modules />);
}

afterEach(() => { vi.useRealTimers(); });


describe('Modules (tenant Workspace overview)', () => {
  it('keeps the kept headings and uses sentence-case, non-mono section labels', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Workspace overview' })).toBeTruthy();
    for (const name of ['Active modules', 'Available to add', 'Recent signals', '7-day threat trend']) {
      const h = screen.getByRole('heading', { name });
      expect(h.textContent).toBe(name);
      expect(h.className).not.toMatch(/uppercase|font-mono|tracking-/);
    }
    const brands = screen.getByRole('heading', { name: /^Brands \(1\)$/ });
    expect(brands.className).not.toMatch(/uppercase|font-mono|tracking-/);
    for (const label of ['Open signals', 'Impersonations', 'Exposure score']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('uses no amber on counts; only critical impersonations and the exposure band are coloured', () => {
    const { container } = setup();
    expect(container.innerHTML).not.toMatch(/amber/i);
    const threats = screen.getAllByText('Active threats')[0]!.parentElement!.nextElementSibling!.firstElementChild as HTMLElement;
    expect(threats.getAttribute('style') ?? '').toBe('');
    const imp = screen.getAllByText('Impersonations')[0]!.parentElement!.nextElementSibling!.firstElementChild as HTMLElement;
    expect(imp.getAttribute('style')).toContain('--sev-critical-text');
    const exposure = screen.getAllByText('Exposure score')[0]!.parentElement!.nextElementSibling!.firstElementChild as HTMLElement;
    expect(exposure.getAttribute('style')).toContain('--sev-medium-text');
  });

  it('renders signal severity through the kit Badge: high is not amber, empty falls back to neutral Unknown', () => {
    setup();
    const high = screen.getByText('High');
    expect(high.getAttribute('style')).toContain('--sev-high');
    expect(high.getAttribute('style')).not.toMatch(/amber|sev-medium/);
    expect(screen.getByText('Lookalike domain active')).toBeTruthy();
    const unknown = screen.getByText('Unknown');
    expect(unknown.getAttribute('style')).not.toMatch(/sev-/);
  });

  it('shows the unsigned authorization Banner with a real link', () => {
    setup(false);
    expect(screen.getByText('Sign your takedown authorization')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Sign your takedown authorization' });
    expect(link.getAttribute('href')).toBe('/settings/takedown-authorization');
    expect(document.querySelector('.ds-banner[data-tone="medium"]')).toBeTruthy();
  });

  it('shows the signed authorization Banner with coverage copy', () => {
    setup(true);
    expect(screen.getByText('Takedown authorization signed')).toBeTruthy();
    expect(screen.getByText(/Coverage: 2 modules\./)).toBeTruthy();
    expect(document.querySelector('.ds-banner[data-tone="success"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage takedown authorization' })).toBeTruthy();
  });

  it('fills the trend to the last 7 UTC days and gives it a text alternative', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T23:30:00Z'));
    const { container } = setup();
    expect(screen.getAllByTestId('trend-bar')).toHaveLength(7);
    const label = screen.getByRole('img', { name: /Threats per day/ }).getAttribute('aria-label') ?? '';
    expect(label).toContain('last 7 days');
    expect(label).toContain('Sat 0');
    expect(label).toContain('Sun 0');
    expect(label).toContain('Mon 3');
    expect(label).toContain('Tue 9');
    expect(label).toContain('12 total');
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('computes trend days in UTC regardless of the local zone', () => {
    // 02:00 UTC on Nov 3 is still Nov 2 in the Americas; the window must end on the UTC day.
    const days = fillTrendDays([{ date: '2026-11-03', count: 5 }], new Date('2026-11-03T02:00:00Z'));
    expect(days.map((d) => d.date)).toEqual([
      '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03',
    ]);
    expect(days[6]!.count).toBe(5);
    expect(days.slice(0, 6).every((d) => d.count === 0)).toBe(true);
    expect(weekdayUtc('2026-11-03')).toBe('Tue');
  });

  it('renders the brands table with a caption, column scopes and a single link per brand', () => {
    setup();
    const table = screen.getByRole('table');
    expect(table.querySelector('caption')?.className).toContain('sr-only');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['Brand', 'Active threats', 'Exposure', 'Impersonations', 'Social profiles']);
    for (const th of headers) expect(th.getAttribute('scope')).toBe('col');
    expect(within(table).getAllByRole('link')).toHaveLength(1);
    // Columns are never hidden on small screens; the region scrolls instead.
    expect(table.outerHTML).not.toMatch(/hidden md:table-cell/);
    expect(screen.getByRole('region', { name: 'Brands' })).toBeTruthy();
  });

  it('labels module cards with status Badges and hides decorative icons', () => {
    const { container } = setup();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Trial')).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy();
    const icons = container.querySelectorAll('a.th-module svg');
    expect(icons.length).toBeGreaterThan(0);
    for (const svg of icons) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('lists a suspended module with the owned modules, badged Suspended, not under Available to add', () => {
    const m = modulesData(false);
    setup(false, { modules: { ...m, modules: [
      ...m.modules,
      { module_key: 'trademark', status: 'suspended', metrics: [] },
    ] } });
    const owned = screen.getByRole('region', { name: 'Active modules' });
    const avail = screen.getByRole('region', { name: 'Available to add' });
    expect(within(owned).getByText('Trademark Infringement')).toBeTruthy();
    expect(within(owned).getByText('Suspended')).toBeTruthy();
    expect(within(owned).getByText('Access paused. Contact your admin.')).toBeTruthy();
    expect(within(avail).queryByText('Trademark Infringement')).toBeNull();
    expect(within(avail).getByText('Dark Web Monitoring')).toBeTruthy();
    expect(within(avail).getByText('Locked')).toBeTruthy();
    expect(within(avail).queryByText('Suspended')).toBeNull();
    expect(within(owned).getByText('Active')).toBeTruthy();
    expect(within(owned).getByText('Trial')).toBeTruthy();
    expect(screen.getByText(/2 modules active/)).toBeTruthy();
  });

  it('announces loading with role=status', () => {
    auth.state = { user: null, hasOrg: false, loading: true };
    modulesHook.result = { data: undefined, isLoading: true, error: null };
    dashboardHook.result = { data: undefined, isLoading: true, error: null };
    renderWithProviders(<Modules />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('announces a load failure with role=alert', () => {
    auth.state = { user: { id: 'u1', organization: { id: 'org1', name: 'Acme' } }, hasOrg: true, loading: false };
    modulesHook.result = { data: undefined, isLoading: false, error: new Error('boom'), refetch: vi.fn() };
    dashboardHook.result = { data: undefined, isLoading: false, error: null };
    renderWithProviders(<Modules />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("Couldn't load your workspace");
    expect(alert.textContent).toContain('boom');
  });

  it('retries the modules query from the error state', async () => {
    const refetch = vi.fn();
    auth.state = { user: { id: 'u1', organization: { id: 'org1', name: 'Acme' } }, hasOrg: true, loading: false };
    modulesHook.result = { data: undefined, isLoading: false, error: new Error('boom'), refetch };
    dashboardHook.result = { data: undefined, isLoading: false, error: null };
    renderWithProviders(<Modules />);
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a status skeleton while only the dashboard is loading', () => {
    setup();
    dashboardHook.result = { data: undefined, isLoading: true, error: null };
    document.body.innerHTML = '';
    renderWithProviders(<Modules />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain('Loading summary');
  });

  it('shows an inline error with retry when the dashboard fails and has no data', async () => {
    const refetch = vi.fn();
    setup();
    dashboardHook.result = { data: undefined, isLoading: false, error: new Error('nope'), refetch };
    document.body.innerHTML = '';
    renderWithProviders(<Modules />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load your summary");
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Active modules' })).toBeTruthy();
  });

  it('shows the empty card when no module is active, and omits "Available to add" when none are locked', () => {
    const m = modulesData(false);
    setup(false, { modules: { ...m, modules: [{ module_key: 'dark_web', status: 'not_entitled', metrics: [] }] } });
    expect(screen.getByText('No modules active yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Available to add' })).toBeTruthy();

    document.body.innerHTML = '';
    setup(false, { modules: { ...m, modules: [{ module_key: 'domain', status: 'active', metrics: [] }] } });
    expect(screen.queryByRole('heading', { name: 'Available to add' })).toBeNull();
    expect(screen.queryByText('No modules active yet.')).toBeNull();
  });

  it('omits dashboard sections that have no data', () => {
    setup(false, { dashboard: null });
    expect(screen.queryByText('Open signals')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Active modules' })).toBeTruthy();

    document.body.innerHTML = '';
    setup(false, { dashboard: { brands: [], threat_trend: [], recent_alerts: [] } });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('heading', { name: '7-day threat trend' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Recent signals' })).toBeNull();
    expect(screen.getByText('Open signals')).toBeTruthy();
  });

  it('shows an em dash without /100 when the exposure score is null', () => {
    const { container } = setup(false, { dashboard: { avg_exposure_score: null } });
    const value = screen.getAllByText('Exposure score')[0]!.parentElement!.nextElementSibling!;
    expect(value.textContent).toBe('—');
    expect(container.textContent).not.toContain('/100');
  });
});

describe('Modules facelift source guards', () => {
  const dir = __dirname;
  const tsx = readFileSync(resolve(dir, 'Modules.tsx'), 'utf8');
  const css = readFileSync(resolve(dir, 'modules.css'), 'utf8');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const [name, src] of [['Modules.tsx', tsx], ['modules.css', css]] as const) {
    it(`${name} has no raw colours, white-alpha, amber classes or pulse animation`, () => {
      const code = strip(src);
      expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code).not.toMatch(/rgba\(/);
      expect(code).not.toMatch(/white\/\[/);
      expect(code).not.toMatch(/text-white\//);
      expect(code).not.toMatch(/text-amber/);
      expect(code).not.toMatch(/animate-pulse/);
      expect(code).not.toMatch(/text-shadow/);
    });
  }

  it('every modules.css rule is scoped under :root[data-accent]', () => {
    const code = strip(css);
    const preludes = [...code.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((p) => !p.startsWith('@'));
    expect(preludes.length).toBeGreaterThan(0);
    for (const prelude of preludes) {
      for (const sel of prelude.split(',')) {
        expect(sel.trim().startsWith(':root[data-accent]')).toBe(true);
      }
    }
  });
});
