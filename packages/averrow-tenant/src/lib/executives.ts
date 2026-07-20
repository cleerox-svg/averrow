// Tenant executive-identity registry API client.
//
// EXEC_IMPERSONATION_2026-07 Stage 5 — the customer-facing surface over
// the org_executives CRUD API (Stage 1, worker handler
// src/handlers/tenantExecutives.ts). Registers the org's named
// executives per brand so the deterministic detector (Stage 2) and the
// executive_monitor agent (Stage 4) know who to watch for and which
// handles are the real ones (official_handles allowlist).
//
// Backed by:
//   GET    /api/orgs/:orgId/executives            (optional ?brand_id=)
//   POST   /api/orgs/:orgId/executives
//   GET    /api/orgs/:orgId/executives/:execId
//   PATCH  /api/orgs/:orgId/executives/:execId
//   DELETE /api/orgs/:orgId/executives/:execId
//
// Reads: any org member. Mutations: org-admin+ (mirrors requireOrgAdmin
// server-side — see canManageMembers in ./members, reused here since the
// role gate is identical: super_admin, or org role admin/owner).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from './api';
import { useAuth } from './auth';

// Canonical platform-key list — kept in lockstep with
// SUPPORTED_EXEC_PLATFORMS in averrow-worker/src/lib/executive-registry.ts.
// The detector only watches these six; the create/edit form only offers
// these six so the client can never submit a key the server would reject.
export const SUPPORTED_EXEC_PLATFORMS = [
  'twitter',
  'linkedin',
  'instagram',
  'tiktok',
  'github',
  'youtube',
] as const;

export type ExecPlatform = (typeof SUPPORTED_EXEC_PLATFORMS)[number];

export const EXEC_PLATFORM_LABELS: Record<ExecPlatform, string> = {
  twitter:   'X / Twitter',
  linkedin:  'LinkedIn',
  instagram: 'Instagram',
  tiktok:    'TikTok',
  github:    'GitHub',
  youtube:   'YouTube',
};

export const EXEC_STATUS_VALUES = ['active', 'paused'] as const;
export type ExecStatus = (typeof EXEC_STATUS_VALUES)[number];

export interface Executive {
  id:                string;
  org_id:             string;
  brand_id:           string;
  full_name:          string;
  title:              string | null;
  official_handles:   Record<string, string>;
  watch_platforms:    string[];
  status:             string;
  created_at:         string;
  updated_at:         string;
}

export interface ExecutiveInput {
  brand_id:          string;
  full_name:         string;
  title?:            string | null;
  official_handles?: Record<string, string>;
  watch_platforms?:  string[];
  status?:           ExecStatus;
}

export type ExecutiveUpdateInput = Partial<Omit<ExecutiveInput, 'brand_id'>> & { brand_id?: string };

function isKnownExecPlatform(key: string): key is ExecPlatform {
  return (SUPPORTED_EXEC_PLATFORMS as readonly string[]).includes(key);
}

/** Mirrors validateFullName in executive-registry.ts (required,
 *  non-empty after trim, <=200 chars) so the form fails fast instead of
 *  round-tripping to the server for an obvious empty-name error. */
export function validateExecutiveName(input: string): string | null {
  const name = input.trim();
  if (!name) return 'Name is required';
  if (name.length > 200) return 'Name is too long (max 200 characters)';
  return null;
}

/** Mirrors validateWatchPlatforms: at least one known platform key. */
export function validateWatchPlatforms(platforms: string[]): string | null {
  if (platforms.length === 0) return 'Select at least one platform to watch';
  const unknown = platforms.find((p) => !isKnownExecPlatform(p));
  if (unknown) return `Unsupported platform key: ${unknown}`;
  return null;
}

function orgExecutivesKey(orgId: number | null, brandId?: string) {
  return brandId
    ? (['tenant-org-executives', orgId, brandId] as const)
    : (['tenant-org-executives', orgId] as const);
}

/** List the org's registered executives, optionally scoped to one brand. */
export function useOrgExecutives(brandId?: string) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<Executive[]>({
    queryKey: orgExecutivesKey(orgId, brandId),
    queryFn: async () => {
      const qs = brandId ? `?brand_id=${encodeURIComponent(brandId)}` : '';
      const res = await apiGet<Executive[]>(`/api/orgs/${orgId}/executives${qs}`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export function useCreateExecutive() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ExecutiveInput) => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiPost<{ id: string }>(`/api/orgs/${orgId}/executives`, input);
      return res.data;
    },
    onSuccess: () => {
      // Prefix-match invalidates every brand-scoped variant too.
      void qc.invalidateQueries({ queryKey: ['tenant-org-executives', orgId] });
    },
  });
}

export function useUpdateExecutive() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ execId, input }: { execId: string; input: ExecutiveUpdateInput }) => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiPatch<{ id: string }>(`/api/orgs/${orgId}/executives/${execId}`, input);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-org-executives', orgId] });
    },
  });
}

export function useDeleteExecutive() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (execId: string) => {
      if (!orgId) throw new Error('orgId required');
      const res = await apiDelete<{ id: string }>(`/api/orgs/${orgId}/executives/${execId}`);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-org-executives', orgId] });
    },
  });
}
