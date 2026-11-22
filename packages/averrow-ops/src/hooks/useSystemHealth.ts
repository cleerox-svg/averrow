import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface DatabaseInfo {
  store: string;
  name: string | null;
  sizeBytes: number | null;
  tables: number | null;
  source: 'cf_api' | 'pragma' | null;
  capBytes: number;
}

export interface SystemHealthData {
  threats: { total: number; today: number; week: number };
  agents: { total: number; successes: number; errors: number };
  feeds: { pulls: number; ingested: number };
  sessions: { count: number };
  migrations: { total: number; last_run: string | null; last_name: string | null };
  audit: { count: number };
  trend: { day: string; count: number }[];
  infrastructure: {
    mainDb: { name: string | null; sizeMb: number | null; tables: number | null; region: string };
    auditDb: { name: string | null; sizeKb: number | null; tables: number | null; region: string };
    worker: { name: string; platform: string };
    kvNamespaces: { name: string }[];
    /** Per-store D1 view; absent on older workers. */
    databases?: DatabaseInfo[];
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
    // Matches the 60s refetchInterval above (the backend's outer KV wrap is
    // actually 120s — this staleTime is about not double-fetching on top of
    // our own poller, not about mirroring the backend cache TTL).
    staleTime: 60_000,
  });
}
