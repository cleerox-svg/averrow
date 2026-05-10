// Catalog-level aggregates for the Brands Intel page. Backed by
// /api/brands/aggregate/* endpoints from PR13. All cached server-side
// for 5min via cachedValue. Client-side TanStack Query staleTime
// matches.

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface EmailSecurityAggregate {
  grade_distribution: Array<{ grade: string; count: number }>;
  total_graded:       number;
  ungraded:           number;
  dmarc_distribution: Array<{ policy: string; count: number }>;
  dmarc_enforcing:    number;
}

export interface PressureMover {
  brand_id:         string;
  brand_name:       string;
  canonical_domain: string;
  logo_url:         string | null;
  count:            number;
}

export interface PressureAggregate {
  top_lookalikes:  PressureMover[];
  top_social_imps: PressureMover[];
  top_app_imps:    PressureMover[];
  top_dark_web:    PressureMover[];
}

export interface CompositionAggregate {
  tier_mix:       Array<{ tier: string; count: number }>;
  source_mix:     Array<{ source: string; count: number }>;
  tranco_buckets: Array<{ bucket: string; count: number }>;
  hq_countries:   Array<{ country: string; count: number }>;
  total:          number;
}

export interface PostureMover {
  brand_id:         string;
  brand_name:       string;
  canonical_domain: string;
  logo_url:         string | null;
  delta:            number;
  latest:           number;
}

export interface PostureAggregate {
  health_grade_distribution: Array<{ grade: string; count: number }>;
  health_score_buckets:      Array<{ bucket: string; count: number }>;
  exposure_score_buckets:    Array<{ bucket: string; count: number }>;
  improving_brands:          PostureMover[];
  declining_brands:          PostureMover[];
  total_scored:              number;
}

const STALE = 5 * 60_000;

export function useEmailSecurityAggregate() {
  return useQuery({
    queryKey: ['brand-aggregate', 'email-security'],
    queryFn: async () => {
      const res = await api.get<EmailSecurityAggregate>('/api/brands/aggregate/email-security');
      return (res.data ?? null) as EmailSecurityAggregate | null;
    },
    staleTime: STALE,
  });
}

export function usePressureAggregate() {
  return useQuery({
    queryKey: ['brand-aggregate', 'pressure'],
    queryFn: async () => {
      const res = await api.get<PressureAggregate>('/api/brands/aggregate/pressure');
      return (res.data ?? null) as PressureAggregate | null;
    },
    staleTime: STALE,
  });
}

export function useCompositionAggregate() {
  return useQuery({
    queryKey: ['brand-aggregate', 'composition'],
    queryFn: async () => {
      const res = await api.get<CompositionAggregate>('/api/brands/aggregate/composition');
      return (res.data ?? null) as CompositionAggregate | null;
    },
    staleTime: STALE,
  });
}

export function usePostureAggregate() {
  return useQuery({
    queryKey: ['brand-aggregate', 'posture'],
    queryFn: async () => {
      const res = await api.get<PostureAggregate>('/api/brands/aggregate/posture');
      return (res.data ?? null) as PostureAggregate | null;
    },
    staleTime: STALE,
  });
}
