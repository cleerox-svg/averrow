import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────

export interface AdminOrg {
  id: number;
  name: string;
  slug: string;
  plan: string;
  status: string;
  max_brands: number;
  max_members: number;
  created_at: string;
  updated_at: string | null;
  member_count: number;
  brand_count: number;
}

export interface AdminOrgDetail extends AdminOrg {
  members: {
    id: number;
    user_id: string;
    role: string;
    status: string;
    invited_at: string | null;
    accepted_at: string | null;
    last_active_at: string | null;
    email: string;
    user_name: string;
    platform_role: string;
  }[];
  brands: {
    id: number;
    brand_id: string;
    is_primary: number;
    created_at: string;
    brand_name: string;
    canonical_domain: string;
  }[];
}

export interface BrandSearchResult {
  id: number;
  name: string;
  canonical_domain: string;
  sector: string | null;
  threat_count: number;
}

export interface CreateOrgPayload {
  name: string;
  slug?: string;
  plan: string;
  max_brands: number;
  max_members: number;
  brands: { brand_id: string; is_primary?: boolean }[];
  services: string[];
  admin_email?: string;
  admin_name?: string;
}

// ─── Queries ────────────────────────────────────────────────

export function useAdminOrgs() {
  return useQuery({
    queryKey: ['admin-orgs'],
    queryFn: async () => {
      const res = await api.get<AdminOrg[]>('/api/admin/organizations');
      return res.data ?? [];
    },
  });
}

export function useAdminOrgDetail(orgId: string | null) {
  return useQuery({
    queryKey: ['admin-org-detail', orgId],
    queryFn: async () => {
      if (!orgId) return null;
      const res = await api.get<AdminOrgDetail>(`/api/admin/organizations/${orgId}`);
      return res.data ?? null;
    },
    enabled: !!orgId,
  });
}

export function useBrandSearch(query: string) {
  return useQuery({
    queryKey: ['brand-search', query],
    queryFn: async () => {
      if (query.length < 1) return [];
      const res = await api.get<BrandSearchResult[]>(`/api/admin/brands/search?q=${encodeURIComponent(query)}&limit=10`);
      return res.data ?? [];
    },
    enabled: query.length >= 1,
  });
}

// ─── Mutations ──────────────────────────────────────────────

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateOrgPayload) => {
      return api.post<AdminOrg>('/api/admin/organizations', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-orgs'] });
    },
  });
}

export function useAdminUpdateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orgId, ...payload }: { orgId: string; name?: string; plan?: string; max_brands?: number; max_members?: number; status?: string }) => {
      return api.patch(`/api/admin/organizations/${orgId}`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-orgs'] });
      qc.invalidateQueries({ queryKey: ['admin-org-detail'] });
    },
  });
}

// Tenant-scoped mutations for org detail management
export function useAdminOrgInvite(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { email: string; org_role: string }) => {
      return api.post(`/api/orgs/${orgId}/invite`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-org-detail', orgId] });
    },
  });
}

export function useAdminRemoveOrgMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      return api.delete(`/api/orgs/${orgId}/members/${userId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-org-detail', orgId] });
    },
  });
}

export function useAdminAssignBrand(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { brand_id: string; is_primary?: boolean }) => {
      return api.post(`/api/orgs/${orgId}/brands`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-org-detail', orgId] });
      qc.invalidateQueries({ queryKey: ['admin-orgs'] });
    },
  });
}

export function useAdminRemoveBrand(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) => {
      return api.delete(`/api/orgs/${orgId}/brands/${brandId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-org-detail', orgId] });
      qc.invalidateQueries({ queryKey: ['admin-orgs'] });
    },
  });
}
