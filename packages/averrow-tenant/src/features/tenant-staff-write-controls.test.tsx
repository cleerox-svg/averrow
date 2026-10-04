// Write controls the worker refuses for Averrow staff (owner decision
// 2026-10-04: staff never act as the customer on tenant routes) are hidden
// for staff — and for customers below the required org role — in the tenant
// app: abuse-mailbox status flips, takedown-authorization sign/revoke, and
// the domain-findings "Request takedown" CTA.
//
// Trademark asset upload/delete is one of the four staff CROSSOVER surfaces
// (with executives, monitoring rules, billing): staff that pass the worker's
// gate (super_admin) get the controls; the read-only auditor seat does not.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/abuseMailboxModule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/abuseMailboxModule')>();
  return { ...actual, useUpdateAbuseMessageStatus: vi.fn() };
});
vi.mock('@/lib/dashboard', () => ({ useTenantDashboard: vi.fn() }));
vi.mock('@/lib/monitoring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/monitoring')>();
  return { ...actual, useMonitoringConfig: vi.fn(), useUpdateMonitoringConfig: vi.fn() };
});
vi.mock('@/lib/trademarkModule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trademarkModule')>();
  return { ...actual, useUploadTrademarkAsset: vi.fn(), useDeleteTrademarkAsset: vi.fn() };
});

import { useAuth } from '@/lib/auth';
import { useUpdateAbuseMessageStatus, type AbuseInboxMessageRow } from '@/lib/abuseMailboxModule';
import { useUploadTrademarkAsset, useDeleteTrademarkAsset, type TrademarkAssetRow } from '@/lib/trademarkModule';
import { canSignAuthorization, canRevokeAuthorization } from '@/lib/takedownAuthorization';
import { TenantStatusActions } from './abuse-mailbox/AbuseMailbox';
import { AssetsSection } from './trademark/BrandTrademarkFindings';
import { MaliciousDomainsSection } from './domain/BrandDomainFindings';
import { MonitoringRules } from './settings/MonitoringRules';
import { useTenantDashboard } from '@/lib/dashboard';
import { useMonitoringConfig, useUpdateMonitoringConfig, type MonitoringConfig } from '@/lib/monitoring';
import type { MaliciousDomainRow } from '@/lib/domainModule';

function mockAuth(globalRole: string, orgRole: string) {
  vi.mocked(useAuth).mockReturnValue({
    user: {
      id: 'u1', email: 'x@example.com', name: 'X', role: globalRole,
      organization: { id: 7, name: 'Acme', slug: 'acme', plan: 'business', role: orgRole },
    },
    hasOrg: true,
    loading: false,
  } as unknown as ReturnType<typeof useAuth>);
}

const mutationStub = { mutate: vi.fn(), isPending: false, error: null };

beforeEach(() => {
  vi.mocked(useUpdateAbuseMessageStatus).mockReturnValue(mutationStub as unknown as ReturnType<typeof useUpdateAbuseMessageStatus>);
  vi.mocked(useUploadTrademarkAsset).mockReturnValue(mutationStub as unknown as ReturnType<typeof useUploadTrademarkAsset>);
  vi.mocked(useDeleteTrademarkAsset).mockReturnValue(mutationStub as unknown as ReturnType<typeof useDeleteTrademarkAsset>);
  vi.mocked(useTenantDashboard).mockReturnValue({
    data: { brands: [{ id: 'b1', name: 'Acme' }] }, isLoading: false,
  } as unknown as ReturnType<typeof useTenantDashboard>);
  vi.mocked(useMonitoringConfig).mockReturnValue({
    data: MONITORING_CFG, isLoading: false, error: null,
  } as unknown as ReturnType<typeof useMonitoringConfig>);
  vi.mocked(useUpdateMonitoringConfig).mockReturnValue(
    { ...mutationStub, isError: false, isSuccess: false } as unknown as ReturnType<typeof useUpdateMonitoringConfig>,
  );
});

const MONITORING_CFG: MonitoringConfig = {
  alert_severity_filter: ['CRITICAL', 'HIGH'], auto_acknowledge_low_days: 0,
  social_platforms_monitored: [], email_notifications: true, email_notification_threshold: 'HIGH',
  weekly_digest: false, custom_keywords: [], excluded_domains: [],
};

describe('monitoring rules (staff crossover surface)', () => {
  it.each([['super_admin', 'owner'], ['admin', 'owner'], ['client', 'analyst']])(
    'edit controls render for %s with org role %s', (g, o) => {
      mockAuth(g, o);
      renderWithProviders(<MonitoringRules />);
      expect(screen.getByRole('button', { name: 'Save rules' })).toBeInTheDocument();
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

  it('the read-only auditor seat gets the staff note, not the analyst-role hint', () => {
    mockAuth('auditor', 'owner');
    renderWithProviders(<MonitoringRules />);
    expect(screen.queryByRole('button', { name: 'Save rules' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/Read-only for Averrow staff/);
    expect(screen.queryByText('Analyst role required to edit.')).not.toBeInTheDocument();
  });

  it('a customer viewer still sees the analyst-role hint', () => {
    mockAuth('client', 'viewer');
    renderWithProviders(<MonitoringRules />);
    expect(screen.queryByRole('button', { name: 'Save rules' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Analyst role required to edit.');
  });
});

const MESSAGE = { id: 'm1', status: 'new' } as unknown as AbuseInboxMessageRow;

const ASSET: TrademarkAssetRow = {
  id: 'ta1', brand_id: 'b1', asset_type: 'logo', asset_name: 'Acme Mark', asset_url: null,
  asset_hash: null, phash: null, registration_country: null, registration_number: null,
  registration_date: null, status: 'active', created_at: '2026-10-01T00:00:00Z',
};

describe('abuse-mailbox status actions', () => {
  it('render for a customer analyst', () => {
    mockAuth('client', 'analyst');
    renderWithProviders(<TenantStatusActions message={MESSAGE} />);
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  });

  it.each(['super_admin', 'admin', 'analyst', 'auditor'])('are read-only for staff role %s (even as org owner)', (role) => {
    mockAuth(role, 'owner');
    renderWithProviders(<TenantStatusActions message={MESSAGE} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/staff triage from the Averrow console/)).toBeInTheDocument();
  });

  it('are read-only for a customer viewer', () => {
    mockAuth('client', 'viewer');
    renderWithProviders(<TenantStatusActions message={MESSAGE} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/requires the analyst role/)).toBeInTheDocument();
  });
});

describe('trademark asset controls', () => {
  it('upload + delete render for a customer analyst', () => {
    mockAuth('client', 'analyst');
    renderWithProviders(<AssetsSection assets={[ASSET]} brandId="b1" />);
    expect(screen.getByRole('button', { name: /Upload image/ })).toBeInTheDocument();
    expect(screen.getByTitle('Remove asset')).toBeInTheDocument();
  });

  it('upload + delete render for staff that pass the gate (placeholder super_admin owner) — crossover', () => {
    mockAuth('super_admin', 'owner');
    renderWithProviders(<AssetsSection assets={[ASSET]} brandId="b1" />);
    expect(screen.getByRole('button', { name: /Upload image/ })).toBeInTheDocument();
    expect(screen.getByTitle('Remove asset')).toBeInTheDocument();
    expect(screen.queryByText(/Averrow console|Read-only for Averrow staff/)).not.toBeInTheDocument();
  });

  it('upload + delete are hidden for the read-only auditor seat and a customer viewer', () => {
    for (const [g, o] of [['auditor', 'owner'], ['client', 'viewer']] as const) {
      mockAuth(g, o);
      const { unmount } = renderWithProviders(<AssetsSection assets={[ASSET]} brandId="b1" />);
      expect(screen.queryByRole('button', { name: /Upload image/ })).not.toBeInTheDocument();
      expect(screen.queryByTitle('Remove asset')).not.toBeInTheDocument();
      expect(screen.getByText('Acme Mark')).toBeInTheDocument();
      unmount();
    }
  });
});

describe('takedown authorization sign/revoke gate', () => {
  it.each(['super_admin', 'admin', 'analyst', 'auditor'])('is false for staff role %s', (role) => {
    expect(canSignAuthorization(role, 'owner')).toBe(false);
    expect(canRevokeAuthorization(role, 'owner')).toBe(false);
  });

  it('is true for a customer org admin/owner only', () => {
    expect(canSignAuthorization('client', 'owner')).toBe(true);
    expect(canRevokeAuthorization('client', 'admin')).toBe(true);
    expect(canSignAuthorization('client', 'analyst')).toBe(false);
    expect(canRevokeAuthorization(undefined, 'viewer')).toBe(false);
  });
});

const DOMAIN_ROW: MaliciousDomainRow = {
  id: 'th1', threat_type: 'phishing', malicious_domain: 'acme-login.example', malicious_url: null,
  source_feed: 'urlhaus', severity: 'high', status: 'active', first_seen: '2026-10-01T00:00:00Z',
  last_seen: null, hosting_provider: null, country_code: null, takedown_status: null, takedown_id: null,
};

describe('domain findings "Request takedown" CTA', () => {
  it('renders for a customer analyst', () => {
    mockAuth('client', 'analyst');
    renderWithProviders(<MaliciousDomainsSection rows={[DOMAIN_ROW]} brandId="b1" brandName="Acme" />);
    expect(screen.getByRole('button', { name: 'Request takedown' })).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('is hidden for a customer viewer (no staff note)', () => {
    mockAuth('client', 'viewer');
    renderWithProviders(<MaliciousDomainsSection rows={[DOMAIN_ROW]} brandId="b1" brandName="Acme" />);
    expect(screen.queryByRole('button', { name: 'Request takedown' })).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it.each(['super_admin', 'admin', 'analyst', 'auditor'])('is hidden for staff role %s with the read-only note', (role) => {
    mockAuth(role, 'owner');
    renderWithProviders(<MaliciousDomainsSection rows={[DOMAIN_ROW]} brandId="b1" brandName="Acme" />);
    expect(screen.queryByRole('button', { name: 'Request takedown' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/Read-only for Averrow staff/);
    expect(screen.getByText('acme-login.example')).toBeInTheDocument();
  });
});
