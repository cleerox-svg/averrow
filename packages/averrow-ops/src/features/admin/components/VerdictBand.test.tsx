import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { VerdictBand } from './VerdictBand';
import type { FeedFailureRow } from '@/hooks/useMetrics';
import type { PipelineEntry } from '@/hooks/useAgents';

vi.mock('@/hooks/useSystemHealth', () => ({ useSystemHealth: vi.fn() }));
vi.mock('@/hooks/useBudget', () => ({ useBudgetStatus: vi.fn() }));
vi.mock('@/hooks/useMetrics', () => ({ useFeedFailures: vi.fn() }));
vi.mock('@/hooks/useAgents', () => ({ usePipelineStatus: vi.fn() }));

import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useBudgetStatus } from '@/hooks/useBudget';
import { useFeedFailures } from '@/hooks/useMetrics';
import { usePipelineStatus } from '@/hooks/useAgents';

interface HealthMock { data?: { agents: { total: number; successes: number; errors: number } }; isLoading?: boolean; isError?: boolean }
interface BudgetMock { data?: { throttle_level: string; pct_used: number }; isLoading?: boolean; isError?: boolean }
interface FeedsMock { data?: { per_feed: FeedFailureRow[] }; isLoading?: boolean; isError?: boolean }
interface PipelinesMock { data?: PipelineEntry[]; isLoading?: boolean; isError?: boolean }

const healthyHealth: HealthMock = {
  data: { agents: { total: 10, successes: 10, errors: 0 } },
  isLoading: false,
  isError: false,
};
const healthyBudget: BudgetMock = {
  data: { throttle_level: 'none', pct_used: 12 },
  isLoading: false,
  isError: false,
};
const healthyFeeds: FeedsMock = {
  data: { per_feed: [] },
  isLoading: false,
  isError: false,
};
const healthyPipelines: PipelinesMock = {
  data: [],
  isLoading: false,
  isError: false,
};

function mockAll(overrides: {
  health?: HealthMock;
  budget?: BudgetMock;
  feeds?: FeedsMock;
  pipelines?: PipelinesMock;
} = {}) {
  (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ ...healthyHealth, ...overrides.health });
  (useBudgetStatus as ReturnType<typeof vi.fn>).mockReturnValue({ ...healthyBudget, ...overrides.budget });
  (useFeedFailures as ReturnType<typeof vi.fn>).mockReturnValue({ ...healthyFeeds, ...overrides.feeds });
  (usePipelineStatus as ReturnType<typeof vi.fn>).mockReturnValue({ ...healthyPipelines, ...overrides.pipelines });
}

// ─── Fixture builders ──────────────────────────────────────────────
function makeFeedRow(overrides: Partial<FeedFailureRow> = {}): FeedFailureRow {
  return {
    feed_name: 'feed_a',
    display_name: 'Feed A',
    enabled: true,
    paused_reason: null,
    pulls: 20,
    success: 20,
    failed: 0,
    partial: 0,
    failure_rate_pct: 0,
    records_ingested: 100,
    last_success_at: null,
    last_failure_at: null,
    consecutive_failures: 0,
    threshold: 5,
    pct_to_auto_pause: 0,
    verdict: { tone: 'success', label: 'OK' },
    ...overrides,
  };
}

function makePipeline(overrides: Partial<PipelineEntry> = {}): PipelineEntry {
  return {
    id: 'pipeline_a',
    label: 'Pipeline A',
    agent: 'sentinel',
    schedule: 'hourly',
    endpoints: null,
    count: 10,
    prev_count: 10,
    trend: 0,
    trend_direction: 'flat',
    last_measured_at: null,
    agent_last_run_at: null,
    agent_last_status: null,
    agent_records_processed: null,
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

  it('shows OPERATIONAL when every signal is resolved and healthy', () => {
    mockAll();
    renderWithProviders(<VerdictBand />);
    expect(screen.getByText('OPERATIONAL')).toBeInTheDocument();
  });

  it('never shows OPERATIONAL while a signal is still unresolved (unknown != ok)', () => {
    mockAll({ feeds: { data: undefined, isLoading: true } });
    renderWithProviders(<VerdictBand />);
    expect(screen.queryByText('OPERATIONAL')).not.toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
  });

  it('does not let an unresolved hook mask a genuine critical signal (worst-of, not last-write)', () => {
    mockAll({
      budget: { data: { throttle_level: 'emergency', pct_used: 97 } },
      feeds: { data: undefined, isLoading: true },
    });
    renderWithProviders(<VerdictBand />);
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
    expect(screen.queryByText('PENDING')).not.toBeInTheDocument();
  });

  it('surfaces feed and agent problems together at the worst severity', () => {
    mockAll({
      health: { data: { agents: { total: 10, successes: 8, errors: 2 } } },
      feeds: {
        data: {
          per_feed: [
            { feed_name: 'a', display_name: 'A', enabled: true, paused_reason: null, pulls: 20, success: 5, failed: 15, partial: 0, failure_rate_pct: 75, records_ingested: 0, last_success_at: null, last_failure_at: null, consecutive_failures: 4, threshold: 5, pct_to_auto_pause: 80, verdict: { tone: 'failed', label: 'FAILED' } },
          ],
        },
      },
    });
    renderWithProviders(<VerdictBand />);
    // pct_to_auto_pause >= 80 is the 'critical' feed tier, which outranks
    // the agents 'high' signal, so the band reads CRITICAL overall.
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
  });

  // ─── Worst-of matrix — table-driven ────────────────────────────
  // Each row asserts the exact overall label for a given combination of
  // resolved/unresolved signals, locking the RANK order
  // (critical > high > medium > low > unknown > ok) end to end.
  describe('worst-of severity matrix', () => {
    const criticalFeedRow = makeFeedRow({ pct_to_auto_pause: 85, consecutive_failures: 4 });
    const highFeedRow = makeFeedRow({ pct_to_auto_pause: 65, consecutive_failures: 3 });
    const growingPipeline = makePipeline({ verdict: { tone: 'warning', label: 'GROWING' } });
    const stalePipeline = makePipeline({ verdict: { tone: 'pending', label: 'STALE' } });

    const cases: Array<{
      name: string;
      overrides: Parameters<typeof mockAll>[0];
      expectLabel: string;
    }> = [
      {
        name: 'all signals ok -> OPERATIONAL',
        overrides: {},
        expectLabel: 'OPERATIONAL',
      },
      {
        name: 'agents unknown (loading), rest ok -> PENDING (never OPERATIONAL)',
        overrides: { health: { data: undefined, isLoading: true } },
        expectLabel: 'PENDING',
      },
      {
        name: 'budget unknown (errored), rest ok -> PENDING',
        overrides: { budget: { data: undefined, isError: true, isLoading: false } },
        expectLabel: 'PENDING',
      },
      {
        name: 'pipelines unknown (loading), rest ok -> PENDING',
        overrides: { pipelines: { data: undefined, isLoading: true } },
        expectLabel: 'PENDING',
      },
      {
        name: 'agent errors alone -> HIGH',
        overrides: { health: { data: { agents: { total: 10, successes: 8, errors: 2 } } } },
        expectLabel: 'HIGH',
      },
      {
        name: 'budget soft throttle alone -> MEDIUM',
        overrides: { budget: { data: { throttle_level: 'soft', pct_used: 82 } } },
        expectLabel: 'MEDIUM',
      },
      {
        name: 'budget hard throttle alone -> HIGH',
        overrides: { budget: { data: { throttle_level: 'hard', pct_used: 93 } } },
        expectLabel: 'HIGH',
      },
      {
        name: 'budget emergency throttle alone -> CRITICAL',
        overrides: { budget: { data: { throttle_level: 'emergency', pct_used: 99 } } },
        expectLabel: 'CRITICAL',
      },
      {
        name: 'feeds high tier alone -> HIGH',
        overrides: { feeds: { data: { per_feed: [highFeedRow] } } },
        expectLabel: 'HIGH',
      },
      {
        name: 'feeds critical tier alone -> CRITICAL',
        overrides: { feeds: { data: { per_feed: [criticalFeedRow] } } },
        expectLabel: 'CRITICAL',
      },
      {
        name: 'pipeline GROWING alone -> HIGH',
        overrides: { pipelines: { data: [growingPipeline] } },
        expectLabel: 'HIGH',
      },
      {
        name: 'pipeline STALE alone -> MEDIUM',
        overrides: { pipelines: { data: [stalePipeline] } },
        expectLabel: 'MEDIUM',
      },
      {
        name: 'one signal critical + another still loading -> CRITICAL, not masked by unknown',
        overrides: {
          feeds: { data: { per_feed: [criticalFeedRow] } },
          pipelines: { data: undefined, isLoading: true },
        },
        expectLabel: 'CRITICAL',
      },
      {
        name: 'medium (soft budget) + unresolved agents -> the real MEDIUM wins over unknown',
        overrides: {
          budget: { data: { throttle_level: 'soft', pct_used: 70 } },
          health: { data: undefined, isLoading: true },
        },
        expectLabel: 'MEDIUM',
      },
    ];

    it.each(cases)('$name', ({ overrides, expectLabel }) => {
      mockAll(overrides);
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
      mockAll();
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('Agents')).toBe('/agents');
    });

    it('links the AI budget contributor to /admin#budget-panel', () => {
      mockAll();
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('AI budget')).toBe('/admin#budget-panel');
    });

    it('links the Feeds contributor to /admin/metrics?tab=feed-failures', () => {
      mockAll();
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('Feeds')).toBe('/admin/metrics?tab=feed-failures');
    });

    it('links the Pipelines contributor to /admin/metrics?tab=pipelines', () => {
      mockAll();
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('Pipelines')).toBe('/admin/metrics?tab=pipelines');
    });

    it('keeps the same deep-link targets even when a signal is unknown', () => {
      mockAll({ feeds: { data: undefined, isLoading: true } });
      renderWithProviders(<VerdictBand />);
      expect(hrefForContributor('Feeds')).toBe('/admin/metrics?tab=feed-failures');
      expect(hrefForContributor('Agents')).toBe('/agents');
    });
  });

  // ─── Feed tiering edge case: muted (paused/disabled) feeds don't
  // count toward criticalCount/highCount, so a disabled feed alone must
  // NOT push the band to a bad severity — it's neither counted as
  // critical nor high by feedRiskTier's 'muted' branch.
  it('a disabled feed with no other signal stays OPERATIONAL (muted tier is not critical/high)', () => {
    mockAll({
      feeds: { data: { per_feed: [makeFeedRow({ enabled: false })] } },
    });
    renderWithProviders(<VerdictBand />);
    expect(screen.getByText('OPERATIONAL')).toBeInTheDocument();
  });
});
