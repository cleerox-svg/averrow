/**
 * Regression tests for lib/api.ts — the post-refresh retry's error
 * handling.
 *
 * Bug: after a 401 -> successful cookie refresh -> retry, a non-2xx
 * retry response (e.g. a 500 envelope `{success:false,error:...}`)
 * used to be handed straight to `retryResponse.json()` and resolved
 * as if it were valid data. Callers (react-query included) never saw
 * an error — they got a `{success:false,...}` object in their success
 * path. The fix makes a non-ok retry throw instead, and a retry that
 * is itself a 401 (session already dead) also fires `onUnauthorized`.
 *
 * No existing fetch-mock convention in this package (grepped — none),
 * so this file establishes one: `global.fetch` is replaced with a
 * `vi.fn()` that branches on the request URL, matching the module's
 * own two-call shape (refresh call, then the retried original call).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

function mockResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

describe('api.ts — post-refresh retry error handling', () => {
  beforeEach(() => {
    api.setTokens('initial-token', '');
    api.onAuthError(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a non-2xx retry after a successful refresh REJECTS, not resolves with the error envelope', async () => {
    let nonRefreshCalls = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/auth/refresh')) {
        return mockResponse(200, { success: true, data: { token: 'refreshed-token' } });
      }
      nonRefreshCalls++;
      if (nonRefreshCalls === 1) return mockResponse(401, { success: false, error: 'expired' });
      // The retry itself fails with a real server error.
      return mockResponse(500, { success: false, error: 'boom' });
    }) as unknown as typeof fetch;

    await expect(api.get('/api/agents')).rejects.toThrow('boom');
    expect(nonRefreshCalls).toBe(2); // initial 401 + one retry, no infinite loop
  });

  it('falls back to a status-based message when the non-2xx retry body is not JSON', async () => {
    let nonRefreshCalls = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/auth/refresh')) {
        return mockResponse(200, { success: true, data: { token: 'refreshed-token' } });
      }
      nonRefreshCalls++;
      if (nonRefreshCalls === 1) return mockResponse(401, { success: false, error: 'expired' });
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => { throw new Error('not json'); },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(api.get('/api/agents')).rejects.toThrow('Request failed: 503');
  });

  it('a retry that itself comes back 401 calls onUnauthorized and rejects (session already dead)', async () => {
    const onUnauthorized = vi.fn();
    api.onAuthError(onUnauthorized);

    let nonRefreshCalls = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/auth/refresh')) {
        return mockResponse(200, { success: true, data: { token: 'refreshed-token' } });
      }
      nonRefreshCalls++;
      return mockResponse(401, { success: false, error: 'still unauthorized' });
    }) as unknown as typeof fetch;

    await expect(api.get('/api/agents')).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(nonRefreshCalls).toBe(2); // initial 401 + one retry, both 401
  });

  it('baseline: a 2xx retry after refresh still resolves normally with the envelope', async () => {
    let nonRefreshCalls = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/auth/refresh')) {
        return mockResponse(200, { success: true, data: { token: 'refreshed-token' } });
      }
      nonRefreshCalls++;
      if (nonRefreshCalls === 1) return mockResponse(401, { success: false, error: 'expired' });
      return mockResponse(200, { success: true, data: { ok: true } });
    }) as unknown as typeof fetch;

    const result = await api.get<{ ok: boolean }>('/api/agents');
    expect(result).toEqual({ success: true, data: { ok: true } });
  });
});
