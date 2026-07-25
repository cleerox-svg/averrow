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
  runningRows?: Array<{ id: string; started_at: string; age_min: number; last_committed_row?: number }>;
  /** Prior KV stall watermarks keyed by refresh row id. */
  watch?: Record<string, { hwm: number; since: string }>;
  probeStatus?: number;
} = {}) {
  const {
    geoipDbBound = true,
    licenseKeyPresent = true,
    workflowBound = true,
    cooldownUntil = null,
    runningRows = [],
    watch = {},
    probeStatus = 200,
  } = opts;

  const cacheStore = new Map<string, string>();
  if (cooldownUntil) cacheStore.set('geoip:maxmind:cooldown_until', cooldownUntil);
  for (const [id, w] of Object.entries(watch)) {
    cacheStore.set(`geoip:stuck_watch:${id}`, JSON.stringify(w));
  }

  const env: Record<string, unknown> = {
    CACHE: {
      // Mirror the real KVNamespace.get(key, 'json') contract: parse
      // when the caller asks for json, return the raw string otherwise.
      get: vi.fn(async (k: string, type?: string) => {
        const v = cacheStore.get(k) ?? null;
        if (v !== null && type === 'json') return JSON.parse(v);
        return v;
      }),
      put: vi.fn(async (k: string, v: string) => {
        cacheStore.set(k, v);
      }),
      delete: vi.fn(async (k: string) => {
        cacheStore.delete(k);
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

  const recoveryUpdateCount = (db: MockedDB) =>
    (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => /UPDATE geo_ip_refresh_log[\s\S]+SET status = 'failed'[\s\S]+WHERE id = \? AND status = 'running'/.test(sql))
      .length;

  it('Layer B: does NOT recover a still-progressing run, even an old one (progress-aware)', async () => {
    // age 200 min but the checkpoint advanced past the prior watermark
    // → in-flight, not stuck. Must not be force-failed, and must suppress
    // a duplicate dispatch.
    const env = makeEnv({
      runningRows: [
        { id: 'progressing-1', started_at: '2026-01-01 00:00:00', age_min: 200, last_committed_row: 500_000 },
      ],
      watch: { 'progressing-1': { hwm: 100_000, since: new Date().toISOString() } },
    });
    const result = await geoipRefreshAgent.execute({
      env: env as never, input: {}, runId: 'r-5a',
    } as never);
    expect(result.output).toMatchObject({ phase: 'skipped_already_running' });
    expect(recoveryUpdateCount(env.GEOIP_DB as MockedDB)).toBe(0);
    expect((env.GEOIP_REFRESH as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('Layer B: recovers a run whose checkpoint is flat past the grace window', async () => {
    // age 200 (>= 180 floor), checkpoint flat at 500K since 120 min ago
    // (>= 90 grace) → stuck. Force-failed, then a fresh dispatch proceeds.
    const env = makeEnv({
      runningRows: [
        { id: 'flat-1', started_at: '2026-01-01 00:00:00', age_min: 200, last_committed_row: 500_000 },
      ],
      watch: { 'flat-1': { hwm: 500_000, since: new Date(Date.now() - 120 * 60_000).toISOString() } },
    });
    await geoipRefreshAgent.execute({
      env: env as never, input: { forceReload: true }, runId: 'r-5b',
    } as never);
    expect(recoveryUpdateCount(env.GEOIP_DB as MockedDB)).toBeGreaterThanOrEqual(1);
  });

  it('Layer B: recovers a run that blew the hard runaway ceiling regardless of progress', async () => {
    // age 800 min (> 720 hard ceiling) → recovered even though the
    // checkpoint is still advancing.
    const env = makeEnv({
      runningRows: [
        { id: 'runaway-1', started_at: '2026-01-01 00:00:00', age_min: 800, last_committed_row: 3_000_000 },
      ],
      watch: { 'runaway-1': { hwm: 1_000_000, since: new Date().toISOString() } },
    });
    await geoipRefreshAgent.execute({
      env: env as never, input: { forceReload: true }, runId: 'r-5c',
    } as never);
    expect(recoveryUpdateCount(env.GEOIP_DB as MockedDB)).toBeGreaterThanOrEqual(1);
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
