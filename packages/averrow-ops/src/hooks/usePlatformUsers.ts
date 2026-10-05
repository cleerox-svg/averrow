// Platform Users admin — staff/user account management (admin+).
//
// Backed by:
//   GET    /api/admin/users?q=&role=&status=&limit=&offset=   (list + filtered total)
//   PATCH  /api/admin/users/:id            { role?, status? }  (guardrailed server-side)
//   GET    /api/admin/sessions?user_id=                        (recent sessions per user)
//   POST   /api/admin/users/:id/force-logout                   (revoke all sessions)
//   GET    /api/admin/invites?status=pending                   (staff invitations)
//   POST   /api/admin/invites              { email, role }
//   DELETE /api/admin/invites/:id
//
// Role values are the CHECK-constraint-valid four (super_admin / admin /
// analyst / client) — matching UpdateUserSchema on the worker. The other
// UserRole sub-roles (sales/support/billing/auditor) are not assignable to
// stored users on prod (see CLAUDE.md §7), so this surface doesn't offer
// them.

import { useQuery, useQueries, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type PlatformUserRole = 'super_admin' | 'admin' | 'analyst' | 'client';
export type PlatformUserStatus = 'active' | 'suspended' | 'deactivated';

export interface PlatformUser {
  id: string;
  email: string;
  name: string | null;
  role: PlatformUserRole;
  status: PlatformUserStatus;
  created_at: string;
  last_login: string | null;
  last_active: string | null;
  invited_by: string | null;
}

export interface PlatformUsersResponse {
  users: PlatformUser[];
  total: number;
}

export interface UsersQuery {
  q?: string;
  role?: string;
  status?: string;
  page?: number;      // 1-based
  pageSize?: number;
}

export const USERS_PAGE_SIZE = 50;

export function usePlatformUsers(query: UsersQuery) {
  const { q = '', role = '', status = '', page = 1, pageSize = USERS_PAGE_SIZE } = query;
  return useQuery<PlatformUsersResponse>({
    queryKey: ['platform-users', q, role, status, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (role) params.set('role', role);
      if (status) params.set('status', status);
      params.set('limit', String(pageSize));
      params.set('offset', String((page - 1) * pageSize));
      const res = await api.get<PlatformUsersResponse>(`/api/admin/users?${params}`);
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load users');
      return res.data;
    },
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export interface UpdatePlatformUserResult {
  user: PlatformUser;
  /** True when the role changed but live sessions could not be revoked (KV failure). */
  revocationPending: boolean;
  warning: string | null;
}

export function useUpdatePlatformUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; role?: PlatformUserRole; status?: PlatformUserStatus }): Promise<UpdatePlatformUserResult> => {
      const { userId, ...body } = input;
      const res = await api.patch<PlatformUser>(`/api/admin/users/${userId}`, body);
      if (!res.success || !res.data) throw new Error(typeof res.error === 'string' ? res.error : 'Update failed');
      // The worker adds `revocation_pending` + `warning` beside `data` when the
      // role write committed but the session-revocation stamp did not.
      const extra = res as typeof res & { revocation_pending?: boolean; warning?: string };
      return {
        user: res.data,
        revocationPending: extra.revocation_pending === true,
        warning: typeof extra.warning === 'string' ? extra.warning : null,
      };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform-users'] });
    },
  });
}

/** Stored staff roles (the CHECK-valid non-client set). */
export const STAFF_ROLES = ['super_admin', 'admin', 'analyst'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffUsersQuery {
  q?: string;
  /** One staff role, or '' for every staff role. */
  role?: string;
  status?: string;
}

const STAFF_FETCH_LIMIT = 200;

/**
 * Staff accounts only. GET /api/admin/users takes a single `role`, so "all
 * staff" is one query per staff role, merged (no backend change; `client`
 * accounts are customers and never appear here).
 */
export function useStaffUsers({ q = '', role = '', status = '' }: StaffUsersQuery) {
  const roles: readonly string[] = role ? [role] : STAFF_ROLES;
  return useQueries({
    queries: roles.map((r) => ({
      queryKey: ['platform-users', 'staff', q, r, status],
      queryFn: async (): Promise<PlatformUsersResponse> => {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        params.set('role', r);
        if (status) params.set('status', status);
        params.set('limit', String(STAFF_FETCH_LIMIT));
        const res = await api.get<PlatformUsersResponse>(`/api/admin/users?${params}`);
        if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load staff');
        return res.data;
      },
      staleTime: 15_000,
    })),
    combine: (results) => {
      const users = results.flatMap((r) => r.data?.users ?? []);
      const total = results.reduce((n, r) => n + (r.data?.total ?? 0), 0);
      const firstError = results.find((r) => r.error)?.error ?? null;
      return {
        users,
        total,
        truncated: total > users.length,
        isLoading: results.some((r) => r.isLoading),
        isError: results.some((r) => r.isError),
        error: firstError as Error | null,
        refetch: () => { results.forEach((r) => { void r.refetch(); }); },
      };
    },
  });
}

export function useForceLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const res = await api.post<{ revoked: number }>(`/api/admin/users/${userId}/force-logout`);
      if (!res.success) throw new Error(res.error ?? 'Force logout failed');
      return res.data;
    },
    onSuccess: (_d, userId) => {
      void qc.invalidateQueries({ queryKey: ['user-sessions', userId] });
    },
  });
}

export interface UserSession {
  id: string;
  user_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
  email: string;
}

export function useUserSessions(userId: string | null) {
  return useQuery<UserSession[]>({
    queryKey: ['user-sessions', userId],
    queryFn: async () => {
      const res = await api.get<UserSession[]>(`/api/admin/sessions?user_id=${userId}&limit=10`);
      if (!res.success) throw new Error(res.error ?? 'Failed to load sessions');
      return res.data ?? [];
    },
    enabled: !!userId,
    staleTime: 10_000,
  });
}

// ─── Staff invitations ──────────────────────────────────────────

export interface StaffInvite {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  invited_by_email: string | null;
}

export function useStaffInvites() {
  return useQuery<StaffInvite[]>({
    queryKey: ['staff-invites'],
    queryFn: async () => {
      const res = await api.get<StaffInvite[]>('/api/admin/invites?status=pending');
      if (!res.success) throw new Error(res.error ?? 'Failed to load invites');
      return res.data ?? [];
    },
    staleTime: 15_000,
  });
}

export function useCreateStaffInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; role: PlatformUserRole }) => {
      const res = await api.post<{ id: string; invite_url?: string }>('/api/admin/invites', input);
      if (!res.success) throw new Error(res.error ?? 'Invite failed');
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staff-invites'] });
    },
  });
}

export function useRevokeStaffInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      const res = await api.delete<{ id: string }>(`/api/admin/invites/${inviteId}`);
      if (!res.success) throw new Error(res.error ?? 'Revoke failed');
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staff-invites'] });
    },
  });
}
