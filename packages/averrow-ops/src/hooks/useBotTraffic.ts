import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

/* ── Types — mirror GET /api/bot-traffic ── */

export type BotTrafficDays = 7 | 30 | 90;

export interface BotTrafficLatest {
  snapshot_date: string;
  bot_pct: number;
  human_pct: number;
  /** ISO `YYYY-MM-DDTHH:MM:SSZ`. */
  fetched_at: string;
}

export interface BotTrafficPoint {
  date: string;
  bot_pct: number;
  human_pct: number;
}

export interface BotTrafficLocation {
  code: string;
  name: string;
  pct: number;
  rank: number;
}

export interface BotTrafficAsn {
  asn: number;
  name: string;
  pct: number;
  rank: number;
}

/** Layer-7 attack share for a country (origin or target), last 7 days. */
export interface BotTrafficAttackCountry {
  code: string;
  name: string;
  pct: number;
  rank: number;
}

/** A country's own automated-traffic share, plus its share of global HTTP traffic. */
export interface BotTrafficDensity {
  code: string;
  name: string;
  bot_pct: number;
  traffic_pct: number;
  rank: number;
}

export interface BotTrafficCategory {
  category: string;
  pct: number;
}

export interface BotTrafficFetchStatus {
  status: string | null;
  /** ISO `YYYY-MM-DDTHH:MM:SSZ`. */
  last_success_at: string | null;
  last_error: string | null;
}

/** Per-section snapshot dates (YYYY-MM-DD). A ranked section lags bot_share when its feed last succeeded earlier. */
export interface BotTrafficAsOf {
  bot_share: string | null;
  top_locations: string | null;
  top_asns: string | null;
  categories: string | null;
  /** Optional: absent on payloads cached before these sections shipped. */
  attack_origins?: string | null;
  attack_targets?: string | null;
  bot_density?: string | null;
}

export interface BotTrafficData {
  source: 'cloudflare_radar';
  latest: BotTrafficLatest | null;
  series: BotTrafficPoint[];
  top_locations: BotTrafficLocation[];
  top_asns: BotTrafficAsn[];
  categories: BotTrafficCategory[];
  /** Optional: absent on payloads cached before the field shipped. */
  attack_origins?: BotTrafficAttackCountry[] | null;
  attack_targets?: BotTrafficAttackCountry[] | null;
  bot_density?: BotTrafficDensity[] | null;
  last_fetch: BotTrafficFetchStatus;
  /** Optional: absent on payloads cached before the field shipped. */
  as_of?: Partial<BotTrafficAsOf> | null;
}

/** Daily Cloudflare Radar snapshot — data changes once a day, so cache 10 min. */
export function useBotTraffic(days: BotTrafficDays = 30, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['bot-traffic', days],
    queryFn: async () => {
      const res = await api.get<BotTrafficData>(`/api/bot-traffic?days=${days}`);
      if (res.success === false || !res.data) {
        throw new Error(res.error ?? 'Failed to load bot traffic');
      }
      return res.data;
    },
    enabled: options.enabled ?? true,
    staleTime: 10 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}
