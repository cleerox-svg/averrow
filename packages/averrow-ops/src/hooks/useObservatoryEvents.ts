/**
 * Observatory event feed (`GET /api/observatory/events`) — the data behind the
 * headline bar and the event rail.
 *
 * The DEFAULT request is exactly `period=1h&limit=40`: that is the key the
 * Navigator warms (cron/navigator.ts), so the first paint is a KV hit. Param
 * order is part of the contract (`period`, then `kinds` when filtering, then
 * `limit`); `kinds` is only sent when a filter is on, and always in canonical
 * order so one filter is one cache key. The headline bar and the rail's 1h view
 * share one query (same key), so opening the rail costs no request.
 *
 * Polling: 30 s while the tab is visible (the server entry lives 60 s, so half
 * the polls are cache hits); the 7d window never polls faster than every 5
 * minutes, and nothing polls in a background tab.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { buildObservatoryUrl, shape, type ObservatoryQueryResult } from '@/hooks/useObservatory';
import {
  EVENT_KINDS, EVENTS_DEFAULT_LIMIT, EVENTS_DEFAULT_PERIOD, EVENTS_EMPTY_META,
  type EventKind, type EventPeriod, type EventsMeta, type EventsResult, type ObservatoryEvent,
} from '@/features/observatory-v3/lib/events';

export const EVENTS_POLL_MS = 30_000;
/** The 7d window changes slowly: never poll it faster than this. */
export const EVENTS_POLL_7D_MS = 300_000;
export const EVENTS_STALE_MS = 15_000;

export const eventsPollMs = (period: EventPeriod): number => (period === '7d' ? EVENTS_POLL_7D_MS : EVENTS_POLL_MS);

export const eventsKey = (period: EventPeriod, kinds: readonly EventKind[], limit: number) =>
  ['observatory', 'events', { period, kinds: kinds.join(','), limit }] as const;

/** Canonical (server order), deduplicated kinds; an empty or all-seven list is "no filter" (no param, the warmed key). */
export function canonicalKinds(kinds: readonly EventKind[] | undefined): EventKind[] {
  if (!kinds || kinds.length === 0) return [];
  const on = new Set<string>(kinds);
  const out = EVENT_KINDS.filter(k => on.has(k));
  return out.length === EVENT_KINDS.length ? [] : out;
}

export function eventsUrl(period: EventPeriod, kinds: readonly EventKind[], limit: number): string {
  return buildObservatoryUrl('/api/observatory/events', {
    period,
    kinds: kinds.length > 0 ? kinds.join(',') : undefined,
    limit,
  });
}

interface EventsEnvelope {
  success: boolean;
  data?: ObservatoryEvent[];
  error?: string;
  counts_by_kind?: Partial<Record<EventKind, number>>;
  meta?: Partial<EventsMeta>;
}

const kindList = (v: unknown): EventKind[] =>
  Array.isArray(v) ? v.filter((k): k is EventKind => typeof k === 'string' && (EVENT_KINDS as readonly string[]).includes(k)) : [];

/** A response with missing pieces reads as empty ones (a cached payload from an older worker, a partial mock). */
export function normalizeEvents(res: EventsEnvelope, period: EventPeriod): EventsResult {
  const meta = res.meta ?? {};
  return {
    events: Array.isArray(res.data) ? res.data : [],
    counts: res.counts_by_kind ?? {},
    meta: {
      ...EVENTS_EMPTY_META,
      generated_at: typeof meta.generated_at === 'string' ? meta.generated_at : null,
      period,
      omitted_kinds: kindList(meta.omitted_kinds),
      capped_kinds: kindList(meta.capped_kinds),
      failed_kinds: kindList(meta.failed_kinds),
    },
  };
}

export interface UseObservatoryEventsOptions {
  period?: EventPeriod;
  /** Kind filter. Empty / all seven = every kind (the default, warmed request). */
  kinds?: readonly EventKind[];
  limit?: number;
  enabled?: boolean;
}

export function useObservatoryEvents(options: UseObservatoryEventsOptions = {}): ObservatoryQueryResult<EventsResult> {
  const { period = EVENTS_DEFAULT_PERIOD, limit = EVENTS_DEFAULT_LIMIT, enabled = true } = options;
  const kinds = canonicalKinds(options.kinds);
  const q = useQuery({
    queryKey: eventsKey(period, kinds, limit),
    queryFn: async ({ signal }) => {
      const res = (await api.fetch<ObservatoryEvent[]>(eventsUrl(period, kinds, limit), { signal })) as EventsEnvelope;
      if (!res.success) throw new Error(res.error || 'Observatory events request failed');
      return normalizeEvents(res, period);
    },
    enabled,
    refetchInterval: eventsPollMs(period),
    refetchIntervalInBackground: false,
    staleTime: EVENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  return shape(q);
}
