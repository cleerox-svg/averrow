import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface SalesLead {
  id: string;
  brand_id: string;
  status: string;
  prospect_score: number;
  pitch_angle: string | null;
  score_breakdown_json: string | null;

  // Company info
  company_name: string | null;
  company_domain: string | null;
  company_industry: string | null;
  company_size: string | null;
  company_revenue_range: string | null;
  company_hq: string | null;

  // Firmographic snapshot — canonical, structured values from
  // brand_firmographics (SEC EDGAR / Wikidata). Distinct from company_size
  // (free-text AI category) and company_industry (free-text AI tag).
  revenue_band: string | null;          // '<10M' | '10-50M' | '50-250M' | '250M-1B' | '1B+'
  employee_band: string | null;         // '<50' | '50-250' | '250-1K' | '1K-10K' | '10K+'
  industry_naics: string | null;
  is_public: number | null;             // 0 | 1
  ticker: string | null;
  founded_year: number | null;
  parent_company: string | null;

  // Security posture
  email_security_grade: string | null;
  threat_count_30d: number | null;
  phishing_urls_active: number | null;
  trap_catches_30d: number | null;
  composite_risk_score: number | null;
  findings_summary: string | null;

  // Buying signals — public data that hints procurement intent.
  security_maturity: string | null;     // 'high' | 'medium' | 'low'
  last_breach_disclosed_at: string | null;
  security_news_headline: string | null;
  security_news_url: string | null;
  cyber_10k_mentions: number | null;

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
  identified_by: string | null;
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

export function useLeads(options?: { status?: string; pitch_angle?: string; identified_by?: string }) {
  const { status, pitch_angle, identified_by } = options || {};
  return useQuery({
    queryKey: ['leads', status, pitch_angle, identified_by],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (pitch_angle) params.set('pitch_angle', pitch_angle);
      if (identified_by) params.set('identified_by', identified_by);
      params.set('limit', '500'); // full pipeline in one page; views filter client-side
      const res = await api.get<{ leads: SalesLead[]; total: number; stats: Record<string, number> }>(`/api/admin/sales-leads?${params}`);
      const data = res.data;
      return { data: data?.leads || [], total: data?.total || 0 };
    },
    placeholderData: keepPreviousData,
  });
}

// The inbound scan_leads counterpart for the same company, matched at
// read time by company_domain ↔ domain (backend GET /api/admin/sales-leads/:id).
export interface CorrelatedScanLead {
  id: string;
  email: string;
  company: string | null;
  status: string;
  created_at: string;
}

export type SalesLeadDetail = SalesLead & {
  correlated_scan_lead?: CorrelatedScanLead | null;
};

export function useLead(id: string | null) {
  return useQuery({
    queryKey: ['lead', id],
    queryFn: async () => {
      if (!id) return null;
      const res = await api.get<SalesLeadDetail>(`/api/admin/sales-leads/${id}`);
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

type UpdateLeadBody = {
  status?: string;
  notes?: string;
  target_name?: string;
  target_title?: string;
  target_email?: string;
  target_linkedin?: string;
  outreach_variant_1?: string;
  outreach_variant_2?: string;
  company_industry?: string;
  company_size?: string;
  company_hq?: string;
  security_maturity?: string;
};

export function useUpdateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & UpdateLeadBody) => {
      return api.patch(`/api/admin/sales-leads/${id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead'] });
    },
  });
}

// Triggers a cheap (no-AI) refresh that re-runs SEC/Wikidata enrichment
// for the underlying brand and copies the refreshed firmographic row
// onto this lead's snapshot columns.
export function useRefreshLeadFirmographics() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api.post(`/api/admin/sales-leads/${id}/refresh-firmographics`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead'] });
    },
  });
}
