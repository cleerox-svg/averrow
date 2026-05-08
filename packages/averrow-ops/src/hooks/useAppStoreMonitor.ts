import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type AppClassification =
  | 'official'
  | 'legitimate'
  | 'suspicious'
  | 'impersonation'
  | 'unknown';

export type AppStoreStatus =
  | 'active'
  | 'resolved'
  | 'false_positive'
  | 'takedown_requested'
  | 'taken_down';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AppStoreListing {
  id: string;
  brand_id: string;
  store: string;
  app_id: string;
  bundle_id: string | null;
  app_name: string;
  developer_name: string | null;
  developer_id: string | null;
  seller_url: string | null;
  app_url: string | null;
  icon_url: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  rating_count: number | null;
  release_date: string | null;
  store_updated_at: string | null;
  version: string | null;
  categories: string | null;
  description: string | null;
  classification: AppClassification;
  classified_by: string | null;
  classification_confidence: number | null;
  classification_reason: string | null;
  ai_assessment: string | null;
  ai_confidence: number | null;
  ai_action: string | null;
  ai_assessed_at: string | null;
  impersonation_score: number;
  impersonation_signals: string | null;
  severity: Severity;
  status: AppStoreStatus;
  first_seen: string;
  last_checked: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppStoreScheduleRow {
  platform: string | null;
  last_checked: string | null;
  next_check: string | null;
  check_interval_hours: number;
  enabled: number;
}

export interface AppStoreMonitorResponse {
  brand: { id: string; name: string; domain: string | null };
  results: AppStoreListing[];
  total: number;
  schedule: AppStoreScheduleRow[];
}

export interface AppStoreMonitorParams {
  store?: string;
  classification?: AppClassification;
  severity?: Severity;
  status?: AppStoreStatus;
  limit?: number;
  offset?: number;
}

export function useAppStoreMonitor(brandId: string, params: AppStoreMonitorParams = {}) {
  const qs = new URLSearchParams();
  if (params.store) qs.set('store', params.store);
  if (params.classification) qs.set('classification', params.classification);
  if (params.severity) qs.set('severity', params.severity);
  if (params.status) qs.set('status', params.status);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();

  return useQuery({
    queryKey: ['app-store-monitor', brandId, params],
    queryFn: async () => {
      const res = await api.get<AppStoreMonitorResponse>(
        `/api/appstore/monitor/${brandId}${query ? `?${query}` : ''}`,
      );
      return (res.data ?? {
        brand: { id: brandId, name: '', domain: null },
        results: [],
        total: 0,
        schedule: [],
      }) as AppStoreMonitorResponse;
    },
    placeholderData: keepPreviousData,
    enabled: !!brandId,
  });
}

export function useScanAppStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) =>
      api.post(`/api/appstore/scan/${brandId}`),
    onSuccess: (_, brandId) => {
      qc.invalidateQueries({ queryKey: ['app-store-monitor', brandId] });
      qc.invalidateQueries({ queryKey: ['brand-extended', brandId] });
    },
  });
}

export function useClassifyAppStoreListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      listingId: string;
      brandId: string;
      classification?: AppClassification;
      status?: AppStoreStatus;
    }) => {
      const body: Record<string, string> = {};
      if (vars.classification) body.classification = vars.classification;
      if (vars.status) body.status = vars.status;
      return api.patch(`/api/appstore/${vars.listingId}`, body);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['app-store-monitor', vars.brandId] });
    },
  });
}

export interface OfficialAppInput {
  platform: string;
  app_id?: string;
  bundle_id?: string;
  developer_name?: string;
  developer_id?: string;
}

export interface AppStoreOverviewRow {
  id: string;
  brand_name: string;
  domain: string | null;
  official_apps: string | null;
  has_allowlist: boolean;
  counts: {
    total: number;
    impersonation: number;
    suspicious: number;
    legitimate: number;
    official: number;
    critical: number;
    high: number;
  };
  last_checked: string | null;
  next_check: string | null;
  created_at: string;
}

export interface AppStoreOverviewResponse {
  data: AppStoreOverviewRow[];
  total: number;
  totals: {
    total: number;
    impersonation: number;
    suspicious: number;
    legitimate: number;
    official: number;
  };
}

export function useAppStoreOverview(params: { limit?: number; offset?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();

  return useQuery({
    queryKey: ['app-store-overview', params],
    queryFn: async () => {
      const res = await api.get<AppStoreOverviewRow[]>(
        `/api/appstore/overview${query ? `?${query}` : ''}`,
      );
      // api.get returns { success, data, total, ... } — overview wrapper
      // carries a `totals` sibling that we need to surface.
      const extras = res as unknown as { totals?: AppStoreOverviewResponse['totals'] };
      return {
        data: (res.data ?? []) as AppStoreOverviewRow[],
        total: res.total ?? 0,
        totals: extras.totals ?? {
          total: 0, impersonation: 0, suspicious: 0, legitimate: 0, official: 0,
        },
      };
    },
    placeholderData: keepPreviousData,
  });
}

export function useUpdateOfficialApps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { brandId: string; official_apps: OfficialAppInput[] }) =>
      api.patch(`/api/brands/${vars.brandId}/official-apps`, {
        official_apps: vars.official_apps,
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['app-store-monitor', vars.brandId] });
      qc.invalidateQueries({ queryKey: ['brand-extended', vars.brandId] });
    },
  });
}
