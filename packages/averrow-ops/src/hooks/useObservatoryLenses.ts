/**
 * Observatory lens data hooks (Phase B endpoints, see docs/API_REFERENCE.md
 * "Observatory lenses (Phase B)"). Same conventions as useObservatory.ts: one
 * query per key, polling that stops in background tabs, previous data kept on
 * screen while a new period loads (`isUpdating`), and an `enabled` gate so a
 * lens only fetches while its layer is actually on.
 *
 * All keys live under ['observatory', 'lens', …] so the page's refresh button
 * (refreshObservatory) invalidates them with everything else.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  POLL, buildObservatoryUrl, clampLimit, observatoryKeys, shape, sourceParam,
  type ObservatoryQueryResult,
} from './useObservatory';

// ─── Types (mirror packages/averrow-worker/src/handlers/observatoryLenses.ts) ──

export type ClusterKind =
  | 'cert_serial' | 'cert_san' | 'per_ip' | 'subnet' | 'registrar' | 'asn' | 'app_store' | 'dark_web' | 'other';

export interface OperationGeo {
  id: string;
  name: string | null;
  component_id: string | null;
  kind: ClusterKind;
  status: string | null;
  confidence_score: number | null;
  threat_count: number;
  actor: { id: string; name: string } | null;
  countries: string[];
  asns: string[];
  last_seen: string | null;
  last_movement_pivot_at: string | null;
}

export interface ComponentEdge {
  a: string;
  b: string;
  /** null when the bridge kind could not be resolved. */
  kind: 'cert_serial' | 'cert_san' | 'per_ip' | null;
  shared_asns: string[];
}

export interface ComponentGeo {
  component_id: string;
  operation_ids: string[];
  countries: string[];
  edges: ComponentEdge[];
}

export interface OperationsGeoData {
  operations: OperationGeo[];
  components: ComponentGeo[];
}

export interface MovementEndpoint {
  asns: string[];
  countries: string[];
}

export interface Movement {
  id: string;
  kind: 'infra_movement' | 'dormancy';
  cluster_id: string | null;
  cluster_name: string | null;
  at: string;
  from: MovementEndpoint;
  to: MovementEndpoint;
  counts: { new_asns: number; new_ips: number; new_serials: number };
  payload_v: number;
}

export interface ProviderTakedown {
  share: number | null;
  median_hours: number | null;
  n: number;
}

export interface ProviderGeo {
  id: string;
  name: string;
  asn: string | null;
  country: string | null;
  active_threat_count: number;
  total_threat_count: number;
  trend_7d: number;
  trend_30d: number;
  is_bulletproof: boolean;
  reputation_score: number | null;
  takedown: ProviderTakedown | null;
}

export interface OverindexRow {
  country_code: string;
  our_count: number;
  /** Fraction 0..1 of our non-XX total. */
  our_share: number;
  /** Fraction 0..1, or null when the country is outside Radar's top list. */
  radar_share: number | null;
  ratio: number | null;
}

export interface CampaignGeo {
  id: string;
  name: string;
  slug: string;
  status: string | null;
  conflict: string | null;
  adversary_countries: string[];
  target_countries: string[];
  threat_actors: string[];
  start_date: string | null;
  curated: true;
}

export interface TimelinePoint {
  /** ISO 8601 bucket start. */
  t: string;
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface TimelineData {
  bucket: '1h' | '6h' | '1d';
  points: TimelinePoint[];
}

export interface ActorListItem {
  id: string;
  name: string;
  cluster_count: number;
  infra_count: number;
}

export interface ActorDetail {
  actor: {
    id: string;
    name: string;
    aliases: string[];
    affiliation: string | null;
    country_code: string | null;
    capability: string | null;
    attribution_confidence: string | null;
    status: string | null;
    description: string | null;
    first_seen: string | null;
    last_seen: string | null;
  };
  infrastructure: Array<{
    asn: string | null;
    country_code: string | null;
    hosting_provider: string | null;
    confidence: string;
    last_observed: string;
  }>;
  clusters: Array<{ id: string; countries: string[]; asns: string[]; confidence_score: number | null }>;
  attributions: { by_confidence: Record<string, number>; by_source: Record<string, number> };
}

export interface LensMeta {
  generated_at: string | null;
  period: string | null;
  /** overindex only: date of the Radar snapshot the baseline came from (null before the first pull). */
  radar_snapshot_date: string | null;
  source_feed: string | null;
  country: string | null;
}

export interface LensPayload<T> {
  data: T;
  meta: LensMeta;
}

// ─── Fetch ──────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function readLensMeta(raw: unknown): LensMeta {
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    generated_at: str(m.generated_at),
    period: str(m.period),
    radar_snapshot_date: str(m.radar_snapshot_date),
    source_feed: str(m.source_feed),
    country: str(m.country),
  };
}

async function fetchLens<T>(url: string, signal: AbortSignal): Promise<LensPayload<T>> {
  const res = await api.fetch<T>(url, { signal });
  if (!res.success || res.data === undefined || res.data === null) {
    throw new Error(res.error || 'Observatory lens request failed');
  }
  return { data: res.data, meta: readLensMeta(res.meta) };
}

interface Opts { enabled?: boolean }

/** Lens data changes slowly (server TTLs are 15 min – 1 h): poll lazily, refetch on demand. */
const LENS_POLL = { ...POLL, refetchInterval: 600_000, staleTime: 120_000 } as const;

// ─── Hooks ──────────────────────────────────────────────────

export const OPERATIONS_GEO_LIMIT = 50;

export function useOperationsGeo(opts: Opts & { limit?: number; status?: 'active' | 'all' } = {}): ObservatoryQueryResult<LensPayload<OperationsGeoData>> {
  const { enabled = true, status = 'active', limit = OPERATIONS_GEO_LIMIT } = opts;
  const safe = clampLimit(limit, 1, 50);
  return shape(useQuery({
    queryKey: observatoryKeys.lens('operations-geo', { status, limit: safe }),
    queryFn: ({ signal }) => fetchLens<OperationsGeoData>(buildObservatoryUrl('/api/observatory/operations-geo', { status, limit: safe }), signal),
    enabled,
    ...LENS_POLL,
  }));
}

export function useMovements(opts: Opts & { period?: string; limit?: number } = {}): ObservatoryQueryResult<LensPayload<Movement[]>> {
  const { enabled = true, period = '7d', limit = 50 } = opts;
  const safe = clampLimit(limit, 1, 100);
  return shape(useQuery({
    queryKey: observatoryKeys.lens('movements', { period, limit: safe }),
    queryFn: ({ signal }) => fetchLens<Movement[]>(buildObservatoryUrl('/api/observatory/movements', { period, limit: safe }), signal),
    enabled,
    ...LENS_POLL,
  }));
}

export function useProvidersGeo(opts: Opts & { limit?: number; bulletproof?: boolean } = {}): ObservatoryQueryResult<LensPayload<ProviderGeo[]>> {
  const { enabled = true, limit = 100, bulletproof = false } = opts;
  const safe = clampLimit(limit, 1, 200);
  return shape(useQuery({
    queryKey: observatoryKeys.lens('providers-geo', { limit: safe, bulletproof: bulletproof ? 1 : 0 }),
    queryFn: ({ signal }) => fetchLens<ProviderGeo[]>(buildObservatoryUrl('/api/observatory/providers-geo', { limit: safe, bulletproof: bulletproof ? 1 : undefined }), signal),
    enabled,
    ...LENS_POLL,
  }));
}

/** Over-index only exists for 7d / 30d: map the page period onto the nearest one. */
export function overindexPeriod(period: string): '7d' | '30d' {
  return period === '30d' || period === '90d' ? '30d' : '7d';
}

export function useOverindex(opts: Opts & { period?: string } = {}): ObservatoryQueryResult<LensPayload<OverindexRow[]>> {
  const { enabled = true, period = '7d' } = opts;
  const p = overindexPeriod(period);
  return shape(useQuery({
    queryKey: observatoryKeys.lens('overindex', { period: p }),
    queryFn: ({ signal }) => fetchLens<OverindexRow[]>(buildObservatoryUrl('/api/observatory/overindex', { period: p }), signal),
    enabled,
    ...LENS_POLL,
  }));
}

export function useCampaignsGeo(opts: Opts = {}): ObservatoryQueryResult<LensPayload<CampaignGeo[]>> {
  const { enabled = true } = opts;
  return shape(useQuery({
    queryKey: observatoryKeys.lens('campaigns-geo'),
    queryFn: ({ signal }) => fetchLens<CampaignGeo[]>('/api/observatory/campaigns-geo', signal),
    enabled,
    ...LENS_POLL,
    refetchInterval: 1_800_000,
  }));
}

export function useObservatoryTimeline(
  opts: Opts & { period?: string; source?: string; country?: string | null } = {},
): ObservatoryQueryResult<LensPayload<TimelineData>> {
  const { enabled = true, period = '7d', source = 'all', country = null } = opts;
  return shape(useQuery({
    queryKey: observatoryKeys.lens('timeline', { period, source, country }),
    queryFn: ({ signal }) => fetchLens<TimelineData>(
      buildObservatoryUrl('/api/observatory/timeline', { period, source_feed: sourceParam(source), country: country ?? undefined }),
      signal,
    ),
    enabled,
    ...LENS_POLL,
    refetchInterval: 300_000,
    placeholderData: keepPreviousData,
  }));
}

export function useActorList(opts: Opts = {}): ObservatoryQueryResult<LensPayload<ActorListItem[]>> {
  const { enabled = true } = opts;
  return shape(useQuery({
    queryKey: observatoryKeys.lens('actors'),
    queryFn: ({ signal }) => fetchLens<ActorListItem[]>('/api/observatory/actors', signal),
    enabled,
    ...LENS_POLL,
    refetchInterval: 1_800_000,
  }));
}

export function useActorDetail(actorId: string | null, opts: Opts = {}): ObservatoryQueryResult<LensPayload<ActorDetail>> {
  const { enabled = true } = opts;
  return shape(useQuery({
    queryKey: observatoryKeys.lens('actor-detail', { actor_id: actorId }),
    queryFn: ({ signal }) => fetchLens<ActorDetail>(buildObservatoryUrl('/api/observatory/actors', { actor_id: actorId ?? undefined }), signal),
    enabled: enabled && !!actorId,
    ...LENS_POLL,
    refetchInterval: false,
    // A different actor is a different object: never show the previous actor's infrastructure.
    placeholderData: undefined,
  }));
}
