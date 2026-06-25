import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type IntegrationStatus =
  | 'live' | 'paused' | 'disabled' | 'active' | 'unconfigured';

export interface IntegrationHealth {
  kind: string;
  label: string;
  channel: 'api' | 'email';
  api_type: string | null;
  provider_name: string | null;
  configured: boolean;
  auto_submit_enabled: boolean | null;
  status: IntegrationStatus;
  total: number;
  submitted: number;
  queued: number;
  rejected: number;
  failed: number;
  success_rate: number | null;
  last_submission_at: string | null;
  last_error: string | null;
}

export interface IntegrationsReport {
  window_hours: number;
  send_mode: 'live' | 'draft';
  integrations: IntegrationHealth[];
}

export function useTakedownIntegrations(hours = 168) {
  return useQuery({
    queryKey: ['takedown-integrations', hours],
    queryFn: async () => {
      const res = await api.get<IntegrationsReport>(`/api/admin/takedowns/integrations?hours=${hours}`);
      return res.data;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}
