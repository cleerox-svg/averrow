// App-wide TanStack Query client + retry policy.
//
// Retry rules (UI consolidation PR6b):
//   - 4xx (ApiError.status 400-499) never retries: the server answered and a
//     retry will get the same answer.
//   - Anything else (5xx, network) retries at most ONCE.
//   - Polling queries (`refetchInterval` set) never retry: the next tick is
//     already the retry, and stacked retries + intervals hammer a failing
//     endpoint. Applied centrally in `defaultQueryOptions` so the ~67 hooks
//     don't each need editing. A hook that sets its own `retry` still wins.

import { QueryClient } from '@tanstack/react-query';

export const MAX_RETRIES = 1;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  return failureCount < MAX_RETRIES;
}

const NO_RETRY = (): boolean => false;

/**
 * Wrap `client.defaultQueryOptions` (called by every QueryObserver) so queries
 * that poll default to no retry. A hook that passes its own `retry` wins.
 */
export function applyPollingNoRetry(client: QueryClient): QueryClient {
  const base = client.defaultQueryOptions.bind(client);
  client.defaultQueryOptions = ((options: Parameters<QueryClient['defaultQueryOptions']>[0]) => {
    const defaulted = base(options);
    const callerSetRetry = (options as { retry?: unknown }).retry !== undefined;
    if (!callerSetRetry && defaulted.refetchInterval) {
      return { ...defaulted, retry: NO_RETRY };
    }
    return defaulted;
  }) as QueryClient['defaultQueryOptions'];
  return client;
}

export function createAppQueryClient(): QueryClient {
  return applyPollingNoRetry(new QueryClient({
    defaultOptions: {
      queries: {
        // 30-minute staleTime means tab-switching between pages doesn't trigger
        // a refetch storm. Threat intel changes on a 15-min cron at the fastest,
        // so 5 minutes was needlessly aggressive. Mutations still invalidate
        // their relevant keys explicitly, so write paths stay correct.
        staleTime: 30 * 60_000,
        gcTime: 60 * 60_000, // keep in cache even when not displayed
        retry: shouldRetryQuery,
        refetchOnWindowFocus: false,
      },
    },
  }));
}
