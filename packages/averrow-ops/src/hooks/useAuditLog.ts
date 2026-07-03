import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface AuditEntry {
  id: string;
  timestamp: string;
  user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
  outcome: 'success' | 'failure' | 'denied';
}

export interface AuditFilters {
  outcome?: string;
  action?: string;
  resource_type?: string;
  window?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Aggregates over the FULL filtered set (not the returned page). */
export interface AuditStats {
  today: number;
  failures: number;
  denied: number;
  unique_actions: number;
}

export function useAuditLog(filters?: AuditFilters) {
  return useQuery({
    queryKey: ['audit-log', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.outcome) params.set('outcome', filters.outcome);
      if (filters?.action) params.set('action', filters.action);
      if (filters?.resource_type) params.set('resource_type', filters.resource_type);
      if (filters?.window) params.set('window', filters.window);
      if (filters?.search) params.set('search', filters.search);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      const res = await api.get<{ data: AuditEntry[]; total: number }>(
        `/api/admin/audit${qs ? `?${qs}` : ''}`
      );
      const body = res as unknown as {
        data: AuditEntry[];
        total: number;
        stats?: AuditStats;
        resource_types?: string[];
      };
      const rawEntries = body.data;
      return {
        entries: Array.isArray(rawEntries) ? rawEntries : [],
        total: typeof body.total === 'number' ? body.total : 0,
        stats: body.stats ?? null,
        resourceTypes: Array.isArray(body.resource_types) ? body.resource_types : [],
      };
    },
    refetchInterval: 60_000,
  });
}
