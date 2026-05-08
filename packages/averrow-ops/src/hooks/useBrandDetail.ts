import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Brand detail data, split into two parallel queries:
 *
 *   ESSENTIAL  (3 calls)  brand + threats + locations
 *     → page paints as soon as these resolve, isLoading reflects only this set
 *
 *   EXTENDED   (7 calls)  providers, campaigns, timeline, analysis,
 *                         safeDomains, emailSecurity, socialProfiles
 *     → populate progressively into the same `data` object after first paint
 *
 * Before this split, the hook awaited Promise.all of all 10 calls, so the
 * page was blocked on the slowest of 10 — and under D1 contention the p95
 * of 10 is essentially the worst-case tail, every load. Splitting cuts
 * first-paint to the slowest of 3.
 *
 * Consumers see the same shape they did before; fields backed by the
 * extended query default to empty arrays/null until they arrive.
 */
const ESSENTIAL_KEY = (brandId: string) => ['brand-essential', brandId] as const;
const EXTENDED_KEY = (brandId: string) => ['brand-extended', brandId] as const;

export function useBrandFullDetail(brandId: string) {
  const essential = useQuery({
    queryKey: ESSENTIAL_KEY(brandId),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [brand, threats, locations] = await Promise.all([
        api.get<any>(`/api/brands/${brandId}`).catch(() => ({ data: null })),
        api.get<any>(`/api/brands/${brandId}/threats?status=active&limit=50`).catch(() => ({ data: [] })),
        api.get<any>(`/api/brands/${brandId}/threats/locations`).catch(() => ({ data: [] })),
      ]);
      return {
        brand: brand.data,
        threats: threats.data || [],
        locations: locations.data || [],
      };
    },
    enabled: !!brandId,
  });

  const extended = useQuery({
    queryKey: EXTENDED_KEY(brandId),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [providers, campaigns, timeline, analysis, safeDomains, emailSecurity, socialProfiles] = await Promise.all([
        api.get<any>(`/api/brands/${brandId}/providers`).catch(() => ({ data: [] })),
        api.get<any>(`/api/brands/${brandId}/campaigns`).catch(() => ({ data: [] })),
        api.get<any>(`/api/brands/${brandId}/threats/timeline?period=7d`).catch(() => ({ data: null })),
        api.get<any>(`/api/brands/${brandId}/analysis`).catch(() => ({ data: null })),
        api.get<any>(`/api/brands/${brandId}/safe-domains`).catch(() => ({ data: [] })),
        api.get<any>(`/api/email-security/${brandId}`).catch(() => ({ data: null })),
        api.get<any>(`/api/brands/${brandId}/social-profiles`).catch(() => ({ data: [] })),
      ]);
      return {
        providers: providers.data || [],
        campaigns: campaigns.data || [],
        timeline: timeline.data,
        analysis: analysis.data,
        safeDomains: safeDomains.data || [],
        emailSecurity: emailSecurity.data,
        socialProfiles: socialProfiles.data || [],
      };
    },
    enabled: !!brandId,
  });

  // Merge essentials + extended into the consumer's expected shape.
  // isLoading reflects only essentials so the page paints early; extended
  // fields back-fill silently as they arrive.
  const data = essential.data ? {
    ...essential.data,
    providers: extended.data?.providers ?? [],
    campaigns: extended.data?.campaigns ?? [],
    timeline: extended.data?.timeline ?? null,
    analysis: extended.data?.analysis ?? null,
    safeDomains: extended.data?.safeDomains ?? [],
    emailSecurity: extended.data?.emailSecurity ?? null,
    socialProfiles: extended.data?.socialProfiles ?? [],
  } : undefined;

  return {
    data,
    isLoading: essential.isLoading,
    isExtendedLoading: extended.isLoading,
    error: essential.error ?? extended.error ?? null,
  };
}

/**
 * Helper for mutations that need to invalidate brand detail data.
 * Invalidates both essential and extended queries so the page re-fetches
 * everything after a mutation lands.
 */
function invalidateBrand(qc: ReturnType<typeof useQueryClient>, brandId: string) {
  qc.invalidateQueries({ queryKey: ESSENTIAL_KEY(brandId) });
  qc.invalidateQueries({ queryKey: EXTENDED_KEY(brandId) });
}

export function useBrandTimeline(brandId: string, period: string) {
  return useQuery({
    queryKey: ['brand-timeline', brandId, period],
    queryFn: async () => {
      const res = await api.get<any>(`/api/brands/${brandId}/threats/timeline?period=${period}`);
      return res.data;
    },
    placeholderData: keepPreviousData,
    enabled: !!brandId,
  });
}

export function useTriggerAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) => api.post(`/api/brands/${brandId}/analysis`),
    onSuccess: (_, brandId) => invalidateBrand(qc, brandId),
  });
}

export function useAddSafeDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ brandId, domain }: { brandId: string; domain: string }) =>
      api.post(`/api/brands/${brandId}/safe-domains`, { domain }),
    onSuccess: (_, { brandId }) => invalidateBrand(qc, brandId),
  });
}

export function useDeleteSafeDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ brandId, domainId }: { brandId: string; domainId: string }) =>
      api.delete(`/api/brands/${brandId}/safe-domains/${domainId}`),
    onSuccess: (_, { brandId }) => invalidateBrand(qc, brandId),
  });
}

export function useCleanFalsePositives() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) => api.post(`/api/brands/${brandId}/clean-false-positives`),
    onSuccess: (_, brandId) => invalidateBrand(qc, brandId),
  });
}

export function useClassifySocialProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ brandId, profileId, classification }: { brandId: string; profileId: string; classification: string }) =>
      api.patch(`/api/brands/${brandId}/social-profiles/${profileId}`, { classification }),
    onSuccess: (_, { brandId }) => invalidateBrand(qc, brandId),
  });
}

export function useScanSocialProfiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) => api.post(`/api/social/scan/${brandId}`),
    onSuccess: (_, brandId) => invalidateBrand(qc, brandId),
  });
}

export function useDiscoverSocialProfiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) => api.post(`/api/brands/${brandId}/discover-social`),
    onSuccess: (_, brandId) => invalidateBrand(qc, brandId),
  });
}
