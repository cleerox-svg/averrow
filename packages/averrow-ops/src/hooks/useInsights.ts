// Latest narrative insights from `/api/insights/latest`.
//
// Reads `agent_outputs` rows with `type IN ('insight', 'correlation')`
// — narrative outputs from Analyst, Cartographer, Strategist that
// were previously dead-written (audit 2026-05-16) and got rerouted
// to `type='insight'` so this endpoint picks them up alongside the
// existing Strategist correlations.

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface LatestInsight {
  id: string;
  agent_name: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  summary_text: string;
  created_at: string;
  output_type: 'insight' | 'correlation';
  details: string | null;
  related_brand_ids: string | null;
  related_campaign_id: string | null;
}

export function useLatestInsights(limit = 10) {
  return useQuery({
    queryKey: ['insights-latest', limit],
    queryFn: async () => {
      const res = await api.get<LatestInsight[]>(`/api/insights/latest?limit=${limit}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
  });
}
