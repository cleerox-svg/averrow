// Tenant takedown-authorization API client.
//
// Backed by:
//   GET    /api/orgs/:orgId/takedown-authorization  (tenant-readable)
//   DELETE /api/orgs/:orgId/takedown-authorization  (org admin/owner)
//
// Tenant-side signing (POST) lands once the MSA copy is approved;
// today the record path is super-admin only and lives on the staff
// side. Until then this client supports view + revoke.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from './api';
import { useAuth } from './auth';

export type AuthorizationStatus = 'active' | 'revoked' | 'expired';

export type EscalationMode = 'auto_resubmit_on_pivot' | 'manual_only';

/** Canonical takedown automation posture — mirrors backend AutomationMode. */
export type AutomationMode = 'off' | 'semi_auto' | 'auto';

/** Per-characteristic auto-submit criteria (applied only when mode==='semi_auto'). */
export interface SemiAutoRules {
  auto_severities: string[];
  auto_target_types: string[];
  auto_provider_types: string[];
}

export interface AuthorizationScope {
  modules: string[];
  max_takedowns_per_month: number | null;
  escalation: EscalationMode;
  auto_followup_breached_sla_hours: number | null;
  high_risk_requires_per_takedown_approval: boolean;
  mode: AutomationMode;
  semi_auto_rules: SemiAutoRules;
}

// ── Semi-auto rule domains (mirror backend lib/takedown-policy.ts) ──
export const POLICY_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const POLICY_TARGET_TYPES = ['domain', 'social_profile', 'url', 'email', 'mobile_app'] as const;
export const POLICY_PROVIDER_TYPES = ['registrar', 'hosting', 'social_platform', 'cdn', 'email_provider', 'reporting'] as const;

export const TARGET_TYPE_LABELS: Record<string, string> = {
  domain: 'Domains',
  social_profile: 'Social profiles',
  url: 'URLs',
  email: 'Email',
  mobile_app: 'Mobile apps',
};

export const PROVIDER_TYPE_LABELS: Record<string, string> = {
  registrar: 'Registrars',
  hosting: 'Hosting',
  social_platform: 'Social platforms',
  cdn: 'CDNs',
  email_provider: 'Email providers',
  reporting: 'Blocklists / reporting',
};

export const DEFAULT_SEMI_AUTO_RULES: SemiAutoRules = {
  auto_severities: ['LOW', 'MEDIUM'],
  auto_target_types: [],
  auto_provider_types: [],
};

/** Customer-facing labels for the three postures. */
export const MODE_LABELS: Record<AutomationMode, string> = {
  off: 'Off',
  semi_auto: 'Semi-Auto',
  auto: 'Auto',
};

export interface TakedownAuthorization {
  id:                 string;
  org_id:             number;
  agreement_version:  string;
  status:             AuthorizationStatus;
  signed_at:          string;
  signed_by_user_id:  string;
  signed_ip:          string | null;
  signed_user_agent:  string | null;
  scope:              AuthorizationScope;
  revoked_at:         string | null;
  revoked_by_user_id: string | null;
  revoked_reason:     string | null;
  created_at:         string;
  updated_at:         string;
}

interface AuthorizationResponse {
  org_id:        number;
  authorization: TakedownAuthorization | null;
}

export function useTakedownAuthorization() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<AuthorizationResponse>({
    queryKey: ['tenant-takedown-authorization', orgId],
    queryFn: async () => {
      const res = await apiGet<AuthorizationResponse>(`/api/orgs/${orgId}/takedown-authorization`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 60_000,
  });
}

export function useRevokeAuthorization() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiDelete<{ org_id: number; action: 'revoked' }>(
        `/api/orgs/${orgId}/takedown-authorization`,
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-takedown-authorization', orgId] });
    },
  });
}

export interface SignAuthorizationInput {
  agreement_version: string;
  scope:             AuthorizationScope;
}

export function useSignAuthorization() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SignAuthorizationInput) => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiPost<{ authorization: TakedownAuthorization }>(
        `/api/orgs/${orgId}/takedown-authorization`,
        input,
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-takedown-authorization', orgId] });
    },
  });
}

/** Org-level roles that may sign — same as revoke. Mirrors backend
 *  canMutateAuthorization in handlers/takedownAuthorizations.ts. */
export function canSignAuthorization(
  globalRole: string | undefined,
  orgRole:    string | undefined,
): boolean {
  return canRevokeAuthorization(globalRole, orgRole);
}

/** Org-level roles that may revoke. Mirrors backend ADMIN_ROLES in handlers/takedownAuthorizations.ts. */
const REVOKE_ROLES = new Set(['admin', 'owner']);

export function canRevokeAuthorization(
  globalRole: string | undefined,
  orgRole: string | undefined,
): boolean {
  if (globalRole === 'super_admin') return true;
  return REVOKE_ROLES.has(orgRole ?? '');
}

export const ESCALATION_LABELS: Record<EscalationMode, string> = {
  auto_resubmit_on_pivot: 'Auto-resubmit on pivot',
  manual_only:            'Manual only',
};
