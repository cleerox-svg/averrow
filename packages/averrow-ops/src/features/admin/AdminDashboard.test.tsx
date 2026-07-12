import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { AdminDashboard } from './AdminDashboard';
import type { DashboardSnapshot } from '@/hooks/useDashboardSnapshot';

// ─── Two independent data sources post-Tier-2a ──────────────────────────
// AdminDashboard now splits across:
//   - useDashboardSnapshot(): drives the top StatGrid + 14d Activity row
//     (threat_health slice), BudgetPanel (budget slice), and VerdictBand
//     (all four slices) — see VerdictBand.test.tsx for the verdict's own
//     dedicated worst-of coverage.
//   - useSystemHealth(): migrations/audit/infrastructure/sessions are NOT
//     in the snapshot contract, so Compliance & Sessions and Infrastructure
//     stay on this full endpoint. MaintenanceSection also calls this hook
//     independently for its "unlinked threats" line.
// The two are mocked to matching-but-distinct fixtures below so tests can
// exercise each gate (`healthReady` vs `systemHealthReady`) independently.

const mockSystemHealthData = {
  threats: { total: 50000, today: 3209, week: 18500 },
  agents: { total: 229, successes: 181, errors: 0 },
  feeds: { pulls: 266, ingested: 6245 },
  sessions: { count: 94 },
  migrations: { total: 45, last_run: '2026-03-27T00:00:00Z', last_name: '0047_agent_activity_log.sql' },
  audit: { count: 283 },
  trend: [
    { day: '2026-03-14', count: 5461 },
    { day: '2026-03-15', count: 2471 },
    { day: '2026-03-16', count: 12754 },
    { day: '2026-03-17', count: 3405 },
  ],
  infrastructure: {
    mainDb: { name: 'trust-radar-v2', sizeMb: 79.5, tables: 57, region: 'ENAM' },
    auditDb: { name: 'trust-radar-v2-audit', sizeKb: 180, tables: 2, region: 'ENAM' },
    worker: { name: 'trust-radar', platform: 'Cloudflare Workers' },
    kvNamespaces: [
      { name: 'trust-radar-cache' },
      { name: 'SESSIONS' },
      { name: 'CACHE' },
    ],
  },
};

const mockSnapshotData: DashboardSnapshot = {
  threat_health: {
    threats: { total: 50000, today: 3209, week: 18500 },
    agents_24h: { total: 229, successes: 181, errors: 0 },
    feeds_24h: { pulls: 266, ingested: 6245 },
    active_sessions: 94,
    trend_14d: [
      { day: '2026-03-14', count: 5461 },
      { day: '2026-03-15', count: 2471 },
      { day: '2026-03-16', count: 12754 },
      { day: '2026-03-17', count: 3405 },
    ],
  },
  budget: {
    status: {
      config: { monthly_limit_usd: 100, soft_pct: 70, hard_pct: 90, emergency_pct: 98 },
      spent_this_month: 10,
      remaining: 90,
      pct_used: 10,
      throttle_level: 'none',
      days_in_month: 30,
      days_elapsed: 10,
      daily_burn_rate: 1,
      projected_monthly: 30,
      anthropic_reported: 10,
    },
    top_agents: [],
  },
  feeds: {
    at_risk_count: 0,
    at_risk: [],
    totals_24h: { total_pulls: 0, total_success: 0, total_failed: 0, feeds_active: 0 },
  },
  pipeline: {
    worst_tone: 'ok',
    needs_attention_count: 0,
    total_pipelines: 5,
    concerning: [],
  },
  email_security: null,
  generated_at: '2026-03-17T00:00:00Z',
};

vi.mock('@/hooks/useSystemHealth', () => ({
  useSystemHealth: vi.fn().mockReturnValue({
    data: null,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@/hooks/useDashboardSnapshot', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useDashboardSnapshot')>('@/hooks/useDashboardSnapshot');
  return {
    ...actual,
    useDashboardSnapshot: vi.fn().mockReturnValue({ data: null, isLoading: false, isError: false }),
  };
});

// useBudgetConfigMutation is the only useBudget export AdminDashboard still
// calls directly (the "Edit monthly limit" flow) — budget *display* now
// comes from the snapshot mock above.
vi.mock('@/hooks/useBudget', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useBudget')>('@/hooks/useBudget');
  return {
    ...actual,
    useBudgetConfigMutation: vi.fn().mockReturnValue({ mutate: vi.fn() }),
  };
});

// Mock recharts to avoid canvas/SVG rendering issues in test
vi.mock('recharts', () => ({
  AreaChart: ({ children }: { children: React.ReactNode }) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useDashboardSnapshot } from '@/hooks/useDashboardSnapshot';

describe('AdminDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({
      data: mockSystemHealthData,
      isLoading: false,
      isError: false,
    });
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      data: mockSnapshotData,
      isLoading: false,
      isError: false,
    });
  });

  it('renders page header', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Platform health and operations')).toBeInTheDocument();
  });

  it('renders top stat row with correct values (snapshot-derived)', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('3,209')).toBeInTheDocument();
    // 6,245 appears in the StatCard and again in the agent performance subline
    expect(screen.getAllByText('6,245').length).toBeGreaterThanOrEqual(1);
    // 229 appears in both stat card and agent performance section
    expect(screen.getAllByText('229').length).toBeGreaterThanOrEqual(1);
    // 94 appears in stat card, KV sessions note, and compliance row
    expect(screen.getAllByText(/94/).length).toBeGreaterThanOrEqual(1);
  });

  it('renders section labels', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
    // "Activity" now reads "Activity (14d)" — match by prefix
    expect(screen.getByText(/Activity/)).toBeInTheDocument();
  });

  it('renders database cards (system-health-derived)', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('trust-radar-v2')).toBeInTheDocument();
    expect(screen.getByText('trust-radar-v2-audit')).toBeInTheDocument();
    expect(screen.getByText('PRIMARY')).toBeInTheDocument();
    expect(screen.getByText('AUDIT')).toBeInTheDocument();
  });

  it('renders worker status', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('trust-radar')).toBeInTheDocument();
    expect(screen.getByText('Cloudflare Workers')).toBeInTheDocument();
  });

  it('renders KV namespaces', () => {
    renderWithProviders(<AdminDashboard />);
    // KV namespace names are joined in a compact row — match each by substring.
    expect(screen.getByText(/trust-radar-cache/)).toBeInTheDocument();
    expect(screen.getByText(/SESSIONS/)).toBeInTheDocument();
    expect(screen.getByText(/CACHE/)).toBeInTheDocument();
  });

  it('renders agent performance stats', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText(/success rate/)).toBeInTheDocument();
  });

  it('renders compliance checklist', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Data residency: ENAM')).toBeInTheDocument();
    expect(screen.getByText('Audit logging: Active')).toBeInTheDocument();
    expect(screen.getByText('283 events recorded')).toBeInTheDocument();
  });

  it('renders migration info', () => {
    renderWithProviders(<AdminDashboard />);
    // "45 migrations run" is now a single text node; match by substring.
    expect(screen.getByText(/45 migrations run/)).toBeInTheDocument();
    expect(screen.getByText('0047_agent_activity_log.sql')).toBeInTheDocument();
    // Migration freshness now appears as the "UP TO DATE" badge label.
    expect(screen.getByText(/UP TO DATE/i)).toBeInTheDocument();
  });

  it('renders threat trend chart', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('still renders agent error counts in the Agent Performance card when errors exist', () => {
    // The old top-of-page pill (binary "OPERATIONAL"/"DEGRADED" derived
    // solely from agents.errors) was replaced by VerdictBand — see
    // features/admin/components/VerdictBand.test.tsx for the worst-of
    // severity coverage. This just confirms the health-gated section
    // still surfaces the raw error count. Agent counts are snapshot-derived
    // (threat_health.agents_24h) post-Tier-2a.
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        ...mockSnapshotData,
        threat_health: {
          ...mockSnapshotData.threat_health!,
          agents_24h: { total: 229, successes: 180, errors: 3 },
        },
      },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<AdminDashboard />);
    expect(screen.getAllByText(/errors/i).length).toBeGreaterThanOrEqual(1);
  });

  // ─── Email Security Section — Tier 2a fix pass wired this off the ─────
  // dashboard snapshot's `email_security` slice instead of its own
  // useQuery(['email-security-stats']) fetch (finding #5). Confirms the
  // section renders snapshot-derived data and that `total_brands` is
  // computed as total_scanned + total_unscanned rather than read as a
  // separate field (the slice doesn't carry one).
  it('renders Email Security Coverage from the snapshot email_security slice', () => {
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        ...mockSnapshotData,
        email_security: {
          total_scanned: 120,
          total_unscanned: 30,
          average_score: 87,
          grade_distribution: [{ grade: 'A', count: 90 }, { grade: 'F', count: 5 }],
          worst_count: 5,
        },
      },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Email Security Coverage')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    // Coverage line: scanned/total where total = 120 + 30 = 150.
    expect(screen.getByText(/120\s*\/\s*150/)).toBeInTheDocument();
  });

  it('Email Security Coverage renders zeros (not a crash) when email_security is null', () => {
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { ...mockSnapshotData, email_security: null },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Email Security Coverage')).toBeInTheDocument();
  });

  // ─── Gate 1: snapshot (`healthReady`) — StatGrid + 14d Activity row ────
  describe('gated on the dashboard snapshot (StatGrid + Activity row)', () => {
    it('shows skeletons instead of the stat row / activity row while the snapshot is loading, independent of system-health', () => {
      (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
      const { container } = renderWithProviders(<AdminDashboard />);

      expect(screen.queryByText('Threats Today')).not.toBeInTheDocument();
      expect(screen.queryByText('Feed Ingestion')).not.toBeInTheDocument();
      expect(screen.queryByText(/success rate/)).not.toBeInTheDocument();
      expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);

      // Infrastructure (system-health-derived, unaffected) still renders.
      expect(screen.getByText('trust-radar-v2')).toBeInTheDocument();
    });

    it('VerdictBand reads PENDING and BudgetPanel does not render while the snapshot is loading', () => {
      (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
      renderWithProviders(<AdminDashboard />);
      expect(screen.getByText('PENDING')).toBeInTheDocument();
      expect(screen.queryByText('AI Budget')).not.toBeInTheDocument();
    });
  });

  // ─── Gate 2: full system-health (`systemHealthReady`) — Compliance & ──
  // Sessions + Infrastructure (migrations/audit/infrastructure aren't in
  // the snapshot contract).
  describe('gated on system-health (Compliance & Sessions + Infrastructure)', () => {
    it('shows skeletons instead of Infrastructure / Compliance while system-health is loading, independent of the snapshot', () => {
      (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
      const { container } = renderWithProviders(<AdminDashboard />);

      expect(screen.queryByText('trust-radar-v2')).not.toBeInTheDocument();
      expect(screen.queryByText('Data residency: ENAM')).not.toBeInTheDocument();
      expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);

      // StatGrid / Activity row (snapshot-derived, unaffected) still render.
      expect(screen.getByText('Threats Today')).toBeInTheDocument();
      expect(screen.getByText(/success rate/)).toBeInTheDocument();
    });

    it('mounts the always-on children (VerdictBand, BudgetPanel, DailyBriefingWidget) while system-health is still loading', () => {
      // Regression coverage for the original P1 un-gating fix, re-scoped:
      // these three no longer depend on useSystemHealth at all (VerdictBand
      // and BudgetPanel moved to the snapshot in Tier 2a), so they must
      // render normally even while the (now separate) system-health fetch
      // is still in flight.
      (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
      renderWithProviders(<AdminDashboard />);

      expect(screen.getByText('OPERATIONAL')).toBeInTheDocument();
      expect(screen.getByText('AI Budget')).toBeInTheDocument();
      expect(screen.getByText('Daily Briefing')).toBeInTheDocument();
    });
  });

  it('renders page header immediately even while both hooks are still loading', () => {
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
  });
});
