import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type IntegrationStatus =
  | 'live' | 'paused' | 'disabled' | 'active' | 'unconfigured';

/** Takedown provider row backing an API integration. */
export interface IntegrationProvider {
  id: number;
  provider_name: string;
  provider_type: string | null;
  abuse_email: string | null;
  abuse_url: string | null;
  abuse_api_url: string | null;
  abuse_api_type: string;
  auto_submit_enabled: boolean;
}

/** Configuration detail for the integration config panel. Optional: an older API omits it. */
export interface IntegrationConfig {
  /** Secret NAMES only; values are never exposed. */
  credential_secrets: string[];
  optional_vars: string[];
  requires_live_mode: boolean;
  send_mode: 'live' | 'draft';
  provider: IntegrationProvider | null;
  auto_submit_editable: boolean;
}

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
  /** UTC calendar-month usage against a self-imposed cap (Web Risk: Google's free allowance). */
  monthly_quota?: { used: number | null; cap: number };
  config?: IntegrationConfig;
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

/**
 * Flip a provider's auto-submit switch. The api client resolves 4xx with a
 * `{ success: false, error }` envelope instead of throwing, so convert that
 * to a rejection here (callers show the message and revert).
 */
export function useSetIntegrationAutoSubmit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, enabled }: { kind: string; enabled: boolean }) => {
      const res = await api.patch<IntegrationHealth>(
        `/api/admin/takedowns/integrations/${encodeURIComponent(kind)}`,
        { auto_submit_enabled: enabled },
      );
      if (!res.success) throw new Error(res.error || 'Could not update auto-submit');
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takedown-integrations'] }),
  });
}
