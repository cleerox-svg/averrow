// Regression coverage for the Jul 2026 "/v2/" root-route outage:
// /api/v1/public/platform-status transiently returned the generic error
// envelope {success:false, error:"..."} instead of a PlatformStatus body.
// usePlatformStatus used to blind-cast that response, so `data.overall`
// was `undefined` and PALETTE[status] resolved to `undefined` — the badge
// then dereferenced `palette.dot` and crashed the whole page.
//
// The fix has two independent layers, both locked here:
//   1. usePlatformStatus narrows the response shape and returns `null`
//      instead of a fake PlatformStatus (src/hooks/usePlatformStatus.ts).
//   2. PlatformStatusBadge's `PALETTE[status] ?? PALETTE.loading` is now a
//      total lookup — even if an unexpected status string ever reached it,
//      the component would still render instead of throwing.
//
// Mocking pattern follows VerdictBand.test.tsx / FeedFailures.test.tsx:
// vi.mock the hook module, drive it via mockReturnValue per case.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { PlatformStatusBadge } from './PlatformStatusBadge';
import type { CategoryStatus, PlatformStatus } from '@averrow/shared';

vi.mock('@/hooks/usePlatformStatus', () => ({ usePlatformStatus: vi.fn() }));

import { usePlatformStatus } from '@/hooks/usePlatformStatus';

function mockStatus(overrides: { data?: PlatformStatus | null; isLoading?: boolean }) {
  (usePlatformStatus as ReturnType<typeof vi.fn>).mockReturnValue({
    data: null,
    isLoading: false,
    ...overrides,
  });
}

function makeStatus(overall: CategoryStatus): PlatformStatus {
  return {
    generated_at: '2026-07-13T00:00:00Z',
    overall,
    overall_note: 'test',
    categories: [],
    window_days: 30,
  };
}

describe('PlatformStatusBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the neutral Checking… state without throwing when the hook returns data:null, isLoading:false (post-fix malformed-response behavior)', () => {
    mockStatus({ data: null, isLoading: false });
    expect(() => renderWithProviders(<PlatformStatusBadge />)).not.toThrow();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('renders Checking… while the query is loading', () => {
    mockStatus({ data: null, isLoading: true });
    renderWithProviders(<PlatformStatusBadge />);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('renders "All systems operational" for a valid operational status', () => {
    mockStatus({ data: makeStatus('operational'), isLoading: false });
    renderWithProviders(<PlatformStatusBadge />);
    expect(screen.getByText('All systems operational')).toBeInTheDocument();
  });

  it('renders "Outage" for a valid outage status', () => {
    mockStatus({ data: makeStatus('outage'), isLoading: false });
    renderWithProviders(<PlatformStatusBadge />);
    expect(screen.getByText('Outage')).toBeInTheDocument();
  });

  it('renders "Degraded" for a valid degraded status', () => {
    mockStatus({ data: makeStatus('degraded'), isLoading: false });
    renderWithProviders(<PlatformStatusBadge />);
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('the crux of the regression: an unexpected status string reaching the palette lookup falls back to Checking… instead of crashing', () => {
    // Simulates a future malformed/unrecognized `overall` value slipping
    // past the hook's guard (e.g. a new backend status enum member the
    // frontend hasn't shipped yet) reaching PlatformStatusBadge's
    // `PALETTE[status] ?? PALETTE.loading` total lookup.
    const bogusStatus = { ...makeStatus('operational'), overall: 'unknown_future_state' } as unknown as PlatformStatus;
    mockStatus({ data: bogusStatus, isLoading: false });
    expect(() => renderWithProviders(<PlatformStatusBadge />)).not.toThrow();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('renders without throwing in the prominent variant too, for the malformed-response case', () => {
    mockStatus({ data: null, isLoading: false });
    expect(() => renderWithProviders(<PlatformStatusBadge variant="prominent" />)).not.toThrow();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  // Facelift (Phase 6 screen 2): static, token-coloured, no glow or loop.
  describe.each(['compact', 'prominent'] as const)('%s variant look', (variant) => {
    it.each(['operational', 'degraded', 'outage'] as const)('%s: no animation, no hex/rgb colour, no glow', (overall) => {
      mockStatus({ data: makeStatus(overall), isLoading: false });
      const { container } = renderWithProviders(<PlatformStatusBadge variant={variant} />);
      const html = container.innerHTML;
      expect(html).not.toMatch(/animation/i);
      expect(html).not.toMatch(/infinite/i);
      expect(html).not.toMatch(/live-ping/);
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(html).not.toMatch(/rgba?\(/i);
      expect(html).not.toMatch(/box-shadow|text-shadow/i);
      expect(html).toMatch(/var\(--/);
    });

    it('uses sans sentence case, not mono or uppercase', () => {
      mockStatus({ data: makeStatus('operational'), isLoading: false });
      renderWithProviders(<PlatformStatusBadge variant={variant} />);
      const label = screen.getByText('All systems operational');
      expect(label.style.fontFamily).toBe('var(--font-sans)');
      expect(label.style.textTransform).toBe('');
      expect(label.style.textShadow).toBe('');
    });
  });

  it('colours the label with the theme-aware status text tokens', () => {
    mockStatus({ data: makeStatus('degraded'), isLoading: false });
    renderWithProviders(<PlatformStatusBadge />);
    expect(screen.getByText('Degraded').style.color).toBe('var(--sev-medium-text)');
  });
});
