// Critical Intel banner — post-audit signal-alignment.
//
// Replaces the bare `alertStats.critical` count in StatusRow with
// a prioritized event list (provider surges, bursts, mass-impersonation
// IPs, new campaigns). Each event drills into a specific page
// instead of dumping to /alerts.

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type CriticalEventKind =
  | 'provider_surge'
  | 'burst'
  | 'mass_impersonation_ip'
  | 'new_campaign'
  | 'open_critical_alerts';

export interface CriticalEvent {
  kind: CriticalEventKind;
  title: string;
  subtitle: string;
  link: string;
  severity: 'critical' | 'high' | 'medium';
  ts: string;
}

export interface CriticalBannerData {
  events: CriticalEvent[];
  total: number;
  generated_at: string;
}

export function useCriticalBanner(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['intel-critical-banner'],
    queryFn: async () => {
      const res = await api.get<CriticalBannerData>('/api/intel/critical-banner');
      // An explicit failure envelope must land in the error path, never
      // read as "no critical events".
      if (res.success === false) throw new Error(res.error ?? 'Failed to load critical intelligence');
      return res.data ?? null;
    },
    enabled: opts.enabled !== false,
    placeholderData: keepPreviousData,
    // Backend caches 60s; client polls every 60s for parity.
    refetchInterval: 60_000,
  });
}
