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

export function useCriticalBanner() {
  return useQuery({
    queryKey: ['intel-critical-banner'],
    queryFn: async () => {
      const res = await api.get<CriticalBannerData>('/api/intel/critical-banner');
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    // Backend caches 60s; client polls every 60s for parity.
    refetchInterval: 60_000,
  });
}
