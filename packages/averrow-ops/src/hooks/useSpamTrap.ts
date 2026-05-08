import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/* ── Shared types ────────────────────────────── */

export interface SpamTrapStats {
  total_captures: number;
  captures_24h: number;
  brands_spoofed: number;
  unique_ips: number;
  auth_fail_rate: number;
}

export interface SpamTrapCapture {
  id: number;
  trap_address: string | null;
  trap_channel: string | null;
  from_address: string | null;
  from_domain: string | null;
  subject: string | null;
  spoofed_brand_id: string | null;
  spoofed_domain: string | null;
  brand_name?: string;
  spf_result: string | null;
  dkim_result: string | null;
  dmarc_result: string | null;
  dmarc_disposition: string | null;
  sending_ip: string | null;
  category: string;
  severity: string;
  url_count: number;
  attachment_count: number;
  country_code: string | null;
  captured_at: string;
  threat_id: number | null;
  body_preview: string | null;
}

export interface SpamTrapCaptureDetail extends SpamTrapCapture {
  urls: string[];
  attachments: string[];
  raw_headers: string | null;
  return_path: string | null;
  reply_to: string | null;
  helo_hostname: string | null;
  x_mailer: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  message_id: string | null;
  spoofed_confidence: number | null;
  brand_confidence: number | null;
}

export interface SeedAddress {
  id: number;
  address: string;
  domain: string;
  channel: string;
  campaign_id: number | null;
  brand_target: string | null;
  seeded_at: string;
  seeded_location: string | null;
  total_catches: number;
  last_catch_at: string | null;
  status: string;
}

export interface SeedCampaign {
  id: number;
  name: string;
  channel: string;
  status: string;
  target_brands: string | null;
  addresses_seeded: number;
  total_catches: number;
  unique_ips_caught: number;
  brands_spoofed: number;
  last_catch_at: string | null;
  created_by: string | null;
  strategist_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DailyStat {
  date: string;
  total: number;
  phishing: number;
  spam: number;
  malware: number;
}

interface TrapHealth {
  channel: string;
  count: number;
}

interface StatsResponse {
  stats: {
    total_captures: number;
    brands_spoofed: number;
    unique_ips: number;
    auth_fail_rate: number;
    last_24h: number;
  };
  daily: DailyStat[];
  health: TrapHealth[];
}

/* ── Hooks ───────────────────────────────────── */

export function useSpamTrapStats() {
  return useQuery({
    queryKey: ['spam-trap-stats'],
    queryFn: async () => {
      const res = await api.get<StatsResponse>('/api/spam-trap/stats');
      const data = res.data;
      return {
        total_captures: data?.stats?.total_captures ?? 0,
        captures_24h: data?.stats?.last_24h ?? 0,
        brands_spoofed: data?.stats?.brands_spoofed ?? 0,
        unique_ips: data?.stats?.unique_ips ?? 0,
        auth_fail_rate: (data?.stats?.auth_fail_rate ?? 0) / 100,
      } as SpamTrapStats;
    },
    refetchInterval: 60_000,
  });
}

export function useSpamTrapDaily() {
  return useQuery({
    queryKey: ['spam-trap-daily'],
    queryFn: async () => {
      const res = await api.get<StatsResponse>('/api/spam-trap/stats');
      return (res.data?.daily ?? []) as DailyStat[];
    },
  });
}

export function useSpamTrapHealth() {
  return useQuery({
    queryKey: ['spam-trap-health'],
    queryFn: async () => {
      const res = await api.get<StatsResponse>('/api/spam-trap/stats');
      return (res.data?.health ?? []) as TrapHealth[];
    },
  });
}

export function useSpamTrapCaptures(options?: { limit?: number; offset?: number }) {
  const { limit = 50, offset = 0 } = options || {};
  return useQuery({
    queryKey: ['spam-trap-captures', limit, offset],
    queryFn: async () => {
      const res = await api.get<SpamTrapCapture[]>(`/api/spam-trap/captures?limit=${limit}&offset=${offset}`);
      return res.data ?? [];
    },
  });
}

export function useSpamTrapCapture(captureId: number | null) {
  return useQuery({
    queryKey: ['spam-trap-capture', captureId],
    queryFn: async () => {
      const res = await api.get<SpamTrapCaptureDetail>(`/api/spam-trap/captures/${captureId}`);
      return (res.data ?? null) as SpamTrapCaptureDetail | null;
    },
    enabled: !!captureId,
  });
}

export function useSpamTrapAddresses() {
  return useQuery({
    queryKey: ['spam-trap-addresses'],
    queryFn: async () => {
      const res = await api.get<SeedAddress[]>('/api/spam-trap/addresses');
      return (res.data ?? []) as SeedAddress[];
    },
    refetchInterval: 60_000,
  });
}

export function useSpamTrapCampaigns() {
  return useQuery({
    queryKey: ['spam-trap-campaigns'],
    queryFn: async () => {
      const res = await api.get<SeedCampaign[]>('/api/spam-trap/campaigns');
      return (res.data ?? []) as SeedCampaign[];
    },
  });
}

export function useScanCapture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (captureId: number) => {
      const res = await api.post<{ urls_scanned: number; malicious: number; results: unknown[] }>(
        `/api/admin/sparrow/scan-capture/${captureId}`,
      );
      return res.data ?? null;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spam-trap-captures'] });
    },
  });
}

/* ── Seeding Sources + Honeypot Visits ──────── */

export interface SeedingSource {
  location: string;
  seeds: number;
  catches: number;
  /** addresses on this location that caught at least one email */
  productive_count: number;
  /** most recent capture across all addresses on this location, null
   *  if the location has never produced */
  last_catch_at: string | null;
  /** seeded_at of the oldest address on this location — used to flag
   *  locations that are old enough to be considered dead weight */
  earliest_seed: string | null;
}

export interface HoneypotPageVisits {
  page: string;
  visits: number;
  bots: number;
}

export interface RecentCrawler {
  page: string;
  visitor_ip: string | null;
  bot_name: string | null;
  user_agent: string | null;
  country: string | null;
  asn: string | null;
  visited_at: string;
}

export interface SeedingSourcesResponse {
  sources: SeedingSource[];
  honeypot_visits: {
    total: number;
    bots: number;
    last_24h: number;
    unique_bots: number;
    by_page: HoneypotPageVisits[];
    recent_crawlers: RecentCrawler[];
  };
}

export function useSeedingSources() {
  return useQuery({
    queryKey: ['spam-trap-seeding-sources'],
    queryFn: async () => {
      const res = await api.get<SeedingSourcesResponse>('/api/spam-trap/seeding-sources');
      return res.data ?? null;
    },
    refetchInterval: 60_000,
  });
}

export function useRunStrategist() {
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<unknown>('/api/spam-trap/strategist/run');
      return res.data ?? null;
    },
  });
}
