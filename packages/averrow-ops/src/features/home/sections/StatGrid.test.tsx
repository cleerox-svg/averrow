import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { StatGrid } from './StatGrid';

// StatGrid fans out to six data hooks and threads each one's
// isLoading/isPending flag into StatTile's `value={null}` loading
// contract (see StatTile.test.tsx for the primitive-level coverage).
// This file locks the wiring: a pending hook must render '—' on its
// tile, a settled hook renders its real number — including a genuine
// 0, which must NOT be confused with the loading placeholder.
vi.mock('@/hooks/useObservatory', () => ({ useObservatoryStats: vi.fn() }));
vi.mock('@/hooks/useAlerts', () => ({ useAlertStats: vi.fn() }));
vi.mock('@/hooks/useOperations', () => ({ useOperationsStats: vi.fn() }));
vi.mock('@/hooks/useBrands', () => ({ useBrandStats: vi.fn(), useBrands: vi.fn() }));
vi.mock('@/hooks/useAgents', () => ({ useAgents: vi.fn() }));
vi.mock('@/hooks/useFeeds', () => ({ useFeedStats: vi.fn() }));
// Animation is irrelevant here and only slows/obscures assertions —
// same rationale as StatTile.test.tsx.
vi.mock('@/design-system/hooks/useCountUp', () => ({ useCountUp: (target: number) => target }));

import { useObservatoryStats } from '@/hooks/useObservatory';
import { useAlertStats } from '@/hooks/useAlerts';
import { useOperationsStats } from '@/hooks/useOperations';
import { useBrandStats, useBrands } from '@/hooks/useBrands';
import { useAgents } from '@/hooks/useAgents';
import { useFeedStats } from '@/hooks/useFeeds';

function mockAllPending() {
  (useObservatoryStats as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isLoading: true });
  (useAlertStats as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isPending: true });
  (useOperationsStats as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isPending: true });
  (useBrandStats as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isPending: true });
  (useAgents as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isPending: true });
  (useFeedStats as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isPending: true });
  (useBrands as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isPending: true });
}

// Every numeric value below is deliberately distinct (120/17/6/8/250/2/10)
// so `getByText('<n>')` can't accidentally match a different tile's
// standalone number node (the tile value and the critical-count pill
// each render as their own text node; sub-lines like "6 critical · 4
// new" are a single combined text node and don't collide).
function mockAllSettled(overrides: { alertTotal?: number } = {}) {
  (useObservatoryStats as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { threats_mapped: 120, threats_total: 500, geo_coverage_pct: 40, countries: 12 },
    isLoading: false,
  });
  (useAlertStats as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { total: overrides.alertTotal ?? 17, critical: 6, new_count: 4 },
    isPending: false,
  });
  (useOperationsStats as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { campaigns_tracked: 8, active_operations: 3 },
    isPending: false,
  });
  (useBrandStats as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { total_tracked: 250, new_this_week: 5 },
    isPending: false,
  });
  (useAgents as ReturnType<typeof vi.fn>).mockReturnValue({
    // 3 agents, 1 'error' -> isAgentOnline excludes only 'error' -> 2 online.
    data: [
      { status: 'active' }, { status: 'idle' }, { status: 'error' },
    ],
    isPending: false,
  });
  (useFeedStats as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { active: 10, disabled: 1 },
    isPending: false,
  });
  (useBrands as ReturnType<typeof vi.fn>).mockReturnValue({ data: [], isPending: false });
}

describe('StatGrid — loading vs settled value propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "—" (not "0") on every tile while all six hooks are pending', () => {
    mockAllPending();
    renderWithProviders(<StatGrid />);

    // 6 tiles, each showing '—' twice — once for the main value, once
    // for the sub-line (StatGrid sets sub={'—'} too while pending).
    expect(screen.getAllByText('—').length).toBe(12);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('renders real settled values once hooks resolve, including Agents/Feeds/Campaigns/Brands', () => {
    mockAllSettled();
    renderWithProviders(<StatGrid />);

    expect(screen.getByText('120')).toBeInTheDocument(); // Mapped · 7d
    expect(screen.getByText('17')).toBeInTheDocument();  // Signals (alerts total)
    expect(screen.getByText('8')).toBeInTheDocument();   // Campaigns
    expect(screen.getByText('250')).toBeInTheDocument(); // Brands
    // Agents online: 3 agents, 1 'error' -> 2 online (isAgentOnline excludes 'error' only).
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();  // Feeds active
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('a genuine 0 (alerts total=0) renders "0" on the Signals tile, not the loading placeholder', () => {
    mockAllSettled({ alertTotal: 0 });
    renderWithProviders(<StatGrid />);

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('a single pending hook (alerts) shows "—" only on its own tile while the rest render real numbers', () => {
    mockAllSettled();
    // alertStats.critical becomes unreachable while pending (data is
    // undefined), so criticalCount falls back to 0 and no pill renders
    // — no collision with the other tiles' standalone numbers.
    (useAlertStats as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isPending: true });
    renderWithProviders(<StatGrid />);

    // Exactly one tile pending -> 2 '—' nodes (main value + sub-line).
    expect(screen.getAllByText('—').length).toBe(2);
    // The other five tiles still render their real settled numbers.
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('250')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });
});
