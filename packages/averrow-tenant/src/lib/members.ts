// Tenant org-members API client.
//
// Backed by the existing tenant routes:
//   GET    /api/orgs/:orgId/members           (list active)
//   POST   /api/orgs/:orgId/invite            (send invite)
//   DELETE /api/orgs/:orgId/members/:userId   (remove)
//   PATCH  /api/orgs/:orgId/members/:userId   (change role)
//   GET    /api/orgs/:orgId/invites           (pending)
//   DELETE /api/orgs/:orgId/invites/:inviteId (revoke pending)
//
// All endpoints are gated to org admin+ (admin / owner) or
// super_admin in handlers/organizations.ts.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from './api';
import { useAuth } from './auth';

export type OrgRole = 'owner' | 'admin' | 'analyst' | 'viewer';

export interface OrgMember {
  id:              string;
  user_id:         string;
  user_name:       string;
  email:           string;
  role:            string;
  status:          string;
  invited_at:      string | null;
  accepted_at:     string | null;
  last_active_at:  string | null;
}

export interface OrgInvite {
  id:         string;
  email:      string;
  org_role:   string;
  created_at: string;
  expires_at: string;
}

export const ORG_ROLE_LABELS: Record<string, string> = {
  owner:   'Owner',
  admin:   'Admin',
  analyst: 'Analyst',
  viewer:  'Viewer',
};

/** Roles selectable when inviting/promoting. 'owner' is intentionally
 *  excluded — owner is set on org creation and ownership transfer is
 *  not yet exposed in the tenant UI. */
export const INVITABLE_ROLES: OrgRole[] = ['admin', 'analyst', 'viewer'];

const MANAGE_ROLES = new Set(['admin', 'owner']);

export function canManageMembers(
  globalRole: string | undefined,
  orgRole:    string | undefined,
): boolean {
  if (globalRole === 'super_admin') return true;
  return MANAGE_ROLES.has(orgRole ?? '');
}

export function useOrgMembers() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const canList = canManageMembers(user?.role, user?.organization?.role);
  return useQuery<OrgMember[]>({
    queryKey: ['tenant-org-members', orgId],
    queryFn: async () => {
      const res = await apiGet<OrgMember[]>(`/api/orgs/${orgId}/members`);
      return res.data;
    },
    enabled: hasOrg && !!orgId && canList,
    staleTime: 30_000,
  });
}

export function useOrgInvites() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const canList = canManageMembers(user?.role, user?.organization?.role);
  return useQuery<OrgInvite[]>({
    queryKey: ['tenant-org-invites', orgId],
    queryFn: async () => {
      const res = await apiGet<OrgInvite[]>(`/api/orgs/${orgId}/invites`);
      return res.data;
    },
    enabled: hasOrg && !!orgId && canList,
    staleTime: 30_000,
  });
}

interface InviteResponse {
  id:               string;
  email:            string;
  org_role:         string;
  invite_url:       string;
  email_sent:       boolean;
  expires_in_hours: number;
}

export function useInviteMember() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; org_role: OrgRole }) => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiPost<InviteResponse>(`/api/orgs/${orgId}/invite`, input);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-org-invites', orgId] });
    },
  });
}

export function useRevokeInvite() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiDelete<{ message: string }>(`/api/orgs/${orgId}/invites/${inviteId}`);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-org-invites', orgId] });
    },
  });
}

export function useResendInvite() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiPost<InviteResponse>(
        `/api/orgs/${orgId}/invites/${inviteId}/resend`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-org-invites', orgId] });
    },
  });
}

export function useRemoveMember() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiDelete<{ message: string }>(`/api/orgs/${orgId}/members/${userId}`);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-org-members', orgId] });
    },
  });
}

export function useUpdateMemberRole() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; role: OrgRole }) => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiPatch<{ message: string }>(
        `/api/orgs/${orgId}/members/${input.userId}`,
        { role: input.role },
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-org-members', orgId] });
    },
  });
}
