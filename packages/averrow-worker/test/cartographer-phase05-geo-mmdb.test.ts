/**
 * fix(cartographer) 0ee677e — Phase 0.5 GeoIP MMDB rewrite.
 *
 * This is dedicated coverage for the one commit in PR #1711 that
 * shipped without its own tests. Three behaviors changed and none of
 * them are pure/extractable, so this suite drives the real
 * `cartographerAgent.execute()` end-to-end and starves every OTHER
 * phase (Phase 0 ip-api, Phase 1 ipinfo, Phase 2 Haiku scoring,
 * Phase 3 email security, Phase 4 DMARC, Phase 5 stats, and the
 * batches-API poll/submit) with empty result sets or a mocked dynamic
 * import, so only Phase 0.5 does real work. `lookupGeoMmdb` (a
 * dynamic `await import("../lib/geoip-mmdb")` inside the phase) is
 * mocked to return canned GeoLite2 answers per test.
 *
 * Behaviors under test:
 *   1. Partial hit (country/ASN, no lat/lng) stamps country_code/asn +
 *      geo_mmdb_checked_at but leaves enriched_at NULL — a row with no
 *      coordinates must never graduate into the "stuck pile" metric.
 *   2. The give-up marker is `geo_mmdb_checked_at`, never
 *      `enrichment_attempts` — on all three paths (full hit / partial
 *      hit / true miss) and on the selector itself. This is the whole
 *      point of the fix: stop burning Phase 0's ip-api retry budget.
 *   3. `MMDB_BUDGET_MS` (90s) wall-clock guard breaks the loop early
 *      and flips `mmdbBudgetHit`, which changes the output summary.
 *   4. Marker writes batch through `env.DB.batch()` in chunks of 100,
 *      and a failing chunk is caught + logged without killing the
 *      phase or the run.
 *
 * Assertions target the SQL text + bindings pushed into `env.DB.batch()`
 * rather than a simulated real D1 — that is what makes the
 * no-`enrichment_attempts` invariant provable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";
import type { AgentContext } from "../src/lib/agentRunner";
import { cartographerAgent, PROVIDER_STATS_LAST_RUN_KEY } from "../src/agents/cartographer";
import type { GeoIpLookupResult } from "../src/lib/geoip-mmdb";

// ─── Phase 0.5's own dependency — this is the thing each test drives ───
const lookupGeoMmdbMock = vi.fn<(env: Env, ip: string) => Promise<GeoIpLookupResult | null>>();
vi.mock("../src/lib/geoip-mmdb", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/geoip-mmdb")>(
    "../src/lib/geoip-mmdb",
  );
  return {
    ...actual,
    lookupGeoMmdb: (env: Env, ip: string) => lookupGeoMmdbMock(env, ip),
  };
});

// ─── Neutralize every other phase so Phase 0.5 is the only real work ───
// Phase 1 (ipinfo fallback) — real fetch otherwise.
vi.mock("../src/lib/geoip", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/geoip")>("../src/lib/geoip");
  return {
    ...actual,
    enrichThreatsGeo: vi.fn(async () => ({
      enriched: 0,
      total: 0,
      skippedPrivate: 0,
      skippedNoResult: 0,
      errors: [] as string[],
    })),
  };
});

// Lever #6 batches API poll/submit — real network + KV state otherwise.
vi.mock("../src/lib/cartographer-batch", () => ({
  pollAndIngestCartographerBatches: vi.fn(async () => ({
    polled: 0,
    ingested_batches: 0,
    ingested_providers: 0,
    cost_usd: 0,
    errors: [] as string[],
  })),
  submitCartographerScoringBatch: vi.fn(async () => ({
    submitted: 0,
    batch_id: null,
    skipped_reason: "test-noop",
  })),
}));

// ─── Fake D1 ─────────────────────────────────────────────────────────

interface CapturedWrite {
  sql: string;
  args: unknown[];
}

interface StuckRow {
  id: string;
  ip_address: string;
}

function makeCartographerDb(stuckRows: StuckRow[]) {
  const preparedSqls: string[] = [];
  const runCalls: CapturedWrite[] = [];
  const batchChunks: CapturedWrite[][] = [];
  const failChunkIndexes = new Set<number>();

  function makeStmt(sql: string, args: unknown[] = []): CapturedWrite & Record<string, unknown> {
    return {
      sql,
      args,
      bind: (...next: unknown[]) => makeStmt(sql, next),
      run: async () => {
        runCalls.push({ sql, args });
        return { meta: {}, success: true };
      },
      first: async <T,>(): Promise<T | null> => {
        // Phase 2's hosting_providers rollup (COUNT + SUM) — the only
        // .first() Phase 0.5's own path never calls, kept generic so
        // the rest of execute() doesn't throw on a null cache miss.
        if (/SELECT COUNT\(\*\) AS providers/i.test(sql)) {
          return { providers: 0, with_provider: 0 } as unknown as T;
        }
        return null;
      },
      all: async <T,>(): Promise<{ results: T[] }> => {
        // Phase 0.5's selector — the only query this suite feeds real data.
        if (/geo_mmdb_checked_at IS NULL/.test(sql)) {
          return { results: stuckRows as unknown as T[] };
        }
        // Every other SELECT (Phase 0 unenriched, Phase 2 providers,
        // Phase 3 brands, Phase 4 dmarc records) starves to empty so
        // its phase no-ops.
        return { results: [] as T[] };
      },
    } as unknown as CapturedWrite & Record<string, unknown>;
  }

  const db = {
    prepare: (sql: string) => {
      preparedSqls.push(sql);
      return makeStmt(sql);
    },
    batch: async (stmts: CapturedWrite[]) => {
      const idx = batchChunks.length;
      batchChunks.push(stmts.map((s) => ({ sql: s.sql, args: s.args })));
      if (failChunkIndexes.has(idx)) {
        throw new Error(`simulated batch failure (chunk ${idx})`);
      }
      return stmts.map(() => ({ meta: {}, success: true }));
    },
  } as unknown as D1Database;

  return { db, preparedSqls, runCalls, batchChunks, failChunk: (idx: number) => failChunkIndexes.add(idx) };
}

function makeEnv(db: D1Database, now: () => number): Env {
  return {
    DB: db,
    CACHE: {
      get: async (key: string) =>
        key === PROVIDER_STATS_LAST_RUN_KEY ? String(now()) : null,
      put: async () => {},
    } as unknown as KVNamespace,
  } as unknown as Env;
}

function makeCtx(env: Env): AgentContext {
  return {
    env,
    runId: "run-test-1",
    agentName: "cartographer",
    input: {},
    // Not the maintenance instance — keeps Phase 2's raw threats scan
    // on the peekCount (KV-only) path instead of computing.
    triggeredBy: "flight_control",
  };
}

function geo(overrides: Partial<GeoIpLookupResult> = {}): GeoIpLookupResult {
  return {
    ip: "1.2.3.4",
    countryCode: null,
    countryName: null,
    region: null,
    city: null,
    postalCode: null,
    lat: null,
    lng: null,
    asn: null,
    asnOrg: null,
    source: "geolite2-test",
    ...overrides,
  };
}

function flatWrites(batchChunks: CapturedWrite[][]): CapturedWrite[] {
  return batchChunks.flat();
}

function findMmdbOutput(outputs: { summary: string; details?: unknown }[] | undefined) {
  return outputs?.find((o) => o.summary.startsWith("mmdb lookup:"));
}

beforeEach(() => {
  lookupGeoMmdbMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 1. Partial hit — the new branch, and the invariant it exists to protect ───

describe("Phase 0.5 — partial hit (country/ASN, no coordinates)", () => {
  it("stamps country_code/asn + geo_mmdb_checked_at but leaves enriched_at untouched", async () => {
    const row: StuckRow = { id: "t-partial-1", ip_address: "203.0.113.5" };
    const { db, batchChunks, runCalls } = makeCartographerDb([row]);
    lookupGeoMmdbMock.mockResolvedValueOnce(
      geo({ countryCode: "RU", asn: "AS12345", lat: null, lng: null }),
    );

    const env = makeEnv(db, () => Date.now());
    const result = await cartographerAgent.execute(makeCtx(env));

    const writes = flatWrites(batchChunks);
    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write!.sql).toMatch(/geo_mmdb_checked_at\s*=\s*datetime\('now'\)/);
    expect(write!.sql).toMatch(/country_code\s*=\s*COALESCE\(country_code, \?\)/);
    expect(write!.sql).toMatch(/asn\s*=\s*COALESCE\(asn, \?\)/);
    // The invariant: a coordinate-less row must NOT graduate to the
    // stuck pile (enriched but no geo). This is provable directly on
    // the SQL text — enriched_at must not appear in the partial-hit
    // UPDATE at all.
    expect(write!.sql).not.toMatch(/enriched_at/);
    expect(write!.args).toEqual(["RU", "AS12345", "t-partial-1"]);

    // Never touches enrichment_attempts — that budget belongs to Phase 0.
    expect(write!.sql).not.toMatch(/enrichment_attempts/);
    expect(runCalls.some((c) => /enrichment_attempts/.test(c.sql))).toBe(false);

    const mmdbOutput = findMmdbOutput(result.agentOutputs);
    expect(mmdbOutput?.summary).toContain("1 country/ASN only");
    expect(mmdbOutput?.details).toMatchObject({ attempted: 1, resolved: 0, partial: 1, budget_hit: false });

    // A partial hit still counts as "updated" (we wrote country/ASN),
    // but it must not be double-counted as a full geo resolution.
    expect(result.itemsUpdated).toBe(1);
  });

  it("also treats an ASN-only hit (no country) as partial, not a miss", async () => {
    const row: StuckRow = { id: "t-partial-2", ip_address: "203.0.113.6" };
    const { db, batchChunks } = makeCartographerDb([row]);
    lookupGeoMmdbMock.mockResolvedValueOnce(geo({ countryCode: null, asn: "AS999", lat: null, lng: null }));

    const env = makeEnv(db, () => Date.now());
    await cartographerAgent.execute(makeCtx(env));

    const writes = flatWrites(batchChunks);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toMatch(/asn\s*=\s*COALESCE\(asn, \?\)/);
    expect(writes[0]!.sql).not.toMatch(/enriched_at/);
  });
});

// ─── 2. Full hit — coordinates present, enriched_at DOES get stamped ───

describe("Phase 0.5 — full hit (lat/lng present)", () => {
  it("stamps lat/lng/country/asn + geo_mmdb_checked_at AND enriched_at", async () => {
    const row: StuckRow = { id: "t-full-1", ip_address: "198.51.100.7" };
    const { db, batchChunks, runCalls } = makeCartographerDb([row]);
    lookupGeoMmdbMock.mockResolvedValueOnce(
      geo({ lat: 51.5, lng: -0.12, countryCode: "GB", asn: "AS7018" }),
    );

    const env = makeEnv(db, () => Date.now());
    const result = await cartographerAgent.execute(makeCtx(env));

    const writes = flatWrites(batchChunks);
    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write!.sql).toMatch(/lat\s*=\s*COALESCE\(lat, \?\)/);
    expect(write!.sql).toMatch(/lng\s*=\s*COALESCE\(lng, \?\)/);
    expect(write!.sql).toMatch(/geo_mmdb_checked_at\s*=\s*datetime\('now'\)/);
    expect(write!.sql).toMatch(/enriched_at\s*=\s*CASE WHEN enriched_at IS NULL/);
    expect(write!.args).toEqual([51.5, -0.12, "GB", "AS7018", "t-full-1"]);

    expect(write!.sql).not.toMatch(/enrichment_attempts/);
    expect(runCalls.some((c) => /enrichment_attempts/.test(c.sql))).toBe(false);

    const mmdbOutput = findMmdbOutput(result.agentOutputs);
    expect(mmdbOutput?.summary).toBe(
      "mmdb lookup: 1/1 threats geo-located via local GeoIP DB (0 country/ASN only)",
    );
    expect(mmdbOutput?.details).toMatchObject({ attempted: 1, resolved: 1, partial: 0, budget_hit: false });
    expect(result.itemsUpdated).toBe(1);
  });
});

// ─── 3. True miss — GeoLite2 has nothing at all ───

describe("Phase 0.5 — true miss (GeoLite2 doesn't cover the IP)", () => {
  it("stamps only geo_mmdb_checked_at, no other column, no enrichment_attempts", async () => {
    const row: StuckRow = { id: "t-miss-1", ip_address: "192.0.2.55" };
    const { db, batchChunks, runCalls } = makeCartographerDb([row]);
    lookupGeoMmdbMock.mockResolvedValueOnce(null);

    const env = makeEnv(db, () => Date.now());
    const result = await cartographerAgent.execute(makeCtx(env));

    const writes = flatWrites(batchChunks);
    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write!.sql).toMatch(/^\s*UPDATE threats SET geo_mmdb_checked_at = datetime\('now'\) WHERE id = \?\s*$/);
    expect(write!.args).toEqual(["t-miss-1"]);
    expect(write!.sql).not.toMatch(/enrichment_attempts/);
    expect(runCalls.some((c) => /enrichment_attempts/.test(c.sql))).toBe(false);

    const mmdbOutput = findMmdbOutput(result.agentOutputs);
    expect(mmdbOutput?.details).toMatchObject({ attempted: 1, resolved: 0, partial: 0, budget_hit: false });
    // A true miss is not an "update" — nothing useful was learned.
    expect(result.itemsUpdated).toBe(0);
  });
});

// ─── 4. The selector itself: geo_mmdb_checked_at, never enrichment_attempts ───

describe("Phase 0.5 — give-up marker selector", () => {
  it("selects on geo_mmdb_checked_at IS NULL and never references enrichment_attempts, across all three outcomes", async () => {
    const rows: StuckRow[] = [
      { id: "t-full", ip_address: "198.51.100.7" },
      { id: "t-partial", ip_address: "203.0.113.5" },
      { id: "t-miss", ip_address: "192.0.2.55" },
    ];
    const { db, preparedSqls, runCalls, batchChunks } = makeCartographerDb(rows);
    lookupGeoMmdbMock
      .mockResolvedValueOnce(geo({ lat: 1, lng: 2, countryCode: "US", asn: "AS1" }))
      .mockResolvedValueOnce(geo({ countryCode: "RU", asn: "AS2", lat: null, lng: null }))
      .mockResolvedValueOnce(null);

    const env = makeEnv(db, () => Date.now());
    const result = await cartographerAgent.execute(makeCtx(env));

    const selectorSql = preparedSqls.find(
      (sql) => sql.includes("FROM threats") && sql.includes("geo_mmdb_checked_at IS NULL"),
    );
    expect(selectorSql).toBeDefined();
    expect(selectorSql).not.toMatch(/enrichment_attempts/);

    // Not one write, on any of the three paths, ever names enrichment_attempts.
    const writes = flatWrites(batchChunks);
    expect(writes).toHaveLength(3);
    for (const w of writes) expect(w.sql).not.toMatch(/enrichment_attempts/);
    expect(runCalls.some((c) => /enrichment_attempts/.test(c.sql))).toBe(false);

    const mmdbOutput = findMmdbOutput(result.agentOutputs);
    expect(mmdbOutput?.details).toMatchObject({ attempted: 3, resolved: 1, partial: 1, budget_hit: false });
  });
});

// ─── 5. MMDB_BUDGET_MS wall-clock guard ───

describe("Phase 0.5 — MMDB_BUDGET_MS wall-clock guard", () => {
  it("breaks the loop once the budget is exceeded, sets mmdbBudgetHit, and truncates the summary", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const rows: StuckRow[] = [
      { id: "t-1", ip_address: "198.51.100.1" },
      { id: "t-2", ip_address: "198.51.100.2" },
    ];
    const { db, batchChunks } = makeCartographerDb(rows);

    // Row 1's lookup "takes" 95s of wall-clock time (past the 90s
    // budget) — the loop must not even start row 2.
    lookupGeoMmdbMock.mockImplementationOnce(async () => {
      clock = 95_000;
      return geo({ lat: 10, lng: 20, countryCode: "CA", asn: "AS3" });
    });

    const env = makeEnv(db, () => clock);
    const result = await cartographerAgent.execute(makeCtx(env));

    expect(lookupGeoMmdbMock).toHaveBeenCalledTimes(1);
    const writes = flatWrites(batchChunks);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args).toEqual([10, 20, "CA", "AS3", "t-1"]);

    const mmdbOutput = findMmdbOutput(result.agentOutputs);
    expect(mmdbOutput?.summary).toContain("wall-clock budget hit, truncated");
    expect(mmdbOutput?.details).toMatchObject({ attempted: 1, resolved: 1, budget_hit: true });
  });

  it("does not set mmdbBudgetHit when every row finishes inside the budget", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const rows: StuckRow[] = [{ id: "t-1", ip_address: "198.51.100.1" }];
    const { db } = makeCartographerDb(rows);
    lookupGeoMmdbMock.mockImplementationOnce(async () => {
      clock = 1_000; // well inside the 90s budget
      return null;
    });

    const env = makeEnv(db, () => clock);
    const result = await cartographerAgent.execute(makeCtx(env));

    const mmdbOutput = findMmdbOutput(result.agentOutputs);
    expect(mmdbOutput?.summary).not.toContain("wall-clock budget hit");
    expect(mmdbOutput?.details).toMatchObject({ budget_hit: false });
  });
});

// ─── 6. Batched flush in chunks of 100 ───

describe("Phase 0.5 — batched marker flush", () => {
  it("flushes writes via env.DB.batch() in chunks of 100, not one .run() per row", async () => {
    const rows: StuckRow[] = Array.from({ length: 250 }, (_, i) => ({
      id: `t-${i}`,
      ip_address: `198.51.100.${(i % 250) + 1}`,
    }));
    const { db, batchChunks, runCalls } = makeCartographerDb(rows);
    lookupGeoMmdbMock.mockResolvedValue(null); // every row a true miss — simplest to count

    const env = makeEnv(db, () => Date.now());
    const result = await cartographerAgent.execute(makeCtx(env));

    expect(lookupGeoMmdbMock).toHaveBeenCalledTimes(250);
    expect(batchChunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(flatWrites(batchChunks)).toHaveLength(250);
    // No sequential single-row UPDATE .run() calls for these markers.
    expect(runCalls.filter((c) => /geo_mmdb_checked_at/.test(c.sql))).toHaveLength(0);

    const mmdbOutput = findMmdbOutput(result.agentOutputs);
    expect(mmdbOutput?.details).toMatchObject({ attempted: 250, resolved: 0, partial: 0 });
  });

  it("catches a failing chunk, logs it, and still flushes the remaining chunks / completes the run", async () => {
    const rows: StuckRow[] = Array.from({ length: 150 }, (_, i) => ({
      id: `t-${i}`,
      ip_address: `198.51.100.${(i % 250) + 1}`,
    }));
    const { db, batchChunks, failChunk } = makeCartographerDb(rows);
    failChunk(0); // the first 100-row chunk throws
    lookupGeoMmdbMock.mockResolvedValue(null);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeEnv(db, () => Date.now());
    // The whole point: a batch() rejection must not propagate out of
    // execute() and kill the rest of the cartographer run.
    await expect(cartographerAgent.execute(makeCtx(env))).resolves.toBeDefined();

    // Both chunks were attempted despite the first one throwing.
    expect(batchChunks).toHaveLength(2);
    expect(batchChunks[0]).toHaveLength(100);
    expect(batchChunks[1]).toHaveLength(50);
    expect(consoleErrorSpy.mock.calls.some((args) => String(args[0]).includes("mmdb flush failed"))).toBe(true);
  });
});
