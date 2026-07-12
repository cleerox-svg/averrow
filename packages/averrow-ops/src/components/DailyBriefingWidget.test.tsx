import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { DailyBriefingWidget } from './DailyBriefingWidget';

// Tier 4: honeypot.pageBreakdown is now capped server-side at top-20 by
// visits, with `pageBreakdownTotal` carrying the true distinct-page
// count. The widget renders a "Top 20 of N pages" caption when the
// briefing was actually capped, and defensively re-slices to 20 rows
// so a STALE cached briefing (generated before the backend change,
// still holding an unbounded pageBreakdown array) still renders capped.

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from '@/lib/api';

function page(n: number) {
  return { page: `/bait/page-${n}`, visits: 100 - n, bots: n };
}

function makeBriefing(overrides: Record<string, unknown> = {}) {
  return {
    platformOverview: {
      totalThreats: 1000, last24h: 10, last12h: 5, avgPerHour: 1,
      brandsMonitored: 5, brandsClassified: 5, todayCount: 10, yesterdayCount: 8,
    },
    honeypot: {
      totalVisits: 500, botVisits: 400, humanVisits: 100, visits12h: 20,
      pageBreakdown: [],
      pageBreakdownTotal: 0,
      recentBots: [],
      suspiciousHumans: [],
    },
    statusBadge: 'OPERATIONAL',
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockBriefingRow(briefing: unknown) {
  (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: {
      id: 1,
      type: 'daily',
      report_date: '2026-07-12',
      report_data: JSON.stringify(briefing),
      generated_at: new Date().toISOString(),
      trigger: 'cron',
      emailed: 1,
    },
  });
}

describe('DailyBriefingWidget — honeypot pageBreakdown caption + cap (Tier 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Top 20 of N pages" when the backend reports more distinct pages than the capped list', async () => {
    const pageBreakdown = Array.from({ length: 20 }, (_, i) => page(i));
    mockBriefingRow(makeBriefing({
      honeypot: {
        totalVisits: 500, botVisits: 400, humanVisits: 100, visits12h: 20,
        pageBreakdown,
        pageBreakdownTotal: 47,
        recentBots: [],
        suspiciousHumans: [],
      },
    }));
    renderWithProviders(<DailyBriefingWidget />);

    await waitFor(() => expect(screen.getByText('Top 20 of 47 pages')).toBeInTheDocument());
    // Exactly 20 rows rendered.
    expect(screen.getAllByText(/\/bait\/page-/).length).toBe(20);
  });

  it('does not append "of N" when the list already covers every distinct page', async () => {
    const pageBreakdown = Array.from({ length: 3 }, (_, i) => page(i));
    mockBriefingRow(makeBriefing({
      honeypot: {
        totalVisits: 30, botVisits: 20, humanVisits: 10, visits12h: 5,
        pageBreakdown,
        pageBreakdownTotal: 3,
        recentBots: [],
        suspiciousHumans: [],
      },
    }));
    renderWithProviders(<DailyBriefingWidget />);

    await waitFor(() => expect(screen.getAllByText(/\/bait\/page-/).length).toBe(3));
    expect(screen.queryByText(/Top 20 of/)).not.toBeInTheDocument();
  });

  it('defensively caps a stale cached briefing whose pageBreakdown predates the backend cap', async () => {
    // Simulates a briefing generated before the backend change landed:
    // an unbounded pageBreakdown array with no pageBreakdownTotal field.
    const stalePageBreakdown = Array.from({ length: 35 }, (_, i) => page(i));
    const staleBriefing = makeBriefing();
    (staleBriefing as { honeypot: Record<string, unknown> }).honeypot = {
      totalVisits: 900, botVisits: 700, humanVisits: 200, visits12h: 40,
      pageBreakdown: stalePageBreakdown,
      recentBots: [],
      suspiciousHumans: [],
      // pageBreakdownTotal intentionally omitted.
    };
    mockBriefingRow(staleBriefing);
    renderWithProviders(<DailyBriefingWidget />);

    await waitFor(() => expect(screen.getAllByText(/\/bait\/page-/).length).toBe(20));
  });
});
