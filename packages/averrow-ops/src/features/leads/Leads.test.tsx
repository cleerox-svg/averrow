import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { createMockLead } from '@/test/mocks';
import { Leads } from './Leads';

// Shared hook mocks.
const mocks = vi.hoisted(() => ({
  useLeads: vi.fn(),
  useLead: vi.fn(),
  useLeadStats: vi.fn(),
  useUpdateLead: vi.fn(),
  useRefreshLeadFirmographics: vi.fn(),
  useEnrichLead: vi.fn(),
}));

vi.mock('@/hooks/useLeads', () => ({
  useLeads: mocks.useLeads,
  useLead: mocks.useLead,
  useLeadStats: mocks.useLeadStats,
  useUpdateLead: mocks.useUpdateLead,
  useRefreshLeadFirmographics: mocks.useRefreshLeadFirmographics,
  useEnrichLead: mocks.useEnrichLead,
}));

// Stub the heavy detail sub-cards — out of scope for this behavior test.
vi.mock('./components/FirmographicsCard', () => ({ FirmographicsCard: () => null }));
vi.mock('./components/BuyingSignalsCard', () => ({ BuyingSignalsCard: () => null }));
vi.mock('./components/ScoreBreakdownCard', () => ({ ScoreBreakdownCard: () => null }));

const lead = createMockLead({ id: 99, company_name: 'Acme Corp', company_domain: 'acme.com', score_breakdown_json: null });

const correlatedScanLead = {
  id: 'scan_7',
  email: 'cto@acme.com',
  company: 'Acme Corp',
  status: 'new',
  created_at: new Date().toISOString(),
};

describe('Leads — cross-pipeline deep link + correlated scan lead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, '', '/leads?lead=99');
    mocks.useLeads.mockReturnValue({ data: { data: [lead] }, isLoading: false });
    mocks.useLead.mockReturnValue({ data: { ...lead, correlated_scan_lead: correlatedScanLead } });
    mocks.useLeadStats.mockReturnValue({ data: null });
    mocks.useUpdateLead.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useRefreshLeadFirmographics.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useEnrichLead.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it('auto-opens the lead detail from the ?lead= deep link', () => {
    renderWithProviders(<Leads />);
    // DrillHeader renders the company name as the detail title.
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('shows the reciprocal public-scan-lead card linking back to the scan lead', () => {
    renderWithProviders(<Leads />);
    expect(screen.getByText(/also a public scan lead/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view scan lead/i });
    expect(link).toHaveAttribute('href', '/leads?view=scan&lead=scan_7');
  });
});

describe('Leads — pipeline stat tiles', () => {
  it('shows display-cased stage labels, not raw enum values', () => {
    window.history.pushState({}, '', '/leads?view=pipeline');
    mocks.useLeads.mockReturnValue({ data: { data: [lead] }, isLoading: false });
    mocks.useLeadStats.mockReturnValue({ data: null });
    mocks.useUpdateLead.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithProviders(<Leads />);
    for (const label of ['New', 'Researched', 'Drafted', 'Meeting', 'Converted']) {
      expect(screen.getAllByText(label, { selector: '.ds-stat-label' }).length).toBe(1);
    }
    expect(screen.queryByText('meeting', { selector: '.ds-stat-label' })).not.toBeInTheDocument();
  });
});
