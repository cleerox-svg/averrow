import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PlatformStatus } from '@averrow/shared';

// Live platform health rollup for the Home banner (and Phase 3
// public status page). Reads /api/v1/public/platform-status — public
// because every signed-in user sees the banner and we'll also expose
// the same data on the public status page in Phase 3. The worker
// caches the response for 60s in KV, so frequent polling is cheap.
//
// We refetch every 60s so the banner flips within ~1 min of an
// outage. `staleTime` is shorter than the cache TTL on purpose: a
// user navigating back to Home should hit the cache (fast) but a
// long-resident tab should still refresh.
const POLL_MS = 60_000;

export function usePlatformStatus() {
  return useQuery({
    queryKey: ['platform-status'],
    queryFn: async (): Promise<PlatformStatus | null> => {
      try {
        // The worker returns the PlatformStatus body directly (not wrapped
        // in {success, data, error}). Cast through unknown to hand the
        // typed object to consumers.
        const res = await api.get('/api/v1/public/platform-status');
        return res as unknown as PlatformStatus;
      } catch {
        // Surface a `null` state to consumers rather than throwing — the
        // banner should fall back to a neutral "checking…" pill instead
        // of crashing the page when the endpoint is unreachable.
        return null;
      }
    },
    refetchInterval: POLL_MS,
    staleTime: 30_000,
  });
}
