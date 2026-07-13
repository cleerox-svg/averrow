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

  it('renders the neutral CHECKING… state without throwing when the hook returns data:null, isLoading:false (post-fix malformed-response behavior)', () => {
    mockStatus({ data: null, isLoading: false });
    expect(() => renderWithProviders(<PlatformStatusBadge />)).not.toThrow();
    expect(screen.getByText('CHECKING…')).toBeInTheDocument();
  });

  it('renders CHECKING… while the query is loading', () => {
    mockStatus({ data: null, isLoading: true });
    renderWithProviders(<PlatformStatusBadge />);
    expect(screen.getByText('CHECKING…')).toBeInTheDocument();
  });

  it('renders "ALL SYSTEMS OPERATIONAL" for a valid operational status', () => {
    mockStatus({ data: makeStatus('operational'), isLoading: false });
    renderWithProviders(<PlatformStatusBadge />);
    expect(screen.getByText('ALL SYSTEMS OPERATIONAL')).toBeInTheDocument();
  });

  it('renders "OUTAGE" for a valid outage status', () => {
    mockStatus({ data: makeStatus('outage'), isLoading: false });
    renderWithProviders(<PlatformStatusBadge />);
    expect(screen.getByText('OUTAGE')).toBeInTheDocument();
  });

  it('renders "DEGRADED" for a valid degraded status', () => {
    mockStatus({ data: makeStatus('degraded'), isLoading: false });
    renderWithProviders(<PlatformStatusBadge />);
    expect(screen.getByText('DEGRADED')).toBeInTheDocument();
  });

  it('the crux of the regression: an unexpected status string reaching the palette lookup falls back to CHECKING… instead of crashing', () => {
    // Simulates a future malformed/unrecognized `overall` value slipping
    // past the hook's guard (e.g. a new backend status enum member the
    // frontend hasn't shipped yet) reaching PlatformStatusBadge's
    // `PALETTE[status] ?? PALETTE.loading` total lookup.
    const bogusStatus = { ...makeStatus('operational'), overall: 'unknown_future_state' } as unknown as PlatformStatus;
    mockStatus({ data: bogusStatus, isLoading: false });
    expect(() => renderWithProviders(<PlatformStatusBadge />)).not.toThrow();
    expect(screen.getByText('CHECKING…')).toBeInTheDocument();
  });

  it('renders without throwing in the prominent variant too, for the malformed-response case', () => {
    mockStatus({ data: null, isLoading: false });
    expect(() => renderWithProviders(<PlatformStatusBadge variant="prominent" />)).not.toThrow();
    expect(screen.getByText('CHECKING…')).toBeInTheDocument();
  });
});
