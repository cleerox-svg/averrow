// Hooks for the public-scan funnel (scan_leads table).
//
// Distinct from useLeads.ts which targets sales_leads (Pathfinder
// agent's auto-generated prospects). Three lead tables in the
// platform — see migrations/0115 + brandScan.ts comments — and these
// hooks bind to the one fed by the homepage scan widget.
//
// Endpoints:
//   GET   /api/admin/leads                    — list + stats
//   PATCH /api/admin/leads/:id                — update status / notes
//   POST  /api/admin/leads/:id/qualified-report — generate Brand Risk Plan
//   POST  /api/admin/leads/:id/outreach       — send templated email
//   POST  /api/admin/leads/:id/convert-to-tenant — spin up org

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface ScanLead {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  domain: string | null;
  form_type: string;
  source: string;
  message: string | null;
  status: "new" | "contacted" | "qualified" | "converted" | "closed_lost";
  notes: string | null;
  // Funnel-state fields from migration 0117
  correlated_brand_id: string | null;
  outreach_sent_at: string | null;
  outreach_email_id: string | null;
  converted_org_id: number | null;
  converted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanLeadStats {
  total: number;
  new_leads: number;
  contacted: number;
  qualified: number;
  converted: number;
}

export interface ScanLeadsResponse {
  leads: ScanLead[];
  stats: ScanLeadStats | null;
}

export function useScanLeads(options?: { status?: string }) {
  const params = new URLSearchParams();
  if (options?.status) params.set("status", options.status);
  return useQuery({
    queryKey: ["scan-leads", options?.status ?? "all"],
    queryFn: async () => {
      const qs = params.toString();
      const res = await api.get<ScanLeadsResponse>(`/api/admin/leads${qs ? `?${qs}` : ""}`);
      return res.data ?? { leads: [], stats: null };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

export function useUpdateScanLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status?: string; notes?: string }) => {
      return api.patch(`/api/admin/leads/${id}`, { status, notes });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scan-leads"] });
    },
  });
}

export interface QualifiedReportResponse {
  report_id: string;
  share_url: string;
  share_token: string;
  expires_at: string;
  risk_grade: string;
}

export function useGenerateQualifiedReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post<QualifiedReportResponse>(`/api/admin/leads/${id}/qualified-report`, {});
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scan-leads"] });
    },
  });
}

export interface OutreachResponse {
  sent_to: string;
  email_id: string;
  share_url: string;
}

export function useSendOutreach() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post<OutreachResponse>(`/api/admin/leads/${id}/outreach`, {});
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scan-leads"] });
    },
  });
}

export interface ConvertResponse {
  org_id: number;
  slug: string;
  invite_code: string;
  brand_id: string;
  brand_was_created: boolean;
  super_admin_role: string;
}

export function useConvertToTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body?: { org_name?: string; plan?: string } }) => {
      const res = await api.post<ConvertResponse>(`/api/admin/leads/${id}/convert-to-tenant`, body ?? {});
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scan-leads"] });
    },
  });
}
