import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type DarkWebClassification =
  | 'confirmed'
  | 'suspicious'
  | 'false_positive'
  | 'resolved'
  | 'unknown';

export type DarkWebStatus =
  | 'active'
  | 'resolved'
  | 'false_positive'
  | 'investigating';

export type DarkWebMatchType =
  | 'brand_name'
  | 'domain'
  | 'executive'
  | 'actor_alias'
  | 'mixed';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DarkWebMention {
  id: string;
  brand_id: string;
  source: string;
  source_url: string;
  source_channel: string | null;
  source_author: string | null;
  posted_at: string | null;
  content_snippet: string | null;
  content_full_hash: string | null;
  matched_terms: string | null;
  match_type: DarkWebMatchType | null;
  classification: DarkWebClassification;
  classified_by: string | null;
  classification_confidence: number | null;
  classification_reason: string | null;
  ai_assessment: string | null;
  ai_confidence: number | null;
  ai_action: string | null;
  ai_assessed_at: string | null;
  severity: Severity;
  status: DarkWebStatus;
  first_seen: string;
  last_seen: string | null;
  last_checked: string | null;
  created_at: string;
  updated_at: string;
}

export interface DarkWebScheduleRow {
  platform: string | null;
  last_checked: string | null;
  next_check: string | null;
  check_interval_hours: number;
  enabled: number;
}

export interface DarkWebMentionsResponse {
  brand: { id: string; name: string; domain: string | null };
  results: DarkWebMention[];
  total: number;
  schedule: DarkWebScheduleRow[];
}

export interface DarkWebMentionsParams {
  source?: string;
  classification?: DarkWebClassification;
  severity?: Severity;
  match_type?: DarkWebMatchType;
  status?: DarkWebStatus;
  limit?: number;
  offset?: number;
}

export function useDarkWebMentions(brandId: string, params: DarkWebMentionsParams = {}) {
  const qs = new URLSearchParams();
  if (params.source) qs.set('source', params.source);
  if (params.classification) qs.set('classification', params.classification);
  if (params.severity) qs.set('severity', params.severity);
  if (params.match_type) qs.set('match_type', params.match_type);
  if (params.status) qs.set('status', params.status);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();

  return useQuery({
    queryKey: ['dark-web-mentions', brandId, params],
    queryFn: async () => {
      const res = await api.get<DarkWebMentionsResponse>(
        `/api/darkweb/mentions/${brandId}${query ? `?${query}` : ''}`,
      );
      return (res.data ?? {
        brand: { id: brandId, name: '', domain: null },
        results: [],
        total: 0,
        schedule: [],
      }) as DarkWebMentionsResponse;
    },
    placeholderData: keepPreviousData,
    enabled: !!brandId,
  });
}

export function useScanDarkWeb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) =>
      api.post(`/api/darkweb/scan/${brandId}`),
    onSuccess: (_, brandId) => {
      qc.invalidateQueries({ queryKey: ['dark-web-mentions', brandId] });
      qc.invalidateQueries({ queryKey: ['dark-web-overview'] });
      qc.invalidateQueries({ queryKey: ['brand-extended', brandId] });
    },
  });
}

export function useClassifyDarkWebMention() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      mentionId: string;
      brandId: string;
      classification?: DarkWebClassification;
      status?: DarkWebStatus;
    }) => {
      const body: Record<string, string> = {};
      if (vars.classification) body.classification = vars.classification;
      if (vars.status) body.status = vars.status;
      return api.patch(`/api/darkweb/${vars.mentionId}`, body);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['dark-web-mentions', vars.brandId] });
      qc.invalidateQueries({ queryKey: ['dark-web-overview'] });
    },
  });
}

export interface DarkWebOverviewRow {
  id: string;
  brand_name: string;
  domain: string | null;
  executive_names: string | null;
  has_executives: boolean;
  counts: {
    total: number;
    confirmed: number;
    suspicious: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  last_checked: string | null;
  next_check: string | null;
  created_at: string;
}

export interface DarkWebOverviewResponse {
  data: DarkWebOverviewRow[];
  total: number;
  totals: {
    total: number;
    confirmed: number;
    suspicious: number;
    critical: number;
    high: number;
  };
}

// ─── Global mentions table ──────────────────────────────────────
// Powers the platform-standard table view on the ops Dark Web page.
// Mirrors useThreatsTable's filter/sort/pagination contract.

export type DarkWebSortKey =
  | 'last_seen'
  | 'first_seen'
  | 'posted_at'
  | 'severity'
  | 'source'
  | 'brand';

export interface DarkWebAllMentionsParams {
  source?: string;
  classification?: DarkWebClassification;
  severity?: Severity;
  match_type?: DarkWebMatchType;
  status?: DarkWebStatus;
  brand_id?: string;
  q?: string;
  sort?: DarkWebSortKey;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface DarkWebMentionWithBrand extends DarkWebMention {
  brand_name: string | null;
  brand_domain: string | null;
}

export interface DarkWebAllMentionsResponse {
  results: DarkWebMentionWithBrand[];
  total: number;
  aggregates: {
    slice: {
      total_active: number;
      confirmed_active: number;
      suspicious_active: number;
      critical_active: number;
      high_active: number;
      medium_active: number;
      low_active: number;
    };
    by_source:   Array<{ source: string;   n: number }>;
    by_severity: Array<{ severity: string; n: number }>;
  };
  applied: Record<string, unknown>;
}

export function useDarkWebAllMentions(params: DarkWebAllMentionsParams = {}) {
  const qs = new URLSearchParams();
  if (params.source)         qs.set('source', params.source);
  if (params.classification) qs.set('classification', params.classification);
  if (params.severity)       qs.set('severity', params.severity);
  if (params.match_type)     qs.set('match_type', params.match_type);
  if (params.status)         qs.set('status', params.status);
  if (params.brand_id)       qs.set('brand_id', params.brand_id);
  if (params.q)              qs.set('q', params.q);
  if (params.sort)           qs.set('sort', params.sort);
  if (params.dir)            qs.set('dir', params.dir);
  if (params.limit !== undefined)  qs.set('limit',  String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();

  return useQuery({
    queryKey: ['dark-web-all-mentions', params],
    queryFn: async () => {
      const res = await api.get<DarkWebAllMentionsResponse>(
        `/api/darkweb/mentions${query ? `?${query}` : ''}`,
      );
      return (res.data ?? {
        results: [],
        total: 0,
        aggregates: {
          slice: {
            total_active: 0, confirmed_active: 0, suspicious_active: 0,
            critical_active: 0, high_active: 0, medium_active: 0, low_active: 0,
          },
          by_source: [],
          by_severity: [],
        },
        applied: {},
      }) as DarkWebAllMentionsResponse;
    },
    placeholderData: keepPreviousData,
  });
}

export function useDarkWebOverview(params: { limit?: number; offset?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();

  return useQuery({
    queryKey: ['dark-web-overview', params],
    queryFn: async () => {
      const res = await api.get<DarkWebOverviewRow[]>(
        `/api/darkweb/overview${query ? `?${query}` : ''}`,
      );
      const extras = res as unknown as { totals?: DarkWebOverviewResponse['totals'] };
      return {
        data: (res.data ?? []) as DarkWebOverviewRow[],
        total: res.total ?? 0,
        totals: extras.totals ?? {
          total: 0, confirmed: 0, suspicious: 0, critical: 0, high: 0,
        },
      };
    },
    placeholderData: keepPreviousData,
  });
}
