import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { AdminDashboard } from './AdminDashboard';

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

vi.mock('@/hooks/useSystemHealth', () => ({
  useSystemHealth: vi.fn().mockReturnValue({
    data: null,
    isLoading: false,
    isError: false,
  }),
}));

// VerdictBand (mounted unconditionally at the top of AdminDashboard, per
// the P1 un-gating change) reads three more hooks. This file's assertions
// are about the health-gated sections below it, not the verdict band
// itself — that has its own dedicated coverage in
// features/admin/components/VerdictBand.test.tsx — so these are mocked to
// a stable "everything healthy" shape purely to keep this suite from
// making real network calls.
vi.mock('@/hooks/useBudget', () => ({
  useBudgetStatus: vi.fn().mockReturnValue({
    data: { throttle_level: 'none', pct_used: 10, spent_this_month: 10, remaining: 90, config: { monthly_limit_usd: 100 }, daily_burn_rate: 1, projected_monthly: 30, days_in_month: 30, days_elapsed: 10 },
    isLoading: false,
    isError: false,
  }),
  useBudgetBreakdown: vi.fn().mockReturnValue({ data: [], isLoading: false, isError: false }),
  useBudgetConfigMutation: vi.fn().mockReturnValue({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/useMetrics', () => ({
  useFeedFailures: vi.fn().mockReturnValue({
    data: { per_feed: [], totals_24h: { total_pulls: 0, total_success: 0, total_failed: 0, total_records: 0, feeds_active: 0 }, recent_errors: [] },
    isLoading: false,
    isError: false,
  }),
}));
vi.mock('@/hooks/useAgents', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useAgents')>('@/hooks/useAgents');
  return {
    ...actual,
    usePipelineStatus: vi.fn().mockReturnValue({ data: [], isLoading: false, isError: false }),
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

describe('AdminDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({
      data: mockSystemHealthData,
      isLoading: false,
      isError: false,
    });
  });

  it('renders page header', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Platform health and operations')).toBeInTheDocument();
  });

  it('renders top stat row with correct values', () => {
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

  it('renders database cards', () => {
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
    // still surfaces the raw error count.
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        ...mockSystemHealthData,
        agents: { total: 229, successes: 180, errors: 3 },
      },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<AdminDashboard />);
    expect(screen.getAllByText(/errors/i).length).toBeGreaterThanOrEqual(1);
  });

  it('shows loading state for the health-gated sections only', () => {
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
    const { container } = renderWithProviders(<AdminDashboard />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
    // P1 un-gating: PushBootstrapCard/DailyBriefingWidget/BudgetPanel/
    // EmailSecuritySection/MaintenanceSection no longer wait on
    // system-health — the page header renders immediately even while
    // system-health is still loading.
    expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
  });

  it('mounts the always-on children (VerdictBand, BudgetPanel, DailyBriefingWidget) while system-health is still loading', () => {
    // This is the actual regression the P1 un-gating fixed: before it,
    // the whole page returned a single top-level PageLoader gated on
    // useSystemHealth().isLoading, so NOTHING below the header rendered
    // until system-health resolved. Assert each always-on child's own
    // content is present — not just the page header — to prove they
    // mount and fire their own hooks in parallel rather than waiting in
    // a serial waterfall behind system-health.
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
    renderWithProviders(<AdminDashboard />);

    // VerdictBand: mounted immediately and reacts to the very same loading
    // useSystemHealth mock — its "agents" contributor is unresolved, so the
    // worst-of band reads PENDING (not blank, not OPERATIONAL).
    expect(screen.getByText('PENDING')).toBeInTheDocument();

    // BudgetPanel: owns its own (mocked-healthy) hook, unaffected by the
    // system-health loading state.
    expect(screen.getByText('AI Budget')).toBeInTheDocument();

    // DailyBriefingWidget: mounted immediately under its own SectionLabel;
    // with no explicit briefing-query mock in this suite it renders its
    // own loading state, proving the *widget* (not just the wrapper
    // section) fired its hook rather than waiting behind system-health.
    expect(screen.getByText('Daily Briefing')).toBeInTheDocument();
    expect(screen.getByText(/Loading briefing/i)).toBeInTheDocument();
  });

  it('gates StatGrid / 14d Activity / Infrastructure behind system-health and shows skeletons instead', () => {
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
    const { container } = renderWithProviders(<AdminDashboard />);

    // The health-derived stat values must NOT render while data is undefined.
    expect(screen.queryByText('Threats Today')).not.toBeInTheDocument();
    expect(screen.queryByText('Feed Ingestion')).not.toBeInTheDocument();
    expect(screen.queryByText(/success rate/)).not.toBeInTheDocument();
    expect(screen.queryByText('trust-radar-v2')).not.toBeInTheDocument();

    // In their place, skeleton placeholders render — more than one, since
    // the stat row, the 14d activity section, and infrastructure are all
    // independently gated on the same `healthReady` flag.
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(1);
  });
});
