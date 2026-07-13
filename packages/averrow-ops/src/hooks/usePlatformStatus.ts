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

// The worker is expected to return the PlatformStatus body directly (not
// wrapped in {success, data, error}). But api.get() only throws on 401
// (see src/lib/api.ts), so a transient 500 that returns the platform's
// generic error envelope {success:false, error:"..."} resolves as data
// instead of rejecting. That envelope is a truthy object with no `overall`
// field, so a blind cast would let `undefined` reach consumers that key a
// lookup table on `data.overall` (e.g. PlatformStatusBadge's PALETTE[status])
// and crash. Narrow the shape before trusting it.
//
// Validate BOTH fields the two consumers dereference: PlatformStatusBadge
// reads `overall`, and PlatformStatusFlyout iterates `categories.map(...)`.
// Requiring `categories` to be an array keeps a contract-drifted response
// (valid `overall` but missing `categories`) from relocating the same crash
// class into the flyout.
function isPlatformStatus(value: unknown): value is PlatformStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { overall?: unknown }).overall === 'string' &&
    Array.isArray((value as { categories?: unknown }).categories)
  );
}

export function usePlatformStatus() {
  return useQuery({
    queryKey: ['platform-status'],
    queryFn: async (): Promise<PlatformStatus | null> => {
      try {
        const res = await api.get('/api/v1/public/platform-status');
        return isPlatformStatus(res) ? res : null;
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
