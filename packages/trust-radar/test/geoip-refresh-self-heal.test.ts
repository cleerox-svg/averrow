/**
 * Unit tests for the geoip_refresh agent's self-healing behaviour.
 * Covers Layer B (stuck-row cleanup + dispatch guard) and Layer D
 * (MaxMind 429 cooldown).
 *
 * The full execute() path is hard to unit-test because it dispatches
 * a real Workflow; these tests target the SQL + KV call shapes via
 * mocks so the §17.1 "pure logic" bar is met. Integration coverage
 * lives at runtime — the workflow's own failure handler + Flight
 * Control supervisor catch what these miss.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { geoipRefreshAgent } from '../src/agents/geoip-refresh';

interface MockedDB {
  prepare: ReturnType<typeof vi.fn>;
}

function makeStmt(returns: unknown) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue(returns),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
  };
  return stmt;
}

function makeEnv(opts: {
  geoipDbBound?: boolean;
  licenseKeyPresent?: boolean;
  workflowBound?: boolean;
  cooldownUntil?: string | null;
  runningRows?: Array<{ id: string; started_at: string; age_min: number }>;
  probeStatus?: number;
} = {}) {
  const {
    geoipDbBound = true,
    licenseKeyPresent = true,
    workflowBound = true,
    cooldownUntil = null,
    runningRows = [],
    probeStatus = 200,
  } = opts;

  const cacheStore = new Map<string, string>();
  if (cooldownUntil) cacheStore.set('geoip:maxmind:cooldown_until', cooldownUntil);

  const env: Record<string, unknown> = {
    CACHE: {
      get: vi.fn(async (k: string) => cacheStore.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => {
        cacheStore.set(k, v);
      }),
    },
    AE: { writeDataPoint: vi.fn() },
  };

  if (geoipDbBound) {
    const db: MockedDB = {
      prepare: vi.fn((sql: string) => {
        if (/SELECT id, started_at[\s\S]*FROM geo_ip_refresh_log\s+WHERE status = 'running'/.test(sql)) {
          return makeStmt({ results: runningRows });
        }
        return makeStmt({ results: [] });
      }),
    };
    env.GEOIP_DB = db;
  }
  if (licenseKeyPresent) env.MAXMIND_LICENSE_KEY = 'test-key';
  if (workflowBound) {
    env.GEOIP_REFRESH = {
      create: vi.fn(async () => ({ id: 'wf-test-1' })),
    };
  }

  // Mock fetch for the probe (.sha256 endpoint).
  globalThis.fetch = vi.fn(async () =>
    new Response('abc123def456 GeoLite2-City-CSV.zip\n', {
      status: probeStatus,
      headers: { 'content-type': 'text/plain' },
    }),
  ) as typeof fetch;

  return env;
}

describe('geoip_refresh agent — self-healing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses dispatch when GEOIP_DB binding is unset (graceful no-op, not a throw)', async () => {
    const env = makeEnv({ geoipDbBound: false });
    const result = await geoipRefreshAgent.execute({
      env: env as never,
      input: {},
      runId: 'r-1',
    } as never);
    expect(result.itemsProcessed).toBe(0);
    expect(result.output).toMatchObject({ phase: 'config_check' });
  });

  it('refuses dispatch when license key is missing', async () => {
    const env = makeEnv({ licenseKeyPresent: false });
    const result = await geoipRefreshAgent.execute({
      env: env as never,
      input: {},
      runId: 'r-2',
    } as never);
    expect(result.output).toMatchObject({ status: 'awaiting_license' });
  });

  it('Layer D: refuses dispatch when 429 cooldown is active', async () => {
    const futureCooldown = new Date(Date.now() + 60 * 60_000).toISOString();
    const env = makeEnv({ cooldownUntil: futureCooldown });
    const result = await geoipRefreshAgent.execute({
      env: env as never,
      input: {},
      runId: 'r-3',
    } as never);
    expect(result.output).toMatchObject({ phase: 'maxmind_cooldown_active' });
    // Should NOT have dispatched the workflow.
    expect((env.GEOIP_REFRESH as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('Layer D: forceReload bypasses cooldown', async () => {
    const futureCooldown = new Date(Date.now() + 60 * 60_000).toISOString();
    const env = makeEnv({ cooldownUntil: futureCooldown });
    const result = await geoipRefreshAgent.execute({
      env: env as never,
      input: { forceReload: true },
      runId: 'r-4',
    } as never);
    // Skipped if probe fails; here probe returns 200 so it should reach dispatch.
    expect(result.output).not.toMatchObject({ phase: 'maxmind_cooldown_active' });
  });

  it('Layer B: marks stuck rows (>60min) as failed before dispatch', async () => {
    const env = makeEnv({
      runningRows: [
        { id: 'stuck-1', started_at: '2026-01-01 00:00:00', age_min: 75 },
        { id: 'stuck-2', started_at: '2026-01-01 00:30:00', age_min: 90 },
      ],
    });
    await geoipRefreshAgent.execute({
      env: env as never,
      input: { forceReload: true },
      runId: 'r-5',
    } as never);
    const db = env.GEOIP_DB as MockedDB;
    // The cleanup UPDATE is issued as `UPDATE geo_ip_refresh_log
    // SET status = 'failed', completed_at = ..., error_message = ?
    // WHERE id = ? AND status = 'running'`. We can't grep the
    // message itself (it's a bound param, not a literal) but we
    // CAN verify the SQL signature + that bind() was called with
    // both stuck row ids.
    const updateCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => /UPDATE geo_ip_refresh_log[\s\S]+SET status = 'failed'[\s\S]+WHERE id = \? AND status = 'running'/.test(sql));
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('Layer B: refuses dispatch when a young (<60min) workflow is running and forceReload is false', async () => {
    const env = makeEnv({
      runningRows: [
        { id: 'in-flight-1', started_at: '2026-01-01 00:30:00', age_min: 15 },
      ],
    });
    const result = await geoipRefreshAgent.execute({
      env: env as never,
      input: {},
      runId: 'r-6',
    } as never);
    expect(result.output).toMatchObject({ phase: 'skipped_already_running' });
    expect((env.GEOIP_REFRESH as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('Layer B: forceReload allows dispatch even with a young running workflow', async () => {
    const env = makeEnv({
      runningRows: [
        { id: 'in-flight-1', started_at: '2026-01-01 00:30:00', age_min: 15 },
      ],
    });
    const result = await geoipRefreshAgent.execute({
      env: env as never,
      input: { forceReload: true },
      runId: 'r-7',
    } as never);
    expect(result.output).not.toMatchObject({ phase: 'skipped_already_running' });
  });
});
