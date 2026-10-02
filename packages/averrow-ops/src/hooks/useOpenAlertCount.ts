import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Open-alert total for the Console / Overview KPI tiles. */
export function useOpenAlertCount() {
  return useQuery({
    queryKey: ['home-v4-open-alerts'],
    queryFn: async () => {
      const d = await api.get<unknown>('/api/alerts?status=open&limit=1');
      return d.total ?? 0;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
