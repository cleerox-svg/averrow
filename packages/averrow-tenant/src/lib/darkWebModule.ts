// Dark Web Monitoring API client.
//
// Backed by:
//   GET /api/orgs/:orgId/modules/dark-web
//   GET /api/orgs/:orgId/modules/dark-web/brands/:brandId

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export interface DarkWebBrandSummary {
  brand_id:                string;
  brand_name:              string;
  canonical_domain:        string;
  mentions_total:          number;
  mentions_confirmed:      number;
  mentions_suspicious:     number;
  mentions_unknown:        number;
  mentions_false_positive: number;
  mentions_high_critical:  number;
  sources_covered:         number;
}

export interface DarkWebModuleTotals {
  mentions_total:          number;
  mentions_confirmed:      number;
  mentions_suspicious:     number;
  mentions_unknown:        number;
  mentions_false_positive: number;
  mentions_high_critical:  number;
}

export interface DarkWebModuleSummary {
  org_id: number;
  brands: DarkWebBrandSummary[];
  totals: DarkWebModuleTotals;
}

export interface DarkWebMentionRow {
  id:                       string;
  brand_id:                 string;
  source:                   string;
  source_url:               string;
  source_channel:           string | null;
  source_author:            string | null;
  posted_at:                string | null;
  content_snippet:          string | null;
  matched_terms:            string | null;
  match_type:               string | null;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_assessment:            string | null;
  ai_action:                string | null;
  severity:                 string;
  status:                   string;
  first_seen:               string;
  last_seen:                string | null;
}

export interface BrandDarkWebFindings {
  brand_id:  string;
  mentions:  DarkWebMentionRow[];
  page_size: number;
}

export function useDarkWebModuleSummary() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<DarkWebModuleSummary>({
    queryKey: ['dark-web-module', orgId],
    queryFn: async () => {
      const res = await apiGet<DarkWebModuleSummary>(`/api/orgs/${orgId}/modules/dark-web`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export function useBrandDarkWebFindings(brandId: string | null) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<BrandDarkWebFindings>({
    queryKey: ['dark-web-brand-findings', orgId, brandId],
    queryFn: async () => {
      const res = await apiGet<BrandDarkWebFindings>(
        `/api/orgs/${orgId}/modules/dark-web/brands/${brandId}`,
      );
      return res.data;
    },
    enabled: !!orgId && !!brandId,
    staleTime: 30_000,
  });
}

// Customer-friendly source labels.
export const SOURCE_LABELS: Record<string, string> = {
  pastebin:        'Pastebin',
  telegram:        'Telegram leak channel',
  ransomware_leak: 'Ransomware leak site',
  hibp:            'HIBP',
  flare:           'Flare',
  darkowl:         'DarkOwl',
};

export const MATCH_TYPE_LABELS: Record<string, string> = {
  brand_name:   'Brand name',
  domain:       'Domain',
  executive:    'Executive',
  actor_alias:  'Actor alias',
  mixed:        'Multiple',
};

// ─── Org-scoped mentions table (powers the customer Dark Web page) ─

export type DarkWebSortKey =
  | 'last_seen' | 'first_seen' | 'posted_at' | 'severity' | 'source' | 'brand';

export interface DarkWebMentionWithBrand extends DarkWebMentionRow {
  brand_name:   string | null;
  brand_domain: string | null;
}

export interface DarkWebSliceAggregate {
  total_active:      number;
  confirmed_active:  number;
  suspicious_active: number;
  critical_active:   number;
  high_active:       number;
  medium_active:     number;
  low_active:        number;
}

export interface DarkWebOrgMentionsResponse {
  org_id:  number;
  results: DarkWebMentionWithBrand[];
  total:   number;
  aggregates: {
    slice:       DarkWebSliceAggregate;
    by_source:   Array<{ source: string;   n: number }>;
    by_severity: Array<{ severity: string; n: number }>;
  };
  applied: Record<string, unknown>;
}

export interface DarkWebOrgMentionsParams {
  source?:         string;
  classification?: string;
  severity?:       string;
  match_type?:     string;
  status?:         string;
  brand_id?:       string;
  q?:              string;
  sort?:           DarkWebSortKey;
  dir?:            'asc' | 'desc';
  limit?:          number;
  offset?:         number;
}

export function useDarkWebOrgMentions(params: DarkWebOrgMentionsParams = {}) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;

  const qs = new URLSearchParams();
  if (params.source)         qs.set('source',         params.source);
  if (params.classification) qs.set('classification', params.classification);
  if (params.severity)       qs.set('severity',       params.severity);
  if (params.match_type)     qs.set('match_type',     params.match_type);
  if (params.status)         qs.set('status',         params.status);
  if (params.brand_id)       qs.set('brand_id',       params.brand_id);
  if (params.q)              qs.set('q',              params.q);
  if (params.sort)           qs.set('sort',           params.sort);
  if (params.dir)            qs.set('dir',            params.dir);
  if (params.limit !== undefined)  qs.set('limit',  String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();

  return useQuery<DarkWebOrgMentionsResponse>({
    queryKey: ['dark-web-org-mentions', orgId, params],
    queryFn: async () => {
      const res = await apiGet<DarkWebOrgMentionsResponse>(
        `/api/orgs/${orgId}/modules/dark-web/mentions${query ? `?${query}` : ''}`,
      );
      return res.data;
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });
}
