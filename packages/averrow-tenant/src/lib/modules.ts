// averrow-tenant — module entitlement client.
//
// Talks to GET /api/orgs/:orgId/modules (handler in
// packages/averrow-worker/src/handlers/tenantModules.ts). Returns the
// 7 canonical modules with their entitlement status, metric
// definitions, this-month usage rollup, and the active takedown
// authorization summary.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export type ModuleKey =
  | 'domain'
  | 'social'
  | 'app_store'
  | 'dark_web'
  | 'abuse_mailbox'
  | 'trademark'
  | 'threat_actor';

export type ModuleStatus = 'active' | 'trial' | 'suspended' | 'not_entitled';

export interface ModuleMetric {
  module_key:        string;
  metric_key:        string;
  label:             string;
  unit:              string;
  is_billable:       number;
  description:       string | null;
  value_this_month:  number;
}

export interface TenantModuleSurface {
  module_key:    ModuleKey;
  status:        ModuleStatus;
  activated_at?: string;
  trial_ends_at?: string | null;
  suspended_at?: string | null;
  metrics:       ModuleMetric[];
}

export interface TakedownAuthorizationSummary {
  signed:                   boolean;
  agreement_version?:       string;
  signed_at?:               string;
  modules_covered?:         ModuleKey[];
  max_takedowns_per_month?: number | null;
}

export interface TenantModulesResponse {
  org_id:                  number;
  modules:                 TenantModuleSurface[];
  takedown_authorization:  TakedownAuthorizationSummary;
}

export const MODULE_LABELS: Record<ModuleKey, string> = {
  domain:        'Domain Monitoring',
  social:        'Social Media Impersonation',
  app_store:     'App Store Impersonation',
  dark_web:      'Dark Web Monitoring',
  abuse_mailbox: 'Abuse Mailbox',
  trademark:     'Trademark Infringement',
  threat_actor:  'Threat-Actor Intelligence',
};

export const MODULE_DESCRIPTIONS: Record<ModuleKey, string> = {
  domain:        'Typosquats, lookalike domains, malicious URLs targeting your brand.',
  social:        'Fake accounts, executive impersonation, brand-misuse handles.',
  app_store:     'Fake apps across Apple, Google Play, and alternative stores.',
  dark_web:      'Brand mentions, leaked credentials, executive exposure.',
  abuse_mailbox: 'Customer-branded report-fraud inbox with auto-triage and response.',
  trademark:     'Logo, wordmark, and likeness misuse beyond domains and social.',
  threat_actor:  'Actor-centric pivots, MO, kits, and AI-content fingerprints.',
};

export function useTenantModules() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;

  return useQuery<TenantModulesResponse>({
    queryKey: ['tenant-modules', orgId],
    queryFn: async () => {
      const res = await apiGet<TenantModulesResponse>(`/api/orgs/${orgId}/modules`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}
