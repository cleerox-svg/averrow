import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface GeoipStatus {
  configured: boolean;
  row_count: number | null;
  last_refresh_at: string | null;
  last_refresh_status: string | null;
  last_refresh_source: string | null;
  last_refresh_rows_written: number | null;
  last_refresh_duration_ms: number | null;
  last_refresh_error: string | null;
}

/** Polls the GeoIP DB status every 30s while a refresh is in
 *  flight; backs off to no polling once the row count is stable. */
export function useGeoipStatus(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['geoip-status'],
    queryFn: async () => {
      const res = await api.get<GeoipStatus>('/api/admin/geoip-status');
      return res.data;
    },
    enabled: opts?.enabled ?? true,
    // Poll while a refresh is running so the UI reflects the
    // workflow's progress without a manual reload. The status
    // endpoint reads from a separate D1 (GEOIP_DB) so polling
    // doesn't compete with main-DB read budget.
    refetchInterval: (query) => {
      const data = query.state.data as GeoipStatus | undefined;
      if (data?.last_refresh_status === 'running') return 30_000;
      return false;
    },
  });
}

/** Triggers POST /api/admin/geoip-refresh. Optional `forceReload`
 *  bypasses the skip-if-current guard — use after schema changes
 *  or when the operator wants to re-import the same release. */
export function useGeoipRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (opts: { forceReload?: boolean } = {}) => {
      const res = await api.post<unknown>('/api/admin/geoip-refresh', {
        forceReload: opts.forceReload ?? false,
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['geoip-status'] });
      qc.invalidateQueries({ queryKey: ['pipeline-status'] });
    },
  });
}
