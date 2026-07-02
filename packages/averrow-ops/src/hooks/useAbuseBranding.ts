// Abuse-mailbox responder branding (Tier 3) — super_admin per-org config.
//
// Backed by:
//   GET  /api/admin/organizations/:orgId/abuse-branding   → { stored, resolved, alias }
//   PUT  /api/admin/organizations/:orgId/abuse-branding   (upsert)
//   POST /api/admin/organizations/:orgId/abuse-alias      (provision verify-<slug>@)
//
// `stored` is the raw row (nullable fields = "use the Averrow default").
// `resolved` is what the responder actually renders (defaults merged +
// validated) — used for the live preview. The envelope From always stays
// on abuse-noreply@averrow.com; only the display name + look are branded.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Editable branding fields (all optional → fall back to Averrow default). */
export interface AbuseBrandingStored {
  enabled?: number | boolean | null;
  from_name?: string | null;
  product_name?: string | null;
  tagline?: string | null;
  accent_color?: string | null;
  header_bg_color?: string | null;
  logo_url?: string | null;
  logo_alt?: string | null;
  subject_prefix?: string | null;
  website_url?: string | null;
  website_label?: string | null;
  report_url?: string | null;
  report_label?: string | null;
  footer_note?: string | null;
  updated_at?: string | null;
}

/** Fully resolved branding the responder would use (defaults merged). */
export interface AbuseBrandingResolved {
  fromName: string;
  productName: string;
  tagline: string;
  accent: string;
  headerBg: string;
  logoUrl: string;
  logoAlt: string;
  subjectPrefix: string;
  websiteUrl: string;
  websiteLabel: string;
  reportUrl: string;
  reportLabel: string;
  footerNote: string;
}

export interface AbuseBrandingResponse {
  stored: AbuseBrandingStored | null;
  resolved: AbuseBrandingResolved;
  alias: string | null;
}

export function useAbuseBranding(orgId: string | null) {
  return useQuery<AbuseBrandingResponse>({
    queryKey: ['admin-abuse-branding', orgId],
    queryFn: async () => {
      const res = await api.get<AbuseBrandingResponse>(
        `/api/admin/organizations/${orgId}/abuse-branding`,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load branding');
      return res.data;
    },
    enabled: !!orgId,
    staleTime: 15_000,
  });
}

export function useUpdateAbuseBranding(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AbuseBrandingStored) => {
      if (!orgId) throw new Error('orgId required');
      const res = await api.put<{ resolved: AbuseBrandingResolved }>(
        `/api/admin/organizations/${orgId}/abuse-branding`,
        input,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Save failed');
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-abuse-branding', orgId] });
    },
  });
}

export interface ProvisionAliasResult {
  ok: boolean;
  alias?: string;
  created?: boolean;
  reason?: string;
}

export function useProvisionAbuseAlias(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (slug?: string) => {
      if (!orgId) throw new Error('orgId required');
      const res = await api.post<ProvisionAliasResult>(
        `/api/admin/organizations/${orgId}/abuse-alias`,
        slug ? { slug } : {},
      );
      // The endpoint returns success:false with a reason on collision — surface it.
      if (!res.success) throw new Error(res.error ?? 'Provision failed');
      return res.data as ProvisionAliasResult;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-abuse-branding', orgId] });
    },
  });
}
