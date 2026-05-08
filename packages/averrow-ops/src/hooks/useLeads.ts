import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface SalesLead {
  id: string;
  brand_id: string;
  status: string;
  prospect_score: number;
  pitch_angle: string | null;

  // Company info
  company_name: string | null;
  company_domain: string | null;
  company_industry: string | null;
  company_size: string | null;
  company_revenue_range: string | null;
  company_hq: string | null;

  // Security posture
  email_security_grade: string | null;
  threat_count_30d: number | null;
  phishing_urls_active: number | null;
  trap_catches_30d: number | null;
  composite_risk_score: number | null;
  findings_summary: string | null;

  // Target contact
  target_name: string | null;
  target_title: string | null;
  target_email: string | null;
  target_linkedin: string | null;

  // Outreach
  outreach_variant_1: string | null;
  outreach_variant_2: string | null;
  outreach_selected: string | null;
  outreach_channel: string | null;
  outreach_sent_at: string | null;

  // AI enrichment
  ai_enriched: number;
  ai_enriched_at: string | null;

  // Meta
  notes: string | null;
  created_at: string;
  updated_at: string;
  response_received_at: string | null;
  response_sentiment: string | null;
  meeting_booked_at: string | null;
}

interface LeadStats {
  pipeline: {
    total: number;
    new_count: number;
    researched_count: number;
    drafted_count: number;
    approved_count: number;
    sent_count: number;
    responded_count: number;
    meeting_count: number;
    converted_count: number;
    declined_count: number;
  };
  weekly: {
    identified_7d: number;
    sent_7d: number;
    responded_7d: number;
  };
  response_rate: number;
  conversion_rate: number;
}

export type { SalesLead, LeadStats };

export function useLeads(options?: { status?: string; pitch_angle?: string }) {
  const { status, pitch_angle } = options || {};
  return useQuery({
    queryKey: ['leads', status, pitch_angle],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (pitch_angle) params.set('pitch_angle', pitch_angle);
      const res = await api.get<{ leads: SalesLead[]; total: number; stats: Record<string, number> }>(`/api/admin/sales-leads?${params}`);
      const data = res.data;
      return { data: data?.leads || [], total: data?.total || 0 };
    },
    placeholderData: keepPreviousData,
  });
}

export function useLead(id: string | null) {
  return useQuery({
    queryKey: ['lead', id],
    queryFn: async () => {
      if (!id) return null;
      const res = await api.get<SalesLead>(`/api/admin/sales-leads/${id}`);
      return res.data || null;
    },
    placeholderData: keepPreviousData,
    enabled: !!id,
  });
}

export function useLeadStats() {
  return useQuery({
    queryKey: ['lead-stats'],
    queryFn: async () => {
      const res = await api.get<LeadStats>('/api/admin/sales-leads/stats');
      return res.data || null;
    },
    placeholderData: keepPreviousData,
  });
}

export function useEnrichLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api.post('/api/admin/pathfinder-enrich');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

export function useUpdateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; status?: string; notes?: string }) => {
      return api.patch(`/api/admin/sales-leads/${id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead'] });
    },
  });
}
