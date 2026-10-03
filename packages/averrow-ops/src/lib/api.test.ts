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
import { api, ApiError } from './api';

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

  it('a first-attempt 5xx GET REJECTS instead of resolving with the error envelope', async () => {
    global.fetch = vi.fn(async () => mockResponse(500, { success: false, error: 'db down' })) as unknown as typeof fetch;
    await expect(api.get('/api/alerts')).rejects.toThrow('db down');
  });

  it('the thrown error is an ApiError carrying the HTTP status (5xx, and the post-refresh retry)', async () => {
    global.fetch = vi.fn(async () => mockResponse(502, { success: false, error: 'bad gateway' })) as unknown as typeof fetch;
    const err = await api.get('/api/alerts').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);

    let calls = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/auth/refresh')) return mockResponse(200, { success: true, data: { token: 't' } });
      calls++;
      return calls === 1 ? mockResponse(401, {}) : mockResponse(404, { success: false, error: 'gone' });
    }) as unknown as typeof fetch;
    const retried = await api.get('/api/x').catch((e: unknown) => e);
    expect((retried as ApiError).status).toBe(404);
  });

  it('a 5xx on a mutation still resolves with the envelope (callers read res.error)', async () => {
    global.fetch = vi.fn(async () => mockResponse(500, { success: false, error: 'nope' })) as unknown as typeof fetch;
    await expect(api.post('/api/alerts/1', {})).resolves.toEqual({ success: false, error: 'nope' });
  });

  it('a 4xx GET still resolves with the envelope (not-found / permission copy is the caller\'s)', async () => {
    global.fetch = vi.fn(async () => mockResponse(404, { success: false, error: 'missing' })) as unknown as typeof fetch;
    await expect(api.get('/api/x')).resolves.toEqual({ success: false, error: 'missing' });
  });
});
