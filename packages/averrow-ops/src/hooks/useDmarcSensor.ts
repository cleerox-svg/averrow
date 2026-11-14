// Hosted DMARC report sensor — staff view data.
//
// Types mirror what packages/averrow-worker/src/handlers/dmarcReports.ts
// actually returns from:
//   GET /api/dmarc-reports/:brandId/setup
//   GET /api/dmarc-reports/:brandId/spoof-sources?days=7|30

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type DmarcSetupState =
  | 'no_dmarc' | 'rua_missing' | 'awaiting_reports' | 'receiving' | 'stale';

export interface DmarcSetup {
  brand_id: string;
  domain: string;
  state: DmarcSetupState;
  /** Mailbox only, e.g. dmarc_rua@averrow.ca. */
  rua_address: string;
  /** The exact `rua=` tag value to publish, e.g. `mailto:dmarc_rua@averrow.ca`. */
  rua_value: string;
  rua_includes_averrow: boolean;
  /** `live_dns_failed` = the resolver could not answer (not "no record"). */
  rua_checked_via: 'scan' | 'live_dns' | 'live_dns_failed';
  authorization_required: boolean;
  authorization_record_ok: boolean;
  authorization_record_name: string | null;
  authorization_record_value: string;
  /** Verified within the re-verify window (current validity, not row existence). */
  enrolled: boolean;
  /** When false no report is stored for this brand whatever the DNS says. */
  eligible: boolean;
  verified_via: 'scan' | 'live_dns' | null;
  verified_at: string | null;
  reverify_after_days: number;
  last_report_at: string | null;
  last_scan_at: string | null;
}

export type DmarcSourceClass =
  | 'aligned_pass' | 'forwarder_likely' | 'unaligned_shared_esp' | 'spoof_candidate';

export type DmarcSpoofDays = 7 | 30;

export interface DmarcSourceProvider {
  id: string;
  name: string | null;
}

export interface DmarcSpoofSource {
  source_ip: string;
  /** Most suspicious class seen for this IP over the window. */
  source_class: DmarcSourceClass;
  source_rules: string[];
  messages: number;
  fail_messages: number;
  verified_fail_messages: number;
  /** True when every report behind this source is unverified (forgeable) evidence. */
  unverified_only: boolean;
  asn: string | null;
  as_org: string | null;
  country_code: string | null;
  provider: DmarcSourceProvider | null;
  cluster_id: string | null;
  asn_drop_listed: boolean;
  first_seen: string;
  last_seen: string;
  days_seen: number;
}

export interface DmarcDailyPoint {
  date: string;
  total: number;
  passed: number;
  failed: number;
}

export interface DmarcSpoofSummary {
  sources: number;
  spoof_candidate_sources: number;
  unverified_only_sources: number;
  fail_messages: number;
  /** True when the 200-source cap was hit. */
  truncated: boolean;
}

export interface DmarcSpoofSources {
  brand_id: string;
  domain: string;
  days: DmarcSpoofDays;
  since: string;
  sources: DmarcSpoofSource[];
  daily: DmarcDailyPoint[];
  summary: DmarcSpoofSummary;
}

/** Setup state moves with DNS + report arrival, not second to second. */
export function useDmarcSetup(brandId: string) {
  return useQuery({
    queryKey: ['dmarc-sensor', 'setup', brandId],
    queryFn: async () => {
      const res = await api.get<DmarcSetup>(`/api/dmarc-reports/${brandId}/setup`);
      if (res.success === false || !res.data) {
        throw new Error(res.error ?? 'Failed to load DMARC sensor setup');
      }
      return res.data;
    },
    enabled: !!brandId,
    staleTime: 60_000,
  });
}

/** The endpoint is KV-cached for 5 min server-side, so match that here. */
export function useDmarcSpoofSources(
  brandId: string,
  days: DmarcSpoofDays,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ['dmarc-sensor', 'spoof-sources', brandId, days],
    queryFn: async () => {
      const res = await api.get<DmarcSpoofSources>(
        `/api/dmarc-reports/${brandId}/spoof-sources?days=${days}`,
      );
      if (res.success === false || !res.data) {
        throw new Error(res.error ?? 'Failed to load DMARC sources');
      }
      return res.data;
    },
    enabled: !!brandId && (options.enabled ?? true),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}
