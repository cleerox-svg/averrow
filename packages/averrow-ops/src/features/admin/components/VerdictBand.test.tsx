import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { VerdictBand } from './VerdictBand';
import type {
  DashboardSnapshot,
  DashboardFeedAtRisk,
} from '@/hooks/useDashboardSnapshot';

vi.mock('@/hooks/useDashboardSnapshot', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useDashboardSnapshot')>('@/hooks/useDashboardSnapshot');
  return { ...actual, useDashboardSnapshot: vi.fn() };
});

import { useDashboardSnapshot } from '@/hooks/useDashboardSnapshot';

interface SnapshotQueryMock {
  data?: DashboardSnapshot;
  isLoading?: boolean;
  isError?: boolean;
}

const healthySnapshot: DashboardSnapshot = {
  threat_health: {
    threats: { total: 100, today: 5, week: 30 },
    agents_24h: { total: 10, successes: 10, errors: 0 },
    feeds_24h: { pulls: 20, ingested: 200 },
    active_sessions: 3,
    trend_14d: [],
  },
  budget: {
    status: {
      config: { monthly_limit_usd: 100, soft_pct: 70, hard_pct: 90, emergency_pct: 98 },
      spent_this_month: 12,
      remaining: 88,
      pct_used: 12,
      throttle_level: 'none',
      days_in_month: 30,
      days_elapsed: 10,
      daily_burn_rate: 1.2,
      projected_monthly: 36,
      anthropic_reported: 12,
    },
    top_agents: [],
  },
  feeds: {
    at_risk_count: 0,
    at_risk: [],
    totals_24h: { total_pulls: 20, total_success: 20, total_failed: 0, feeds_active: 5 },
  },
  pipeline: {
    worst_tone: 'ok',
    needs_attention_count: 0,
    total_pipelines: 5,
    concerning: [],
  },
  email_security: null,
  generated_at: '2026-07-11T00:00:00Z',
};

function mockSnapshot(overrides: { data?: Partial<DashboardSnapshot>; isLoading?: boolean; isError?: boolean } = {}) {
  const { data, ...rest } = overrides;
  const merged: SnapshotQueryMock = {
    data: data === undefined ? healthySnapshot : { ...healthySnapshot, ...data },
    isLoading: false,
    isError: false,
    ...rest,
  };
  (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue(merged);
}

function makeAtRiskRow(overrides: Partial<DashboardFeedAtRisk> = {}): DashboardFeedAtRisk {
  return {
    feed_name: 'feed_a',
    display_name: 'Feed A',
    severity: 'high',
    verdict: { tone: 'failed', label: 'CRITICAL' },
    failure_rate_pct: 35,
    pct_to_auto_pause: 40,
    enabled: true,
    paused_reason: null,
    ...overrides,
  };
}

/** Finds the contributor Link by the badge label prefix (e.g. "Agents:")
 *  and returns its resolved href, so deep-link assertions read the actual
 *  rendered `to` target rather than re-deriving it from the component. */
function hrefForContributor(labelPrefix: string): string | null {
  const node = screen.getByText(new RegExp(`^${labelPrefix}:`));
  const link = node.closest('a');
  return link ? link.getAttribute('href') : null;
}

describe('VerdictBand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows OPERATIONAL when every slice is present and healthy', () => {
    mockSnapshot();
    renderWithProviders(<VerdictBand />);
    expect(screen.getByText('OPERATIONAL')).toBeInTheDocument();
  });

  it('never shows OPERATIONAL while the whole snapshot is still loading (unknown != ok)', () => {
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderWithProviders(<VerdictBand />);
    expect(screen.queryByText('OPERATIONAL')).not.toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
  });

  it('never shows OPERATIONAL when the snapshot request errored', () => {
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderWithProviders(<VerdictBand />);
    expect(screen.queryByText('OPERATIONAL')).not.toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
  });

  it('a whole-snapshot failure makes every contributor read unknown, not just one', () => {
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderWithProviders(<VerdictBand />);
    expect(screen.getByText(/Agents:\s*status pending/)).toBeInTheDocument();
    expect(screen.getByText(/AI budget:\s*status pending/)).toBeInTheDocument();
    expect(screen.getByText(/Feeds:\s*status pending/)).toBeInTheDocument();
    expect(screen.getByText(/Pipelines:\s*status pending/)).toBeInTheDocument();
  });

  // ─── Plain-admin shape: threat_health null, everything else populated ──
  // This is exactly what handleAdminDashboard returns for a non-super_admin
  // (RBAC gate on the threat_health source) — the snapshot itself loaded
  // fine, only that one slice is absent.
  describe('threat_health null (plain admin)', () => {
    it('agents unknown, rest resolved -> overall PENDING (not masked to OPERATIONAL)', () => {
      mockSnapshot({ data: { threat_health: null } });
      renderWithProviders(<VerdictBand />);
      expect(screen.queryByText('OPERATIONAL')).not.toBeInTheDocument();
      expect(screen.getByText('PENDING')).toBeInTheDocument();
      expect(screen.getByText(/Agents:\s*status pending/)).toBeInTheDocument();
    });

    it('a real critical signal still wins over the unresolved agents contributor', () => {
      mockSnapshot({
        data: {
          threat_health: null,
          budget: { ...healthySnapshot.budget!, status: { ...healthySnapshot.budget!.status, throttle_level: 'emergency', pct_used: 99 } },
        },
      });
      renderWithProviders(<VerdictBand />);
      expect(screen.getByText('CRITICAL')).toBeInTheDocument();
      expect(screen.queryByText('PENDING')).not.toBeInTheDocument();
    });
  });

  // ─── Worst-of severity matrix — table-driven ────────────────────────
  describe('worst-of severity matrix', () => {
    const cases: Array<{
      name: string;
      data: Partial<DashboardSnapshot>;
      expectLabel: string;
    }> = [
      { name: 'all slices ok -> OPERATIONAL', data: {}, expectLabel: 'OPERATIONAL' },
      {
        name: 'agent errors alone -> HIGH',
        data: { threat_health: { ...healthySnapshot.threat_health!, agents_24h: { total: 10, successes: 8, errors: 2 } } },
        expectLabel: 'HIGH',
      },
      {
        name: 'budget soft throttle alone -> MEDIUM',
        data: { budget: { ...healthySnapshot.budget!, status: { ...healthySnapshot.budget!.status, throttle_level: 'soft', pct_used: 82 } } },
        expectLabel: 'MEDIUM',
      },
      {
        name: 'budget hard throttle alone -> HIGH',
        data: { budget: { ...healthySnapshot.budget!, status: { ...healthySnapshot.budget!.status, throttle_level: 'hard', pct_used: 93 } } },
        expectLabel: 'HIGH',
      },
      {
        name: 'budget emergency throttle alone -> CRITICAL',
        data: { budget: { ...healthySnapshot.budget!, status: { ...healthySnapshot.budget!.status, throttle_level: 'emergency', pct_used: 99 } } },
        expectLabel: 'CRITICAL',
      },
      {
        name: "feeds at-risk with a backend severity:'high' row -> HIGH",
        data: { feeds: { at_risk_count: 1, at_risk: [makeAtRiskRow({ severity: 'high', verdict: { tone: 'failed', label: 'CRITICAL' } })], totals_24h: healthySnapshot.feeds!.totals_24h } },
        expectLabel: 'HIGH',
      },
      {
        name: "feeds at-risk with a backend severity:'critical' row -> CRITICAL",
        data: { feeds: { at_risk_count: 1, at_risk: [makeAtRiskRow({ severity: 'critical', verdict: { tone: 'failed', label: 'AT RISK' }, pct_to_auto_pause: 85 })], totals_24h: healthySnapshot.feeds!.totals_24h } },
        expectLabel: 'CRITICAL',
      },
      {
        name: 'an auto-paused-from-failures feed (severity:critical, enabled:false) -> CRITICAL, never OPERATIONAL — the regression this fix pass closed',
        data: {
          feeds: {
            at_risk_count: 1,
            at_risk: [makeAtRiskRow({
              severity: 'critical',
              enabled: false,
              paused_reason: 'auto:consecutive_failures',
              verdict: { tone: 'failed', label: 'PAUSED' },
            })],
            totals_24h: healthySnapshot.feeds!.totals_24h,
          },
        },
        expectLabel: 'CRITICAL',
      },
      {
        name: 'feeds at-risk count exceeds the visible (capped) rows -> CRITICAL, never silently downgraded',
        data: { feeds: { at_risk_count: 25, at_risk: [makeAtRiskRow({ severity: 'high' })], totals_24h: healthySnapshot.feeds!.totals_24h } },
        expectLabel: 'CRITICAL',
      },
      {
        name: "pipeline worst_tone 'warning' alone -> MEDIUM",
        data: { pipeline: { worst_tone: 'warning', needs_attention_count: 2, total_pipelines: 5, concerning: [] } },
        expectLabel: 'MEDIUM',
      },
      {
        name: "pipeline worst_tone 'critical' alone -> HIGH",
        data: { pipeline: { worst_tone: 'critical', needs_attention_count: 1, total_pipelines: 5, concerning: [] } },
        expectLabel: 'HIGH',
      },
      {
        name: "pipeline worst_tone 'unknown' (no pipelines reported) -> PENDING, not OPERATIONAL",
        data: { pipeline: { worst_tone: 'unknown', needs_attention_count: 0, total_pipelines: 0, concerning: [] } },
        expectLabel: 'PENDING',
      },
      {
        name: "benign geoip pipeline (worst_tone:'ok', needs_attention_count:0) does NOT degrade the band",
        data: { pipeline: { worst_tone: 'ok', needs_attention_count: 0, total_pipelines: 5, concerning: [] } },
        expectLabel: 'OPERATIONAL',
      },
      {
        name: 'feeds critical + agent errors together -> the worse of the two (CRITICAL) wins',
        data: {
          threat_health: { ...healthySnapshot.threat_health!, agents_24h: { total: 10, successes: 8, errors: 2 } },
          feeds: { at_risk_count: 1, at_risk: [makeAtRiskRow({ severity: 'critical', verdict: { tone: 'failed', label: 'AT RISK' }, pct_to_auto_pause: 85 })], totals_24h: healthySnapshot.feeds!.totals_24h },
        },
        expectLabel: 'CRITICAL',
      },
    ];

    it.each(cases)('$name', ({ data, expectLabel }) => {
      mockSnapshot({ data });
      renderWithProviders(<VerdictBand />);
      expect(screen.getByText(expectLabel)).toBeInTheDocument();
      // OPERATIONAL and PENDING are unique to the overall pill (no
      // contributor badge ever renders those words), so asserting their
      // absence when unexpected directly locks the two failure modes this
      // component exists to prevent: reading green with an unresolved
      // signal, and reading "pending" when a real severity should win.
      if (expectLabel !== 'OPERATIONAL') {
        expect(screen.queryByText('OPERATIONAL')).not.toBeInTheDocument();
      }
      if (expectLabel !== 'PENDING') {
        expect(screen.queryByText('PENDING')).not.toBeInTheDocument();
      }
    });
  });

  // ─── Individual contributor deep-links ─────────────────────────
  describe('contributor deep-links', () => {
    it('links the Agents contributor to /agents', () => {
      mockSnapshot();
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('Agents')).toBe('/agents');
    });

    it('links the AI budget contributor to /admin#budget-panel', () => {
      mockSnapshot();
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('AI budget')).toBe('/admin#budget-panel');
    });

    it('links the Feeds contributor to /admin/metrics?tab=feed-failures', () => {
      mockSnapshot();
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('Feeds')).toBe('/admin/metrics?tab=feed-failures');
    });

    it('links the Pipelines contributor to /admin/metrics?tab=pipelines', () => {
      mockSnapshot();
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('Pipelines')).toBe('/admin/metrics?tab=pipelines');
    });

    it('keeps the same deep-link targets even when threat_health is null', () => {
      mockSnapshot({ data: { threat_health: null } });
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('Feeds')).toBe('/admin/metrics?tab=feed-failures');
      expect(hrefForContributor('Agents')).toBe('/agents');
    });
  });

  // ─── Feed tiering edge cases ─────────────────────────────────────────
  // Prior to the Tier 2a fix pass, an auto-paused-from-failures feed could
  // report at_risk_count:0 (the old contract's computeFeedVerdict returned
  // PAUSED before either AT-RISK/CRITICAL label applied, so a dead feed
  // fell out of at_risk entirely) — the band read OPERATIONAL while a feed
  // was dead. That was the bug. The current contract guarantees ALL
  // critical+high feeds, including auto-paused ones, are counted in
  // at_risk_count and appear in `at_risk` with severity:'critical', so this
  // scenario can no longer produce at_risk_count:0 — see the
  // 'auto-paused-from-failures feed' case in the severity matrix above,
  // which locks the fixed behavior (CRITICAL, never OPERATIONAL).
  it('at_risk_count 0 (genuinely no feeds flagged) stays OPERATIONAL', () => {
    mockSnapshot({ data: { feeds: { at_risk_count: 0, at_risk: [], totals_24h: healthySnapshot.feeds!.totals_24h } } });
    renderWithProviders(<VerdictBand />);
    expect(screen.getByText('OPERATIONAL')).toBeInTheDocument();
  });

});
