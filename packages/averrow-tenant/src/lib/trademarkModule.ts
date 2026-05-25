// Trademark Infringement API client.
//
// Backed by:
//   GET /api/orgs/:orgId/modules/trademark
//   GET /api/orgs/:orgId/modules/trademark/brands/:brandId

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from './api';
import { useAuth } from './auth';

export interface TrademarkBrandSummary {
  brand_id:                 string;
  brand_name:               string;
  canonical_domain:         string;
  assets_active:            number;
  findings_total:           number;
  findings_confirmed:       number;
  findings_likely:          number;
  findings_unknown:         number;
  findings_false_positive:  number;
  findings_high_critical:   number;
  contexts_covered:         number;
}

export interface TrademarkModuleTotals {
  assets_active:           number;
  findings_total:          number;
  findings_confirmed:      number;
  findings_likely:         number;
  findings_unknown:        number;
  findings_false_positive: number;
  findings_high_critical:  number;
}

export interface TrademarkModuleSummary {
  org_id: number;
  brands: TrademarkBrandSummary[];
  totals: TrademarkModuleTotals;
}

export interface TrademarkAssetRow {
  id:                   string;
  brand_id:             string;
  asset_type:           string;
  asset_name:           string | null;
  asset_url:            string | null;
  asset_hash:           string | null;
  phash:                string | null;
  registration_country: string | null;
  registration_number:  string | null;
  registration_date:    string | null;
  status:               string;
  created_at:           string;
}

export interface TrademarkFindingRow {
  id:                       string;
  brand_id:                 string;
  asset_id:                 string | null;
  found_url:                string;
  found_context:            string | null;
  found_image_url:          string | null;
  found_at:                 string;
  found_phash:              string | null;
  match_distance:           number | null;
  match_confidence:         number | null;
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

export interface BrandTrademarkFindings {
  brand_id:  string;
  assets:    TrademarkAssetRow[];
  findings:  TrademarkFindingRow[];
  page_size: number;
}

export function useTrademarkModuleSummary() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<TrademarkModuleSummary>({
    queryKey: ['trademark-module', orgId],
    queryFn: async () => {
      const res = await apiGet<TrademarkModuleSummary>(`/api/orgs/${orgId}/modules/trademark`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export function useBrandTrademarkFindings(brandId: string | null) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<BrandTrademarkFindings>({
    queryKey: ['trademark-brand-findings', orgId, brandId],
    queryFn: async () => {
      const res = await apiGet<BrandTrademarkFindings>(
        `/api/orgs/${orgId}/modules/trademark/brands/${brandId}`,
      );
      return res.data;
    },
    enabled: !!orgId && !!brandId,
    staleTime: 30_000,
  });
}

export interface UploadAssetInput {
  brand_id:              string;
  asset_type:            'logo' | 'wordmark' | 'combined';
  asset_name?:           string;
  content_type:          string;
  data_base64:           string;
  registration_country?: string;
  registration_number?:  string;
}

/** Upload a logo/wordmark image for a brand. Stores it server-side (R2)
 *  and registers a trademark_assets row. Invalidates the brand findings
 *  query so the new asset appears without a manual refresh. */
export function useUploadTrademarkAsset() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadAssetInput) => {
      if (!orgId) throw new Error('No organization');
      const { brand_id, ...payload } = input;
      const res = await apiPost<{ id: string; asset_url: string }>(
        `/api/orgs/${orgId}/modules/trademark/brands/${brand_id}/assets`,
        payload,
      );
      return res.data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['trademark-brand-findings', orgId, vars.brand_id] });
      qc.invalidateQueries({ queryKey: ['trademark-module', orgId] });
    },
  });
}

/** Remove (retire) an uploaded asset. */
export function useDeleteTrademarkAsset(brandId: string | null) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (assetId: string) => {
      if (!orgId) throw new Error('No organization');
      await apiDelete(`/api/orgs/${orgId}/modules/trademark/assets/${assetId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trademark-brand-findings', orgId, brandId] });
      qc.invalidateQueries({ queryKey: ['trademark-module', orgId] });
    },
  });
}

export const ASSET_TYPE_LABELS: Record<string, string> = {
  logo:     'Logo',
  wordmark: 'Wordmark',
  combined: 'Combined',
};

export const CONTEXT_LABELS: Record<string, string> = {
  website:     'Website',
  social:      'Social',
  app_store:   'App store',
  marketplace: 'Marketplace',
  other:       'Other',
};
