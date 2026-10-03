// Data hooks for the ops briefing (`threat_briefings`, the 12-section
// Platform Operations Briefing). The intelligence briefing reads
// `useIntelligenceBriefings` from hooks/useTrends instead.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BriefingRow, ComprehensiveBriefing } from './types';

export const OPS_BRIEFING_QUERY_KEY = ['briefing-latest'] as const;

export interface OpsBriefing {
  row: BriefingRow;
  briefing: ComprehensiveBriefing;
}

function parseBriefing(raw: BriefingRow['report_data']): ComprehensiveBriefing {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Briefing data is unreadable');
  return parsed as ComprehensiveBriefing;
}

/**
 * Latest stored ops briefing. `null` data = none generated yet. A failed
 * request, or a row whose payload cannot be parsed, is an error (never
 * "no briefing generated yet").
 */
export function useOpsBriefing() {
  return useQuery({
    queryKey: OPS_BRIEFING_QUERY_KEY,
    queryFn: async (): Promise<OpsBriefing | null> => {
      const res = await api.get<BriefingRow>('/api/briefings/latest');
      if (res.success === false) throw new Error(res.error ?? 'Failed to load the briefing');
      const row = res.data ?? null;
      if (!row?.report_data) return null;
      return { row, briefing: parseBriefing(row.report_data) };
    },
    // The briefing is stable between cron runs, so a remount within 5 min
    // shouldn't trigger a refetch.
    staleTime: 5 * 60_000,
  });
}

/** POST /api/briefings/generate — "Run Briefing Now". */
export function useGenerateBriefing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<{ data: BriefingRow }>('/api/briefings/generate');
      if (!res.success) throw new Error(res.error ?? 'Generation failed');
      return res;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: OPS_BRIEFING_QUERY_KEY });
    },
  });
}
