import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

// Resolve the current user's org ID from auth context.
// Previously this file hardcoded `ORG_ID = '1'` from a single-tenant
// demo era; that broke every org that wasn't id=1 with 403s on every
// request. Now reads from `user.organization.id`. Super-admins not
// belonging to an org get null and the queries no-op.
function useOrgId(): string | null {
  const { user } = useAuth();
  return user?.organization?.id ? String(user.organization.id) : null;
}

// ─── Types ──────────────────────────────────────────────────

export interface Org {
  id: number;
  name: string;
  slug: string;
  plan: string;
  status: string;
  max_brands: number;
  max_members: number;
  created_at: string;
}

export interface OrgMember {
  id: number;
  user_id: string;
  role: string;
  status: string;
  invited_at: string | null;
  accepted_at: string | null;
  last_active_at: string | null;
  email: string;
  user_name: string;
}

export interface OrgBrand {
  id: number;
  brand_id: string;
  is_primary: number;
  created_at: string;
  brand_name: string;
  canonical_domain: string;
  sector: string | null;
  threat_count: number;
}

export interface OrgInvite {
  id: string;
  email: string;
  org_role: string;
  created_at: string;
  expires_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

export interface Integration {
  id: string;
  type: string;
  category: string;
  name: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  events_sent: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookConfig {
  webhook_url: string | null;
  has_secret: boolean;
  webhook_events: string[];
  webhook_failures_24h: number;
  webhook_last_success: string | null;
  webhook_last_failure: string | null;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status_code: number;
  success: boolean;
  response_time_ms: number;
  delivered_at: string;
  error: string | null;
}

export interface SsoConfig {
  protocol: 'none' | 'saml' | 'oidc' | null;
  status: 'active' | 'configured' | 'disabled' | null;
  saml_metadata_url: string | null;
  saml_certificate: boolean;
  oidc_provider: string | null;
  oidc_client_id: string | null;
  oidc_client_secret: boolean;
  oidc_discovery_url: string | null;
}

// ─── Queries ────────────────────────────────────────────────

export function useOrg() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['org', orgId],
    queryFn: async () => {
      const res = await api.get<Org>(`/api/orgs/${orgId}`);
      return res.data ?? null;
    },
    enabled: !!orgId,
  });
}

export function useOrgMembers() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['org-members', orgId],
    queryFn: async () => {
      const res = await api.get<OrgMember[]>(`/api/orgs/${orgId}/members`);
      return res.data ?? [];
    },
    enabled: !!orgId,
  });
}

export function useOrgBrands() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['org-brands', orgId],
    queryFn: async () => {
      const res = await api.get<OrgBrand[]>(`/api/orgs/${orgId}/brands`);
      return res.data ?? [];
    },
    enabled: !!orgId,
  });
}

export function useOrgInvites() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['org-invites', orgId],
    queryFn: async () => {
      const res = await api.get<OrgInvite[]>(`/api/orgs/${orgId}/invites`);
      return res.data ?? [];
    },
    enabled: !!orgId,
  });
}

export function useOrgApiKeys() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['org-api-keys', orgId],
    queryFn: async () => {
      const res = await api.get<ApiKey[]>(`/api/orgs/${orgId}/api-keys`);
      return res.data ?? [];
    },
    enabled: !!orgId,
  });
}

export function useOrgIntegrations() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['org-integrations', orgId],
    queryFn: async () => {
      const res = await api.get<Integration[]>(`/api/orgs/${orgId}/integrations`);
      return res.data ?? [];
    },
    enabled: !!orgId,
  });
}

export function useWebhookConfig() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['org-webhook', orgId],
    queryFn: async () => {
      const res = await api.get<WebhookConfig>(`/api/orgs/${orgId}/webhook`);
      return res.data ?? null;
    },
    enabled: !!orgId,
  });
}

// ─── Mutations ──────────────────────────────────────────────

function requireOrgId(orgId: string | null): string {
  if (!orgId) throw new Error('No active organization for current user');
  return orgId;
}

export function useInviteMember() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (payload: { email: string; org_role: string }) => {
      return api.post(`/api/orgs/${requireOrgId(orgId)}/invite`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-invites'] });
      qc.invalidateQueries({ queryKey: ['org-members'] });
    },
  });
}

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      return api.patch(`/api/orgs/${requireOrgId(orgId)}/members/${userId}`, { role });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-members'] });
    },
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (userId: string) => {
      return api.delete(`/api/orgs/${requireOrgId(orgId)}/members/${userId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-members'] });
    },
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      return api.delete(`/api/orgs/${requireOrgId(orgId)}/invites/${inviteId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-invites'] });
    },
  });
}

export function useAssignBrand() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (payload: { brand_id: string; is_primary?: boolean }) => {
      return api.post(`/api/orgs/${requireOrgId(orgId)}/brands`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-brands'] });
      qc.invalidateQueries({ queryKey: ['org'] });
    },
  });
}

export function useRemoveBrand() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (brandId: string) => {
      return api.delete(`/api/orgs/${requireOrgId(orgId)}/brands/${brandId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-brands'] });
      qc.invalidateQueries({ queryKey: ['org'] });
    },
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (payload: { name: string; scopes: string[]; expires_at?: string }) => {
      return api.post<{ key: string; prefix: string; name: string; scopes: string[] }>(
        `/api/orgs/${requireOrgId(orgId)}/api-keys`,
        payload,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-api-keys'] });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (keyId: string) => {
      return api.delete(`/api/orgs/${requireOrgId(orgId)}/api-keys/${keyId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-api-keys'] });
    },
  });
}

export function useCreateIntegration() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (payload: { type: string; category: string; name: string; config?: Record<string, unknown> }) => {
      return api.post(`/api/orgs/${requireOrgId(orgId)}/integrations`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-integrations'] });
    },
  });
}

export function useDeleteIntegration() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (integrationId: string) => {
      return api.delete(`/api/orgs/${requireOrgId(orgId)}/integrations/${integrationId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-integrations'] });
    },
  });
}

export function useTestIntegration() {
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (integrationId: string) => {
      return api.post(`/api/orgs/${requireOrgId(orgId)}/integrations/${integrationId}/test`);
    },
  });
}

export function useUpdateWebhook() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (payload: { webhook_url?: string; webhook_events?: string[] }) => {
      return api.patch(`/api/orgs/${requireOrgId(orgId)}/webhook`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-webhook'] });
    },
  });
}

export function useRegenerateWebhookSecret() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async () => {
      return api.post<{ webhook_secret: string }>(`/api/orgs/${requireOrgId(orgId)}/webhook/regenerate-secret`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-webhook'] });
    },
  });
}

export function useTestWebhook() {
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async () => {
      return api.post(`/api/orgs/${requireOrgId(orgId)}/webhook/test`);
    },
  });
}

export function useUpdateOrg() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (payload: { name?: string }) => {
      return api.patch(`/api/admin/organizations/${requireOrgId(orgId)}`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org'] });
    },
  });
}

// ─── SSO ───────────────────────────────────────────────────

export function useSsoConfig() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['org-sso', orgId],
    queryFn: async () => {
      const res = await api.get<SsoConfig>(`/api/orgs/${orgId}/sso`);
      return res.data ?? null;
    },
    enabled: !!orgId,
  });
}

export function useUpdateSsoConfig() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async (payload: {
      protocol: string;
      saml_metadata_url?: string;
      saml_certificate?: string;
      oidc_provider?: string;
      oidc_client_id?: string;
      oidc_client_secret?: string;
      oidc_discovery_url?: string;
    }) => {
      return api.put(`/api/orgs/${requireOrgId(orgId)}/sso`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-sso'] });
    },
  });
}

export function useTestSsoConnection() {
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async () => {
      return api.post<{ success: boolean; error?: string }>(`/api/orgs/${requireOrgId(orgId)}/sso/test`);
    },
  });
}

// ─── Webhook Deliveries ────────────────────────────────────

export function useWebhookDeliveries() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['org-webhook-deliveries', orgId],
    queryFn: async () => {
      const res = await api.get<WebhookDelivery[]>(`/api/orgs/${orgId}/webhook/deliveries`);
      return res.data ?? [];
    },
    enabled: !!orgId,
  });
}
