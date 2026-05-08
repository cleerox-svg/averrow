// Hook to fetch the latest daily briefing from the platform.
// Used by the Home desktop executive view.

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface DailyBriefingRow {
  id:           number;
  report_date:  string;
  generated_at: string;
  trigger:      string;
  emailed:      number;
  report_data:  string | Record<string, unknown>;
}

export function useDailyBriefing() {
  return useQuery({
    queryKey: ['daily-briefing-latest'],
    queryFn:  async () => {
      const res = await api.get<DailyBriefingRow[]>('/api/briefings?limit=1');
      return res.data?.[0] ?? null;
    },
    staleTime: 5 * 60_000, // 5 min — briefing is stable between cron runs
  });
}
