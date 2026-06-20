// Tenant Investigations / Cases API client.
//
// A case groups related signals/threats/takedowns under one
// investigation with a status, an owner, a notes timeline, and an audit
// trail (TENANT_ANALYST_UX_RESEARCH_2026-06 #7). Reads are member-
// visible; mutations are analyst+ (useCanTriage), enforced server-side.
//
// Backed by /api/orgs/:orgId/investigations[/:id[/items|/notes]].

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from './api';
import { useAuth } from './auth';

export type InvestigationStatus = 'open' | 'monitoring' | 'closed';
export type InvestigationSeverity = 'critical' | 'high' | 'medium' | 'low';
export type InvestigationItemType = 'alert' | 'threat' | 'takedown';

export interface Investigation {
  id:               string;
  org_id:           number;
  title:            string;
  description:      string | null;
  status:           InvestigationStatus;
  severity:         InvestigationSeverity;
  assigned_to:      string | null;
  assigned_to_name: string | null;
  created_by:       string | null;
  created_by_name:  string | null;
  created_at:       string;
  updated_at:       string;
  closed_at:        string | null;
  item_count?:      number;
  note_count?:      number;
}

export interface InvestigationItem {
  id:          string;          // the link row id (used to remove)
  item_type:   InvestigationItemType;
  item_id:     string;          // the underlying alert/threat/takedown id
  note:        string | null;
  added_at:    string;
  label:       string | null;   // resolved title/domain/target
  severity:    string | null;
  item_status: string | null;
}

export interface InvestigationNote {
  id:          string;
  author_id:   string | null;
  author_name: string | null;
  body:        string;
  created_at:  string;
}

export interface InvestigationDetail extends Investigation {
  items: InvestigationItem[];
  notes: InvestigationNote[];
}

export interface StatusBreakdown { status: InvestigationStatus; count: number }

export interface InvestigationsResponse {
  data:             Investigation[];
  total:            number;
  status_breakdown: StatusBreakdown[];
}

export function useInvestigations(status?: InvestigationStatus | 'all') {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  return useQuery<InvestigationsResponse>({
    queryKey: ['investigations', orgId, params.toString()],
    queryFn: async () => {
      const res = await apiGet<Investigation[]>(`/api/orgs/${orgId}/investigations?${params}`) as unknown as InvestigationsResponse;
      return {
        data: res.data ?? [],
        total: res.total ?? 0,
        status_breakdown: res.status_breakdown ?? [],
      };
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export function useInvestigation(id: string | undefined) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<InvestigationDetail>({
    queryKey: ['investigation', orgId, id],
    queryFn: async () => {
      const res = await apiGet<InvestigationDetail>(`/api/orgs/${orgId}/investigations/${id}`);
      return res.data;
    },
    enabled: hasOrg && !!orgId && !!id,
    staleTime: 15_000,
  });
}

export interface CreateInvestigationInput {
  title:        string;
  description?: string;
  severity?:    InvestigationSeverity;
  items?:       Array<{ item_type: InvestigationItemType; item_id: string; note?: string }>;
}

export function useCreateInvestigation() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInvestigationInput) =>
      apiPost<{ id: string }>(`/api/orgs/${orgId}/investigations`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['investigations', orgId] }),
  });
}

export interface UpdateInvestigationInput {
  title?:       string;
  description?: string | null;
  status?:      InvestigationStatus;
  severity?:    InvestigationSeverity;
  assigned_to?: string | null;
}

export function useUpdateInvestigation(id: string) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UpdateInvestigationInput) =>
      apiPatch<{ id: string }>(`/api/orgs/${orgId}/investigations/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['investigation', orgId, id] });
      qc.invalidateQueries({ queryKey: ['investigations', orgId] });
    },
  });
}

export function useAddInvestigationItem(id: string) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: { item_type: InvestigationItemType; item_id: string; note?: string }) =>
      apiPost<{ added: boolean }>(`/api/orgs/${orgId}/investigations/${id}/items`, item),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['investigation', orgId, id] });
      qc.invalidateQueries({ queryKey: ['investigations', orgId] });
    },
  });
}

export function useRemoveInvestigationItem(id: string) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (linkId: string) =>
      apiDelete<{ id: string }>(`/api/orgs/${orgId}/investigations/${id}/items/${linkId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['investigation', orgId, id] });
      qc.invalidateQueries({ queryKey: ['investigations', orgId] });
    },
  });
}

export function useAddInvestigationNote(id: string) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) =>
      apiPost<{ id: string }>(`/api/orgs/${orgId}/investigations/${id}/notes`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['investigation', orgId, id] }),
  });
}

// "Add this signal to an investigation" — used from the Intelligence Card.
// Adds an item to an existing case via the same items endpoint, but keyed
// off no particular detail query so it can be called from anywhere.
export function useLinkToInvestigation() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ investigationId, item_type, item_id }: {
      investigationId: string; item_type: InvestigationItemType; item_id: string;
    }) => apiPost<{ added: boolean }>(`/api/orgs/${orgId}/investigations/${investigationId}/items`, { item_type, item_id }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['investigation', orgId, vars.investigationId] });
      qc.invalidateQueries({ queryKey: ['investigations', orgId] });
    },
  });
}

export const INVESTIGATION_STATUS_LABELS: Record<InvestigationStatus, string> = {
  open: 'Open', monitoring: 'Monitoring', closed: 'Closed',
};
