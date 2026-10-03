import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { BrandSocialFindings } from './BrandSocialFindings';
import type { SocialProfileRow } from '@/lib/socialModule';

// Proof-site coverage for the shared Badge: severity + classification render
// via the kit (theme-token colours, case-insensitive).

vi.mock('@/lib/socialModule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/socialModule')>();
  return { ...actual, useSocialModuleSummary: vi.fn(), useBrandSocialFindings: vi.fn() };
});

import { useSocialModuleSummary, useBrandSocialFindings } from '@/lib/socialModule';

const profile = (o: Partial<SocialProfileRow> = {}): SocialProfileRow => ({
  id: 'p1', brand_id: 'b1', platform: 'twitter', handle: 'acme_support',
  profile_url: null, display_name: null, bio: null, avatar_url: null,
  followers_count: null, verified: 0, classification: 'impersonation',
  classified_by: null, classification_confidence: null, classification_reason: null,
  ai_assessment: null, impersonation_score: 0, impersonation_signals: null,
  severity: 'CRITICAL', status: 'active', created_at: '2026-09-01T00:00:00Z', ...o,
});

function mockFindings(profiles: SocialProfileRow[]) {
  vi.mocked(useSocialModuleSummary).mockReturnValue({ data: undefined } as never);
  vi.mocked(useBrandSocialFindings).mockReturnValue({
    data: { brand_id: 'b1', profiles, page_size: 100 }, isLoading: false, error: null,
  } as never);
}

describe('BrandSocialFindings badges', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders severity (UPPERCASE source value) and classification badges', () => {
    mockFindings([profile()]);
    renderWithProviders(<BrandSocialFindings />);
    const row = screen.getByRole('article');
    // Uppercase DB value resolves to the Critical tone/label.
    const sev = within(row).getByText('Critical');
    expect(sev.getAttribute('style')).toContain('--sev-critical-text');
    const cls = within(row).getByText('impersonation');
    expect(cls.getAttribute('style')).toContain('--sev-critical-text');
  });

  it('renders each row with its own severity and classification', () => {
    mockFindings([
      profile({ id: 'p1', handle: 'one', severity: 'HIGH', classification: 'suspicious' }),
      profile({ id: 'p2', handle: 'two', severity: 'LOW', classification: 'official' }),
    ]);
    renderWithProviders(<BrandSocialFindings />);
    const [r1, r2] = screen.getAllByRole('article');
    expect(within(r1!).getByText('High')).toBeInTheDocument();
    expect(within(r1!).getByText('suspicious')).toBeInTheDocument();
    expect(within(r2!).getByText('Low')).toBeInTheDocument();
    expect(within(r2!).getByText('official')).toBeInTheDocument();
  });

  it('renders an unknown classification neutrally with its raw text, and an empty severity as an em dash', () => {
    mockFindings([profile({ classification: 'weird', severity: '' })]);
    renderWithProviders(<BrandSocialFindings />);
    const row = screen.getByRole('article');
    expect(within(row).getByText('weird').getAttribute('style')).toContain('var(--text-secondary)');
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('shows the empty state when there are no profiles', () => {
    mockFindings([]);
    renderWithProviders(<BrandSocialFindings />);
    expect(screen.getByText(/No social profiles tracked/)).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});
