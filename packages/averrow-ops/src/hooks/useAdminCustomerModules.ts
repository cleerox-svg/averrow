// Customer Modules — super_admin module-entitlement management.
//
// Backed by:
//   GET  /api/orgs/:orgId/modules                       (list with status)
//   POST /api/admin/orgs/:orgId/modules                 (activate / suspend)
//
// Activate accepts an optional trial_ends_at (ISO datetime). If
// provided, the module status flips to 'trial' and the customer
// sees a countdown until the trial ends; the Stripe webhook flips
// it to 'active' or 'cancelled' on conversion.
//
// Phase D — Customers page module-management gap (operator-flagged).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type ModuleStatus = 'not_entitled' | 'trial' | 'active' | 'suspended';

export interface CustomerModule {
  module_key:    string;
  status:        ModuleStatus;
  activated_at?: string | null;
  trial_ends_at: string | null;
  suspended_at:  string | null;
  metrics:       Array<{
    module_key:       string;
    metric_key:       string;
    label:            string;
    unit:             string;
    is_billable:      number;
    description:      string | null;
    value_this_month: number;
  }>;
}

export interface CustomerModulesResponse {
  org_id:                 number;
  modules:                CustomerModule[];
  authorization_summary?: {
    signed:                  boolean;
    agreement_version?:      string;
    signed_at?:              string;
    modules_covered?:        string[];
    max_takedowns_per_month?: number | null;
  };
}

export const MODULE_LABELS: Record<string, string> = {
  domain:        'Domain Monitoring',
  social:        'Social Impersonation',
  app_store:     'App Store Impersonation',
  dark_web:      'Dark Web Monitoring',
  abuse_mailbox: 'Abuse Mailbox',
  trademark:     'Trademark Infringement',
  threat_actor:  'Threat-Actor Intelligence',
};

export function useCustomerModules(orgId: string | null) {
  return useQuery<CustomerModulesResponse>({
    queryKey: ['admin-customer-modules', orgId],
    queryFn: async () => {
      const res = await api.get<CustomerModulesResponse>(`/api/orgs/${orgId}/modules`);
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load modules');
      return res.data;
    },
    enabled: !!orgId,
    staleTime: 15_000,
  });
}

interface ActivateInput {
  module_key:     string;
  trial_ends_at?: string | null;
  config_json?:   string;
}

interface SuspendInput {
  module_key: string;
}

export function useActivateModule(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ActivateInput) => {
      if (!orgId) throw new Error('orgId required');
      const res = await api.post<{ org_id: number; module_key: string; action: string }>(
        `/api/admin/orgs/${orgId}/modules`,
        { action: 'activate', ...input },
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Activation failed');
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-customer-modules', orgId] });
      void qc.invalidateQueries({ queryKey: ['admin-customer-pricing', orgId] });
    },
  });
}

export function useSuspendModule(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SuspendInput) => {
      if (!orgId) throw new Error('orgId required');
      const res = await api.post<{ org_id: number; module_key: string; action: string }>(
        `/api/admin/orgs/${orgId}/modules`,
        { action: 'suspend', ...input },
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Suspension failed');
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-customer-modules', orgId] });
      void qc.invalidateQueries({ queryKey: ['admin-customer-pricing', orgId] });
    },
  });
}
