import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { BrandDomainFindings } from './BrandDomainFindings';
import type {
  BrandFindings,
  DomainModuleSummary,
  LookalikeRow,
} from '@/lib/domainModule';

// Lane 3 Phase 3 step 15 — the tenant Domain Findings "Signals" column
// gains a page-content verdict chip alongside the existing DNS/WHOIS
// SignalChips. Mocks every data hook the page calls, same pattern as
// Executives.test.tsx, so the test drives loading/populated states
// directly without a real backend.

vi.mock('@/lib/domainModule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domainModule')>();
  return {
    ...actual,
    useDomainModuleSummary: vi.fn(),
    useBrandDomainFindings: vi.fn(),
    useRequestTakedown: vi.fn(),
  };
});

import {
  useDomainModuleSummary,
  useBrandDomainFindings,
  useRequestTakedown,
} from '@/lib/domainModule';

function makeRow(overrides: Partial<LookalikeRow> = {}): LookalikeRow {
  return {
    id: 'la-1',
    brand_id: 'brand-1',
    domain: 'acme-secure.com',
    permutation_type: 'homoglyph',
    registered: 1,
    resolves_to: '1.2.3.4',
    has_mx: 0,
    has_web: 1,
    first_seen: '2026-08-01T00:00:00Z',
    last_checked: '2026-09-01T00:00:00Z',
    threat_level: 'HIGH',
    ai_assessment: null,
    status: 'confirmed_threat',
    created_at: '2026-08-01T00:00:00Z',
    page_fetched_at: null,
    page_http_status: null,
    page_phishing_score: null,
    page_signals: null,
    page_anti_bot_wall: null,
    page_ai_signals: null,
    page_score_delta: null,
    page_generator: null,
    page_exfil_sink: null,
    page_exfil_sink_id: null,
    ...overrides,
  };
}

function mockFindings(lookalikes: LookalikeRow[]) {
  const findings: BrandFindings = {
    brand_id: 'brand-1',
    lookalikes,
    certs: [],
    malicious_domains: [],
    page_size: 100,
  };
  const summary: DomainModuleSummary = {
    org_id: 1,
    brands: [{
      brand_id: 'brand-1',
      brand_name: 'Acme Corp',
      canonical_domain: 'acme.com',
      lookalikes_total: lookalikes.length,
      lookalikes_registered: 0,
      lookalikes_critical: 0,
      lookalikes_high: 0,
      lookalikes_taken_down: 0,
      certs_total: 0,
      certs_suspicious: 0,
      certs_new: 0,
      certs_malicious: 0,
      malicious_threats_total: 0,
    }],
    totals: {
      lookalikes_total: lookalikes.length,
      lookalikes_registered: 0,
      lookalikes_critical: 0,
      lookalikes_high: 0,
      lookalikes_taken_down: 0,
      certs_total: 0,
      certs_suspicious: 0,
      certs_new: 0,
      certs_malicious: 0,
      malicious_threats_total: 0,
    },
  };
  vi.mocked(useDomainModuleSummary).mockReturnValue({ data: summary } as never);
  vi.mocked(useBrandDomainFindings).mockReturnValue({
    data: findings,
    isLoading: false,
    error: null,
  } as never);
  vi.mocked(useRequestTakedown).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  } as never);
}

describe('BrandDomainFindings — page-content Signals verdict chip', () => {
  it('shows "not scanned" (neutral) when page_fetched_at is null', () => {
    mockFindings([makeRow({ page_fetched_at: null })]);
    renderWithProviders(<BrandDomainFindings />);
    expect(screen.getByText('page: not scanned')).toBeInTheDocument();
  });

  it('a "not scanned" chip is not a button (nothing to open)', () => {
    mockFindings([makeRow({ page_fetched_at: null })]);
    renderWithProviders(<BrandDomainFindings />);
    expect(screen.queryByRole('button', { name: /view page-analysis detail/i })).not.toBeInTheDocument();
  });

  it('shows "clean" (a result, not an absence) when checked with no signals fired', () => {
    mockFindings([makeRow({
      page_fetched_at: '2026-09-10T00:00:00Z',
      page_signals: '[]',
      page_ai_signals: '[]',
    })]);
    renderWithProviders(<BrandDomainFindings />);
    expect(screen.getByText('page: clean')).toBeInTheDocument();
  });

  it('a "clean" chip is not distinguishable-as-scanning from "not scanned" by text alone — they render different labels', () => {
    mockFindings([
      makeRow({ id: 'la-clean', domain: 'clean.example.com', page_fetched_at: '2026-09-10T00:00:00Z', page_signals: '[]', page_ai_signals: '[]' }),
      makeRow({ id: 'la-unscanned', domain: 'unscanned.example.com', page_fetched_at: null }),
    ]);
    renderWithProviders(<BrandDomainFindings />);
    expect(screen.getByText('page: clean')).toBeInTheDocument();
    expect(screen.getByText('page: not scanned')).toBeInTheDocument();
  });

  it('shows the live score as a clickable chip when a live signal fired', async () => {
    mockFindings([makeRow({
      page_fetched_at: '2026-09-10T00:00:00Z',
      page_phishing_score: 75,
      page_signals: JSON.stringify(['credential_form', 'offdomain_form_exfil']),
      page_ai_signals: '[]',
    })]);
    renderWithProviders(<BrandDomainFindings />);
    expect(screen.getByText('page: 75')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /view page-analysis detail/i }));
    expect(screen.getByText('Page analysis')).toBeInTheDocument();
  });

  it('shows "shadow only" (not a score) when only shadow signals fired', () => {
    mockFindings([makeRow({
      page_fetched_at: '2026-09-10T00:00:00Z',
      page_phishing_score: 0,
      page_signals: '[]',
      page_ai_signals: JSON.stringify(['default_scaffold_title']),
    })]);
    renderWithProviders(<BrandDomainFindings />);
    expect(screen.getByText('page: shadow only')).toBeInTheDocument();
    expect(screen.queryByText('page: 0')).not.toBeInTheDocument();
  });

  describe('detail dialog — live/shadow split and defanging', () => {
    async function openDialog(row: Partial<LookalikeRow>) {
      mockFindings([makeRow(row)]);
      renderWithProviders(<BrandDomainFindings />);
      await userEvent.click(screen.getByRole('button', { name: /view page-analysis detail/i }));
    }

    it('renders scored signals with their weight, sorted by weight descending', async () => {
      await openDialog({
        page_fetched_at: '2026-09-10T00:00:00Z',
        page_phishing_score: 75,
        page_signals: JSON.stringify(['favicon_clone', 'offdomain_form_exfil', 'credential_form']),
      });
      const scoring = screen.getByTestId('tenant-scoring-signals');
      const items = within(scoring).getAllByRole('listitem');
      expect(items[0].textContent).toMatch(/Off-domain form exfil/);
      expect(items[1].textContent).toMatch(/Credential form present/);
      expect(items[2].textContent).toMatch(/Favicon cloned from brand/);
    });

    it('renders the shadow block distinctly, labeled "not scoring", and never inside the scoring group', async () => {
      await openDialog({
        page_fetched_at: '2026-09-10T00:00:00Z',
        page_phishing_score: 30,
        page_signals: JSON.stringify(['credential_form']),
        page_ai_signals: JSON.stringify(['covert_exfil_sink']),
        page_score_delta: 20,
      });
      expect(screen.getByText('Shadow signals — not scoring')).toBeInTheDocument();
      const scoring = screen.getByTestId('tenant-scoring-signals');
      const shadow = screen.getByTestId('tenant-shadow-signals');
      expect(within(shadow).getByText(/Covert exfil sink/)).toBeInTheDocument();
      expect(within(scoring).queryByText(/Covert exfil sink/)).not.toBeInTheDocument();
      expect(screen.getByText('would-be +20')).toBeInTheDocument();
    });

    it('a shadow key arriving via page_signals by mistake is filtered out of the scoring group', async () => {
      await openDialog({
        page_fetched_at: '2026-09-10T00:00:00Z',
        page_phishing_score: 30,
        page_signals: JSON.stringify(['credential_form', 'covert_exfil_sink']),
        page_ai_signals: '[]',
      });
      const scoring = screen.getByTestId('tenant-scoring-signals');
      expect(within(scoring).getByText('Credential form present')).toBeInTheDocument();
      expect(within(scoring).queryByText(/Covert exfil sink/)).not.toBeInTheDocument();
    });

    it('defangs the exfil sink host and never renders it as a link', async () => {
      await openDialog({
        page_fetched_at: '2026-09-10T00:00:00Z',
        page_phishing_score: 65,
        page_signals: JSON.stringify(['credential_form', 'offdomain_form_exfil']),
        page_exfil_sink: 'api.telegram.org',
        page_exfil_sink_id: '123456789',
      });
      expect(screen.getByText(/api\[\.\]telegram\[\.\]org/)).toBeInTheDocument();
      expect(screen.queryByText('api.telegram.org')).not.toBeInTheDocument();
      // Never a clickable link to attacker infrastructure.
      expect(screen.queryByRole('link', { name: /telegram/i })).not.toBeInTheDocument();
    });

    it('never exposes page_evidence in the tenant dialog (staff-only field, not in the client interface)', async () => {
      // page_evidence isn't even a field on the tenant LookalikeRow type —
      // this locks down that nothing downstream tries to read/render it.
      await openDialog({
        page_fetched_at: '2026-09-10T00:00:00Z',
        page_phishing_score: 30,
        page_signals: JSON.stringify(['credential_form']),
      });
      expect(screen.queryByText(/page_evidence/i)).not.toBeInTheDocument();
    });
  });
});
