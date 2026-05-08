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
  window?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function useAuditLog(filters?: AuditFilters) {
  return useQuery({
    queryKey: ['audit-log', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.outcome) params.set('outcome', filters.outcome);
      if (filters?.action) params.set('action', filters.action);
      if (filters?.window) params.set('window', filters.window);
      if (filters?.search) params.set('search', filters.search);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      const res = await api.get<{ data: AuditEntry[]; total: number }>(
        `/api/admin/audit${qs ? `?${qs}` : ''}`
      );
      const body = res as unknown as { data: AuditEntry[]; total: number };
      const rawEntries = body.data;
      return {
        entries: Array.isArray(rawEntries) ? rawEntries : [],
        total: typeof body.total === 'number' ? body.total : 0,
      };
    },
    refetchInterval: 60_000,
  });
}
