import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

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

export interface AgentSpend {
  agent_id: string;
  cost_usd: number;
  calls: number;
}

export function useBudgetStatus() {
  return useQuery({
    queryKey: ['budget-status'],
    queryFn: async () => {
      const res = await api.get<BudgetStatus>('/api/admin/budget/status');
      return res.data ?? null;
    },
    refetchInterval: 60_000,
  });
}

export function useBudgetBreakdown() {
  return useQuery({
    queryKey: ['budget-breakdown'],
    queryFn: async () => {
      const res = await api.get<AgentSpend[]>('/api/admin/budget/breakdown');
      return res.data ?? [];
    },
    refetchInterval: 60_000,
  });
}

export function useBudgetConfigMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<BudgetConfig>) => {
      const res = await api.patch<BudgetConfig>('/api/admin/budget/config', patch);
      return res.data ?? null;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budget-status'] });
    },
  });
}
