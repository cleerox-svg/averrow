import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';
import { applyPollingNoRetry, createAppQueryClient, shouldRetryQuery } from './query-client';

type RetryFn = (count: number, error: Error) => boolean;
const retryOf = (client: QueryClient, opts: Record<string, unknown>) =>
  client.defaultQueryOptions({ queryKey: ['k'], queryFn: async () => 1, ...opts } as never).retry as RetryFn | boolean | number | undefined;

describe('shouldRetryQuery', () => {
  it('never retries a 4xx', () => {
    for (const status of [400, 401, 403, 404, 422, 499]) {
      expect(shouldRetryQuery(0, new ApiError('x', status))).toBe(false);
    }
  });

  it('retries a 5xx exactly once', () => {
    const err = new ApiError('boom', 503);
    expect(shouldRetryQuery(0, err)).toBe(true);
    expect(shouldRetryQuery(1, err)).toBe(false);
    expect(shouldRetryQuery(2, err)).toBe(false);
  });

  it('retries a plain network error (no status) exactly once', () => {
    expect(shouldRetryQuery(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetryQuery(1, new TypeError('Failed to fetch'))).toBe(false);
  });

  it('ApiError carries status and is an Error', () => {
    const e = new ApiError('boom', 500);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(500);
    expect(e.message).toBe('boom');
  });
});

describe('polling queries', () => {
  it('default to no retry when refetchInterval is set', () => {
    const client = createAppQueryClient();
    const retry = retryOf(client, { refetchInterval: 30_000 }) as RetryFn;
    expect(typeof retry).toBe('function');
    expect(retry(0, new ApiError('boom', 500))).toBe(false);
  });

  it('non-polling queries keep the shared predicate (one retry for 5xx)', () => {
    const client = createAppQueryClient();
    expect(retryOf(client, {})).toBe(shouldRetryQuery);
  });

  it('a hook that sets its own retry still wins, even when polling', () => {
    const client = createAppQueryClient();
    expect(retryOf(client, { refetchInterval: 1000, retry: 3 })).toBe(3);
  });

  it('applyPollingNoRetry leaves a client without polling untouched', () => {
    const client = applyPollingNoRetry(new QueryClient({ defaultOptions: { queries: { retry: 5 } } }));
    expect(retryOf(client, {})).toBe(5);
  });
});
