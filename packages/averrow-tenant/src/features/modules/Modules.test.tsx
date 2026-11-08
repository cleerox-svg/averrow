import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderWithProviders } from '@/test/utils';
import { Modules } from './Modules';
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

function setup(signed = false) {
  auth.state = { user: { id: 'u1', organization: { id: 'org1', name: 'Acme' } }, hasOrg: true, loading: false };
  modulesHook.result = { data: modulesData(signed), isLoading: false, error: null, refetch: vi.fn() };
  dashboardHook.result = { data: dashboard, isLoading: false, error: null };
  return renderWithProviders(<Modules />);
}


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

  it('gives the trend a text alternative with UTC weekdays', () => {
    setup();
    const trend = screen.getByRole('img', { name: /Threats per day/ });
    const label = trend.getAttribute('aria-label') ?? '';
    expect(label).toContain('Mon 3');
    expect(label).toContain('Tue 9');
    expect(label).toContain('12 total');
  });

  it('renders the brands table with a caption, column scopes and a single link per brand', () => {
    setup();
    const table = screen.getByRole('table');
    expect(table.querySelector('caption')?.className).toContain('sr-only');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers).toHaveLength(5);
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
    for (const svg of container.querySelectorAll('a.th-module svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
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
});

describe('Modules facelift source guards', () => {
  const dir = __dirname.endsWith('modules') ? __dirname : resolve(__dirname);
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
