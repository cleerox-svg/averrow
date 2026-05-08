import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface BrandHealth {
  id: string;
  name: string;
  canonical_domain: string;
  email_security_score: number | null;
  email_security_grade: string | null;
  exposure_score: number | null;
  threat_count: number;
  active_threats: number;
}

interface RecentThreat {
  id: string;
  threat_type: string;
  severity: string;
  malicious_domain: string | null;
  status: string;
  created_at: string;
  brand_name: string | null;
}

interface RecentAlert {
  id: string;
  title: string;
  severity: string;
  status: string;
  alert_type: string;
  created_at: string;
  brand_name: string | null;
}

interface TakedownSummary {
  total: number;
  pending: number;
  taken_down: number;
  failed: number;
}

interface BrandAdminDashboardData {
  total_threats: number;
  active_threats: number;
  brand_count: number;
  avg_email_score: number | null;
  recent_threats: RecentThreat[];
  brand_health: BrandHealth[];
  recent_alerts: RecentAlert[];
  takedown_summary: TakedownSummary;
}

export function useBrandAdminDashboard() {
  return useQuery({
    queryKey: ['brand-admin-dashboard'],
    queryFn: async () => {
      const res = await api.get<BrandAdminDashboardData>('/api/dashboard/brand-admin');
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load dashboard');
      return res.data;
    },
    refetchInterval: 60_000,
  });
}
