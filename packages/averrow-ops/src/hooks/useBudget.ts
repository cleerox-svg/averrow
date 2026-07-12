import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { DASHBOARD_SNAPSHOT_QUERY_KEY } from '@/hooks/useDashboardSnapshot';

export interface BudgetConfig {
  monthly_limit_usd: number;
  soft_pct: number;
  hard_pct: number;
  emergency_pct: number;
}

export interface BudgetStatus {
  config: BudgetConfig;
  spent_this_month: number;
  remaining: number;
  pct_used: number;
  throttle_level: 'none' | 'soft' | 'hard' | 'emergency';
  days_in_month: number;
  days_elapsed: number;
  daily_burn_rate: number;
  projected_monthly: number;
  anthropic_reported: number;
}

export function useBudgetConfigMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<BudgetConfig>) => {
      const res = await api.patch<BudgetConfig>('/api/admin/budget/config', patch);
      return res.data ?? null;
    },
    onSuccess: () => {
      // AdminDashboard's BudgetPanel reads budget off the dashboard snapshot
      // (Tier 2a) — without this, a config edit wouldn't be visible there
      // until the snapshot's own 75s refetch interval caught up.
      // (useBudgetStatus/useBudgetBreakdown, the standalone budget hooks
      // this used to also invalidate, were removed as dead code — no
      // remaining consumer outside this file; see fix-pass note.)
      qc.invalidateQueries({ queryKey: DASHBOARD_SNAPSHOT_QUERY_KEY });
    },
  });
}
