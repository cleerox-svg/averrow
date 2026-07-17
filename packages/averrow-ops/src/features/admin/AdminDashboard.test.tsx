import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { AdminDashboard } from './AdminDashboard';
import type { DashboardSnapshot } from '@/hooks/useDashboardSnapshot';

// ─── Tier 3: /admin + /admin/metrics merge ──────────────────────────────
// AdminDashboard is now a tabbed surface: PageHeader + VerdictBand render
// above the tabs and never unmount; every tab body is lazy-mounted (only
// the active tab's JSX is in the DOM). Default tab is `overview`, which
// carries what used to be the whole page's "top half" (StatGrid + 14d
// Activity row). Everything that used to render unconditionally further
// down the page (Infrastructure, Compliance & Sessions, Email Security,
// Daily Briefing, Budget) now lives behind its own tab — see the
// `switchTab` helper below and RESTRUCTURE_SPEC-adjacent tab table in the
// component file itself.
//
// Two independent data sources, unchanged from pre-Tier-3:
//   - useDashboardSnapshot(): drives the top StatGrid + 14d Activity row
//     (threat_health slice), BudgetPanel (budget slice), and VerdictBand
//     (all four slices) — see VerdictBand.test.tsx for the verdict's own
//     dedicated worst-of coverage.
//   - useSystemHealth(): migrations/audit/infrastructure/sessions are NOT
//     in the snapshot contract, so Compliance & Sessions and Infrastructure
//     (now both on the System tab) stay on this full endpoint.
//     MaintenanceSection also calls this hook independently for its
//     "unlinked threats" line.

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
    worker: { name: 'averrow-worker', platform: 'Cloudflare Workers' },
    kvNamespaces: [
      { name: 'averrow-cache' },
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

// useAgents is mocked (importActual for the rest of the module — Pipelines.tsx
// also imports usePipelineStatus/usePipelineDetail from the same file) so the
// "gated to the Pipelines tab" test below can assert the hook fires only once
// that tab is actually mounted, instead of unconditionally at the
// AdminDashboard top level.
const mocks = vi.hoisted(() => ({ useAgents: vi.fn() }));
vi.mock('@/hooks/useAgents', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useAgents')>('@/hooks/useAgents');
  return { ...actual, useAgents: mocks.useAgents };
});

// jsdom doesn't implement scrollIntoView; the VerdictBand-deep-link hash
// effect calls it once the Cost tab (and its #budget-panel target) mounts
// (see CommandPalette.test.tsx for the same stub pattern).
Element.prototype.scrollIntoView = vi.fn();

// Mock recharts to avoid canvas/SVG rendering issues in test
vi.mock('recharts', () => ({
  AreaChart: ({ children }: { children: React.ReactNode }) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  Bar: () => null,
  Line: () => null,
  ComposedChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useDashboardSnapshot } from '@/hooks/useDashboardSnapshot';

async function switchTab(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name }));
}

describe('AdminDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, '', '/admin');
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
    mocks.useAgents.mockReturnValue({ data: [], isLoading: false, isError: false });
  });

  it('renders page header', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Platform health and operations')).toBeInTheDocument();
  });

  it('renders VerdictBand above the tabs, always', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('OPERATIONAL')).toBeInTheDocument();
  });

  it('renders all 8 tabs', () => {
    renderWithProviders(<AdminDashboard />);
    const labels = ['Overview', 'Pipelines', 'Feeds', 'Cost & Budget', 'Geo Coverage', 'Email Security', 'System', 'Briefing'];
    for (const label of labels) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('defaults to the Overview tab and renders top stat row with correct values (snapshot-derived)', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('3,209')).toBeInTheDocument();
    // 6,245 appears in the StatCard and again in the agent performance subline
    expect(screen.getAllByText('6,245').length).toBeGreaterThanOrEqual(1);
    // 229 appears in both stat card and agent performance section
    expect(screen.getAllByText('229').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/94/).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the 14d Activity section on Overview', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText(/Activity/)).toBeInTheDocument();
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('renders agent performance stats on Overview', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText(/success rate/)).toBeInTheDocument();
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

  // ─── Lazy-mount ──────────────────────────────────────────────────────
  describe('lazy-mount', () => {
    it('does not render other tabs\' bodies while Overview is active', () => {
      renderWithProviders(<AdminDashboard />);
      // Infrastructure + Compliance (System tab) are not in the DOM.
      expect(screen.queryByText('Infrastructure')).not.toBeInTheDocument();
      expect(screen.queryByText('trust-radar-v2')).not.toBeInTheDocument();
      expect(screen.queryByText('Data residency: ENAM')).not.toBeInTheDocument();
      // Email Security (Email tab) is not in the DOM.
      expect(screen.queryByText('Email Security Coverage')).not.toBeInTheDocument();
      // Daily Briefing (Briefing tab) is not in the DOM.
      expect(screen.queryByText('Daily Briefing')).not.toBeInTheDocument();
      // AI Budget (Cost tab) is not in the DOM.
      expect(screen.queryByText('AI Budget')).not.toBeInTheDocument();
    });

    it('mounts the System tab body and unmounts Overview when switched', async () => {
      renderWithProviders(<AdminDashboard />);
      await switchTab('System');

      expect(screen.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Infrastructure')).toBeInTheDocument();
      expect(screen.getByText('trust-radar-v2')).toBeInTheDocument();

      // Overview's top stat row is gone now that it isn't the active tab.
      expect(screen.queryByText('Threats Today')).not.toBeInTheDocument();
    });
  });

  // ─── ?tab= URL sync + normalize ──────────────────────────────────────
  describe('?tab= routing', () => {
    it('reads the active tab from the ?tab= query param on load', () => {
      window.history.pushState({}, '', '/admin?tab=system');
      renderWithProviders(<AdminDashboard />);
      expect(screen.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Infrastructure')).toBeInTheDocument();
    });

    it('normalizes a missing ?tab to overview', () => {
      window.history.pushState({}, '', '/admin');
      renderWithProviders(<AdminDashboard />);
      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    });

    it('normalizes an unknown ?tab to overview', () => {
      window.history.pushState({}, '', '/admin?tab=nonsense');
      renderWithProviders(<AdminDashboard />);
      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    });

    it('updates the URL when a tab is clicked', async () => {
      renderWithProviders(<AdminDashboard />);
      await switchTab('Email Security');
      expect(window.location.search).toBe('?tab=email');
    });
  });

  // ─── Tabs moved from the old page body ────────────────────────────────
  it('renders database cards (system-health-derived) on the System tab', async () => {
    renderWithProviders(<AdminDashboard />);
    await switchTab('System');
    expect(screen.getByText('trust-radar-v2')).toBeInTheDocument();
    expect(screen.getByText('trust-radar-v2-audit')).toBeInTheDocument();
    expect(screen.getByText('PRIMARY')).toBeInTheDocument();
    expect(screen.getByText('AUDIT')).toBeInTheDocument();
  });

  it('renders worker status on the System tab', async () => {
    renderWithProviders(<AdminDashboard />);
    await switchTab('System');
    expect(screen.getByText('averrow-worker')).toBeInTheDocument();
    expect(screen.getByText('Cloudflare Workers')).toBeInTheDocument();
  });

  it('renders KV namespaces on the System tab', async () => {
    renderWithProviders(<AdminDashboard />);
    await switchTab('System');
    expect(screen.getByText(/averrow-cache/)).toBeInTheDocument();
    expect(screen.getByText(/SESSIONS/)).toBeInTheDocument();
    expect(screen.getByText(/CACHE/)).toBeInTheDocument();
  });

  it('renders the compliance checklist on the System tab', async () => {
    renderWithProviders(<AdminDashboard />);
    await switchTab('System');
    expect(screen.getByText('Data residency: ENAM')).toBeInTheDocument();
    expect(screen.getByText('Audit logging: Active')).toBeInTheDocument();
    expect(screen.getByText('283 events recorded')).toBeInTheDocument();
  });

  it('renders migration info on the System tab', async () => {
    renderWithProviders(<AdminDashboard />);
    await switchTab('System');
    expect(screen.getByText(/45 migrations run/)).toBeInTheDocument();
    expect(screen.getByText('0047_agent_activity_log.sql')).toBeInTheDocument();
    expect(screen.getByText(/UP TO DATE/i)).toBeInTheDocument();
  });

  // ─── Email Security Section — Tier 2a fix pass wired this off the ─────
  // dashboard snapshot's `email_security` slice instead of its own
  // useQuery(['email-security-stats']) fetch (finding #5). Now lives on
  // its own Email Security tab (Tier 3).
  it('renders Email Security Coverage from the snapshot email_security slice on the Email Security tab', async () => {
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
    await switchTab('Email Security');
    expect(screen.getByText('Email Security Coverage')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    // Coverage line: scanned/total where total = 120 + 30 = 150.
    expect(screen.getByText(/120\s*\/\s*150/)).toBeInTheDocument();
  });

  it('Email Security Coverage renders zeros (not a crash) when email_security is null', async () => {
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { ...mockSnapshotData, email_security: null },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<AdminDashboard />);
    await switchTab('Email Security');
    expect(screen.getByText('Email Security Coverage')).toBeInTheDocument();
  });

  // ─── Gate 1: snapshot (`healthReady`) — StatGrid + 14d Activity row ────
  describe('gated on the dashboard snapshot (StatGrid + Activity row, Overview tab)', () => {
    it('shows skeletons instead of the stat row / activity row while the snapshot is loading, independent of system-health', () => {
      (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
      const { container } = renderWithProviders(<AdminDashboard />);

      expect(screen.queryByText('Threats Today')).not.toBeInTheDocument();
      expect(screen.queryByText('Feed Ingestion')).not.toBeInTheDocument();
      expect(screen.queryByText(/success rate/)).not.toBeInTheDocument();
      expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    });

    it('VerdictBand reads PENDING while the snapshot is loading (Cost tab still lazy — BudgetPanel not mounted)', () => {
      (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
      renderWithProviders(<AdminDashboard />);
      expect(screen.getByText('PENDING')).toBeInTheDocument();
      expect(screen.queryByText('AI Budget')).not.toBeInTheDocument();
    });
  });

  // ─── Gate 2: full system-health (`systemHealthReady`) — Compliance & ──
  // Sessions + Infrastructure (migrations/audit/infrastructure aren't in
  // the snapshot contract). Both now live on the System tab.
  describe('gated on system-health (Compliance & Sessions + Infrastructure, System tab)', () => {
    it('shows skeletons instead of Infrastructure / Compliance while system-health is loading, independent of the snapshot', async () => {
      (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
      const { container } = renderWithProviders(<AdminDashboard />);
      await switchTab('System');

      expect(screen.queryByText('trust-radar-v2')).not.toBeInTheDocument();
      expect(screen.queryByText('Data residency: ENAM')).not.toBeInTheDocument();
      expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    });
  });

  it('mounts the always-on VerdictBand while system-health is still loading', () => {
    // Regression coverage for the original P1 un-gating fix, re-scoped for
    // Tier 3: VerdictBand doesn't depend on useSystemHealth at all (moved to
    // the snapshot in Tier 2a) and renders above the tabs unconditionally,
    // so it must render normally even while the system-health fetch is
    // still in flight — independent of which tab is active.
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('OPERATIONAL')).toBeInTheDocument();
  });

  it('renders AI Budget and Daily Briefing once their tabs are selected, independent of system-health loading', async () => {
    // BudgetPanel (Cost tab) and DailyBriefingWidget (Briefing tab) don't
    // depend on useSystemHealth either — they read off the snapshot / their
    // own hook — but post-Tier-3 they're lazy-mounted, so they only appear
    // once their tab is active.
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
    renderWithProviders(<AdminDashboard />);

    await switchTab('Cost & Budget');
    // "AI Budget" appears twice — our own SectionLabel wrapper and
    // BudgetPanel's internal CardEyebrow.
    expect(screen.getAllByText('AI Budget').length).toBeGreaterThanOrEqual(1);

    await switchTab('Briefing');
    expect(screen.getByText('Daily Briefing')).toBeInTheDocument();
  });

  it('renders page header immediately even while both hooks are still loading', () => {
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
    (useDashboardSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true, isError: false });
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
  });

  // ─── ARIA: linkedPanels tabpanel shells ────────────────────────────────
  // Tabs.tsx's own doc-comment warns that `linkedPanels` must only be used
  // when a matching `role="tabpanel" id="tabpanel-<id>"` exists for EVERY
  // tab, not just the active one — an unmatched `aria-controls` is invalid
  // ARIA. AdminDashboard renders all 8 persistently (hidden via
  // `hidden`/`display:none` when inactive) so every tab's `aria-controls`
  // resolves, even though the inner content stays lazy.
  describe('linkedPanels ARIA correctness', () => {
    it('every tab\'s aria-controls target exists in the DOM, even for inactive tabs', () => {
      renderWithProviders(<AdminDashboard />);
      const tabs = screen.getAllByRole('tab');
      expect(tabs.length).toBe(8);
      for (const tab of tabs) {
        const controls = tab.getAttribute('aria-controls');
        expect(controls).toBeTruthy();
        // getElementById, not a testing-library query — inactive panels are
        // legitimately hidden from the accessibility tree/queries, but the
        // DOM node itself must still exist for aria-controls to resolve.
        expect(document.getElementById(controls!)).not.toBeNull();
      }
    });

    it('hides the inactive panel shells and shows only the active one', () => {
      renderWithProviders(<AdminDashboard />);
      expect(document.getElementById('tabpanel-overview')).not.toHaveAttribute('hidden');
      expect(document.getElementById('tabpanel-system')).toHaveAttribute('hidden');
      expect(document.getElementById('tabpanel-briefing')).toHaveAttribute('hidden');
    });
  });

  // ─── useAgents() gated to the Pipelines tab ────────────────────────────
  it('does not call useAgents() until the Pipelines tab is mounted', async () => {
    renderWithProviders(<AdminDashboard />);
    expect(mocks.useAgents).not.toHaveBeenCalled();

    await switchTab('Pipelines');
    expect(mocks.useAgents).toHaveBeenCalled();
  });

  // ─── Cost & Budget tab: de-walled via CollapsibleSection ───────────────
  // BudgetPanel stays open by default (VerdictBand deep-links to
  // #budget-panel); D1 Budget / AI Spend default to collapsed since each
  // was a full standalone page pre-Tier-3. Cost Optimization was folded
  // into AI Spend in Tier 4 (duplicate window toggle over the same three
  // dominant agents) — it's no longer a sibling panel on this tab; its
  // content now lives inside AiSpend's own collapsed-by-default
  // "Cost-reduction levers" sub-section (see AiSpend.tsx).
  describe('Cost & Budget tab defaults', () => {
    it('shows BudgetPanel expanded and the other panels collapsed by default', async () => {
      renderWithProviders(<AdminDashboard />);
      await switchTab('Cost & Budget');

      // BudgetPanel isn't collapsible — its content is always visible.
      expect(screen.getAllByText('AI Budget').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/% used/)).toBeInTheDocument();

      // The other two are collapsed (aria-expanded="false") by default.
      const d1Toggle = screen.getByRole('button', { name: /D1 Budget/ });
      const aiSpendToggle = screen.getByRole('button', { name: /AI Spend/ });
      expect(d1Toggle).toHaveAttribute('aria-expanded', 'false');
      expect(aiSpendToggle).toHaveAttribute('aria-expanded', 'false');

      // Cost Optimization is no longer a standalone Cost & Budget panel.
      expect(screen.queryByRole('button', { name: /^Cost Optimization$/ })).not.toBeInTheDocument();
    });

    it('expands a collapsed panel on click', async () => {
      renderWithProviders(<AdminDashboard />);
      await switchTab('Cost & Budget');

      const d1Toggle = screen.getByRole('button', { name: /D1 Budget/ });
      const user = userEvent.setup();
      await user.click(d1Toggle);

      expect(d1Toggle).toHaveAttribute('aria-expanded', 'true');
    });
  });

  // ─── Hash-scroll: VerdictBand's #budget-panel deep-link ────────────────
  describe('#budget-panel hash-scroll', () => {
    it('scrolls #budget-panel into view when landing directly on /admin?tab=cost#budget-panel', () => {
      window.history.pushState({}, '', '/admin?tab=cost#budget-panel');
      renderWithProviders(<AdminDashboard />);

      expect(screen.getByRole('tab', { name: 'Cost & Budget' })).toHaveAttribute('aria-selected', 'true');
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });

    it('does not scroll when the hash is present but the cost tab is not active', () => {
      window.history.pushState({}, '', '/admin?tab=overview#budget-panel');
      renderWithProviders(<AdminDashboard />);

      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    });

    it('scrolls on a same-page click of VerdictBand\'s AI-budget deep-link (tab + hash change together)', async () => {
      // The plain Tabs click (`onTabChange` -> `setSearchParams`) only
      // rewrites `?tab=`, so it does NOT carry the hash along — that's
      // correct: it's not meant to replay a stale deep-link on every tab
      // switch. The real "same-page click" case the effect comment
      // describes is VerdictBand's own `<Link to="/admin?tab=cost#budget-panel">`
      // (rendered inside AdminDashboard, above the tabs), which changes
      // both search and hash atomically in one navigation.
      window.history.pushState({}, '', '/admin?tab=pipelines');
      renderWithProviders(<AdminDashboard />);
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

      const user = userEvent.setup();
      await user.click(screen.getByRole('link', { name: /AI budget/i }));

      expect(screen.getByRole('tab', { name: 'Cost & Budget' })).toHaveAttribute('aria-selected', 'true');
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
  });
});
