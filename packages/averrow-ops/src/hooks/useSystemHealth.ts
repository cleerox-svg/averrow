import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface SystemHealthData {
  threats: { total: number; today: number; week: number };
  agents: { total: number; successes: number; errors: number };
  feeds: { pulls: number; ingested: number };
  sessions: { count: number };
  migrations: { total: number; last_run: string | null; last_name: string | null };
  audit: { count: number };
  trend: { day: string; count: number }[];
  infrastructure: {
    mainDb: { name: string; sizeMb: number; tables: number; region: string };
    auditDb: { name: string; sizeKb: number; tables: number; region: string };
    worker: { name: string; platform: string };
    kvNamespaces: { name: string }[];
  };
}

export function useSystemHealth() {
  return useQuery({
    queryKey: ['system-health'],
    queryFn: async () => {
      const res = await api.get<SystemHealthData>('/api/admin/system-health');
      return res.data || null;
    },
    refetchInterval: 60_000,
  });
}
