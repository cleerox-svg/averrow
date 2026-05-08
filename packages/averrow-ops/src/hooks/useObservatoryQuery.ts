import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '@/lib/api';

interface UseObservatoryQueryOptions {
  staleTime?: number;       // ms; data older than this triggers background refetch (default 5min)
  enabled?: boolean;        // gate the fetch (default true)
  refetchInterval?: number; // ms; auto-refetch interval (optional)
}

export interface UseObservatoryQueryResult<T> {
  data: T | null;
  isLoading: boolean;    // true only when no cached data is available AND fetching
  isRefreshing: boolean; // true during background refetch when cached data exists
  error: Error | null;
  refetch: () => void;
}

// Module-level cache (survives component unmount/remount within the session)
const queryCache = new Map<string, { data: unknown; timestamp: number }>();
const inFlightRequests = new Map<string, Promise<unknown>>();

function buildCacheKey(endpoint: string, params: Record<string, string | number>): string {
  const sorted = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, String(v)]);
  return `${endpoint}?${new URLSearchParams(sorted).toString()}`;
}

function buildUrl(endpoint: string, params: Record<string, string | number>): string {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  return qs ? `${endpoint}?${qs}` : endpoint;
}

export function useObservatoryQuery<T>(
  endpoint: string,
  params: Record<string, string | number>,
  options: UseObservatoryQueryOptions = {}
): UseObservatoryQueryResult<T> {
  const { staleTime = 300_000, enabled = true, refetchInterval } = options;

  const cacheKey = buildCacheKey(endpoint, params);

  const [data, setData] = useState<T | null>(() => {
    const cached = queryCache.get(cacheKey);
    return cached ? (cached.data as T) : null;
  });
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(!queryCache.has(cacheKey));
  const [isRefreshing, setIsRefreshing] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;

  // Stable refs so fetchData doesn't need endpoint/params in its deps
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const fetchData = useCallback(async (isBackground: boolean) => {
    // Abort previous in-flight request from this hook instance
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const currentKey = cacheKeyRef.current;

    if (isBackground) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setError(null);

    // In-flight dedup: reuse existing promise for same cache key.
    // Only create a new request if no promise exists for this key.
    let promise = inFlightRequests.get(currentKey);
    if (!promise) {
      const url = buildUrl(endpointRef.current, paramsRef.current);
      promise = api
        .fetch<T>(url, { signal: controller.signal })
        .then((res) => {
          if (!res.success) throw new Error(res.error || `${endpointRef.current} failed`);
          return res.data;
        });
      inFlightRequests.set(currentKey, promise);
    }

    try {
      const result = await promise;
      // Only update state if this is still the active request
      if (cacheKeyRef.current === currentKey) {
        queryCache.set(currentKey, { data: result, timestamp: Date.now() });
        setData(result as T);
        setError(null);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof Error && err.name === 'AbortError') return;
      if (cacheKeyRef.current === currentKey) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      inFlightRequests.delete(currentKey);
      if (cacheKeyRef.current === currentKey) {
        if (isBackground) setIsRefreshing(false);
        else setIsLoading(false);
      }
    }
  }, []); // stable — reads all dynamic values via refs

  // Primary effect: fetch on mount and when deps change
  useEffect(() => {
    if (!enabled) return;

    const cached = queryCache.get(cacheKey);
    const isStale = !cached || Date.now() - cached.timestamp > staleTime;

    if (cached) {
      setData(cached.data as T);
      setIsLoading(false);
    }

    if (isStale) {
      fetchData(!!cached);
    }

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [cacheKey, enabled, staleTime, fetchData]);

  // Optional auto-refetch interval (preserves parity with previous refetchInterval behaviour)
  useEffect(() => {
    if (!enabled || !refetchInterval) return;

    const interval = setInterval(() => {
      fetchData(true);
    }, refetchInterval);

    return () => clearInterval(interval);
  }, [enabled, refetchInterval, fetchData]);

  const refetch = useCallback(() => fetchData(data !== null), [fetchData, data]);

  return { data, isLoading, isRefreshing, error, refetch };
}
