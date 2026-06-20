// Tenant takedowns API client.
//
// Backed by:
//   GET /api/orgs/:orgId/takedowns
//   GET /api/orgs/:orgId/takedowns/:takedownId

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from './api';
import { useAuth } from './auth';

export interface TakedownListRow {
  id:                     string;
  org_id:                 number | null;
  brand_id:               string;
  brand_name:             string | null;
  module_key:             string | null;
  target_type:            string;
  target_value:           string;
  target_url:             string | null;
  status:                 string;
  severity:               string;
  provider_name:          string | null;
  provider_method:        string | null;
  evidence_summary:       string;
  submitted_at:           string | null;
  resolved_at:            string | null;
  resolution:             string | null;
  created_at:             string;
  submission_count:       number;
}

export interface TakedownTotals {
  total:             number;
  by_status:         Record<string, number>;
  active:            number;
  completed:         number;
  failed_or_expired: number;
}

export interface TakedownsList {
  org_id:           number;
  takedowns:        TakedownListRow[];
  page_size:        number;
  totals:           TakedownTotals;
  status_priority:  string[];
}

export interface TakedownDetailRow extends TakedownListRow {
  source_type:            string | null;
  source_id:              string | null;
  evidence_detail:        string | null;
  evidence_urls:          string | null;
  screenshot_url:         string | null;
  provider_abuse_contact: string | null;
  priority_score:         number;
  requested_at:           string | null;
  response_received_at:   string | null;
  response_notes:         string | null;
  notes:                  string | null;
  updated_at:             string;
}

export interface TakedownSubmissionAuditRow {
  id:                string;
  takedown_id:       string;
  provider_id:       number | null;
  submitter_kind:    string;
  submitter_target:  string | null;
  request_summary:   string | null;
  outcome:           string;
  response_status:   number | null;
  response_body:     string | null;
  ticket_id:         string | null;
  error_message:     string | null;
  attempted_at:      string;
  duration_ms:       number | null;
}

export interface TakedownDetail {
  takedown:    TakedownDetailRow;
  submissions: TakedownSubmissionAuditRow[];
}

export interface TakedownsFilters {
  status?:  string | null;
  module?:  string | null;
  brandId?: string | null;
}

function buildQuery(f: TakedownsFilters): string {
  const params: string[] = [];
  if (f.status)  params.push(`status=${encodeURIComponent(f.status)}`);
  if (f.module)  params.push(`module=${encodeURIComponent(f.module)}`);
  if (f.brandId) params.push(`brandId=${encodeURIComponent(f.brandId)}`);
  return params.length > 0 ? `?${params.join('&')}` : '';
}

export function useTenantTakedowns(filters: TakedownsFilters = {}) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<TakedownsList>({
    queryKey: ['tenant-takedowns', orgId, filters.status ?? null, filters.module ?? null, filters.brandId ?? null],
    queryFn: async () => {
      const res = await apiGet<TakedownsList>(`/api/orgs/${orgId}/takedowns${buildQuery(filters)}`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export function useTenantTakedownDetail(takedownId: string | null) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<TakedownDetail>({
    queryKey: ['tenant-takedown-detail', orgId, takedownId],
    queryFn: async () => {
      const res = await apiGet<TakedownDetail>(`/api/orgs/${orgId}/takedowns/${takedownId}`);
      return res.data;
    },
    enabled: !!orgId && !!takedownId,
    staleTime: 30_000,
  });
}

/** Analyst-driven takedown transitions exposed to the tenant — mirrors the
 *  backend TENANT_ALLOWED_TRANSITIONS (handlers/takedowns.ts):
 *    draft     → requested (approve) | withdrawn (reject)
 *    requested → withdrawn (pull back before submission)
 *  'requested' hands the draft to the submission pipeline; 'withdrawn'
 *  declines it. */
export type TakedownAction = 'requested' | 'withdrawn';

/** Which actions an analyst can take on a takedown in a given status. */
export function takedownActionsFor(status: string): TakedownAction[] {
  if (status === 'draft')     return ['requested', 'withdrawn'];
  if (status === 'requested') return ['withdrawn'];
  return [];
}

/** Approve (requested) or reject (withdrawn) a takedown. Invalidates the
 *  takedowns list + detail so the queue and counts refresh. */
export function useUpdateTakedown() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ takedownId, status, notes }: { takedownId: string; status: TakedownAction; notes?: string }) => {
      return apiPatch<{ message: string }>(
        `/api/orgs/${orgId}/takedowns/${takedownId}`,
        { status, ...(notes ? { notes } : {}) },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-takedowns', orgId] });
      qc.invalidateQueries({ queryKey: ['tenant-takedown-detail', orgId] });
      qc.invalidateQueries({ queryKey: ['tenant-dashboard', orgId] });
    },
  });
}

export const STATUS_LABELS: Record<string, string> = {
  draft:            'Draft',
  requested:        'Requested',
  submitted:        'Submitted',
  pending_response: 'Pending response',
  taken_down:       'Taken down',
  failed:           'Failed',
  expired:          'Expired',
  withdrawn:        'Withdrawn',
};

export const MODULE_LABELS: Record<string, string> = {
  domain:        'Domain',
  social:        'Social',
  app_store:     'App store',
  dark_web:      'Dark web',
  abuse_mailbox: 'Abuse mailbox',
  trademark:     'Trademark',
  threat_actor:  'Threat actor',
};

export const SUBMITTER_KIND_LABELS: Record<string, string> = {
  email_draft:          'Email draft',
  followup_email_draft: 'Follow-up email',
  none:                 'No submitter matched',
};
