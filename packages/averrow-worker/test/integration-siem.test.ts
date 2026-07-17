import { describe, it, expect } from 'vitest';
import { parseSentinelConfig, deliverToSentinel } from '../src/lib/integrations/sentinel';
import { parseQRadarConfig } from '../src/lib/integrations/qradar';
import { isRetryableStatus, base64ToBytes, bytesToBase64 } from '../src/lib/integrations/push-types';

const GUID = '11111111-2222-3333-4444-555555555555';

describe('parseSentinelConfig', () => {
  it('rejects missing or malformed workspace/key', () => {
    expect(parseSentinelConfig(null)).toBeNull();
    expect(parseSentinelConfig({})).toBeNull();
    expect(parseSentinelConfig({ workspace_id: 'not-a-guid', shared_key: 'a' })).toBeNull();
    expect(parseSentinelConfig({ workspace_id: GUID })).toBeNull();
  });

  it('parses a valid config with a default log_type', () => {
    const cfg = parseSentinelConfig({ workspace_id: GUID, shared_key: 'c2VjcmV0' });
    expect(cfg).not.toBeNull();
    expect(cfg?.workspace_id).toBe(GUID);
    expect(cfg?.log_type).toBe('AverrowEvent');
  });

  it('rejects an invalid Log-Type (Azure allows letters/underscores only)', () => {
    expect(parseSentinelConfig({ workspace_id: GUID, shared_key: 'k', log_type: 'bad type!' })).toBeNull();
    expect(parseSentinelConfig({ workspace_id: GUID, shared_key: 'k', log_type: 'Good_Type1' })?.log_type)
      .toBe('Good_Type1');
  });
});

describe('parseQRadarConfig', () => {
  it('requires a receiver URL', () => {
    expect(parseQRadarConfig(null)).toBeNull();
    expect(parseQRadarConfig({})).toBeNull();
  });

  it('accepts the connect-sheet field names (url / api_token)', () => {
    const cfg = parseQRadarConfig({ url: 'https://qradar.acme.com:8443/x', api_token: 'tok' });
    expect(cfg?.receiver_url).toBe('https://qradar.acme.com:8443/x');
    expect(cfg?.auth_token).toBe('tok');
  });

  it('accepts the descriptive aliases (receiver_url / auth_token)', () => {
    const cfg = parseQRadarConfig({ receiver_url: 'https://q/r', auth_token: 't', auth_header: 'X-Sec' });
    expect(cfg?.receiver_url).toBe('https://q/r');
    expect(cfg?.auth_header).toBe('X-Sec');
  });
});

describe('isRetryableStatus', () => {
  it('treats network errors (undefined), 429, and 5xx as retryable', () => {
    expect(isRetryableStatus(undefined)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });
  it('treats 2xx/4xx as non-retryable', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe('base64 round-trip', () => {
  it('encodes and decodes bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual([0, 1, 2, 250, 255]);
  });
});

describe('deliverToSentinel', () => {
  it('signs the request with a SharedKey header and posts to the workspace host', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const cfg = parseSentinelConfig({ workspace_id: GUID, shared_key: 'c2VjcmV0', log_type: 'AverrowEvent' })!;
      const res = await deliverToSentinel(cfg, {
        event: 'takedown.status_changed',
        timestamp: '2026-06-30T00:00:00.000Z',
        org_id: 7,
        data: { takedown_id: 'td_1' },
      });
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain(`${GUID}.ods.opinsights.azure.com/api/logs`);
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(new RegExp(`^SharedKey ${GUID}:`));
      expect(headers['Log-Type']).toBe('AverrowEvent');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
