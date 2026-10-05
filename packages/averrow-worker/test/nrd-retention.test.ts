// nrd_domains tiered retention (lib/nrd-retention.ts + migration 0279):
// 30 days hot in D1, brand_matched rows kept, every row archived to R2 by
// the feed (test/nrd-hagezi-archive.test.ts).
//
// Runs purgeNrdDomains against the migration-derived nrd_domains shape plus
// the live (post-DROP) index set from migrations/, so a renamed column or a
// lost idx_nrd_domains_created fails here instead of silently turning every
// purge chunk into a full table scan.
//
// Invariants under test: a brand_matched = 1 row is NEVER deleted; a row the
// phantom matcher hasn't scanned (created_at >= its nrd cursor) is kept
// while the cursor is within now − 37 days — the hold is CLAMPED there, and
// a MISSING cursor holds at that floor; an unreadable / unrecognised cursor
// → nothing is deleted.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  fakeKv,
  type SqliteDb,
  type StatementLogEntry,
} from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import {
  purgeNrdDomains,
  shouldRunNrdRetention,
  parseNrdRetentionLastResult,
  toSqliteUtc,
  NRD_RETENTION_DAYS,
  NRD_PHANTOM_HOLD_MAX_DAYS,
  NRD_RETENTION_PURGE_SQL,
  NRD_RETENTION_LAST_RESULT_KEY,
  NRD_RETENTION_HOUR_UTC,
  type NrdRetentionResult,
} from "../src/lib/nrd-retention";
import { PHANTOM_MATCHER_NRD_CURSOR_KEY } from "../src/lib/phantom-matcher";
import { buildNrdRetentionDiag } from "../src/handlers/diagnostics";
import type { Env } from "../src/types";

const DAY = 86_400_000;
// Fixed clock: 2026-10-04 00:07:00 UTC.
const NOW = Date.UTC(2026, 9, 4, 0, 7, 0);
const ts = (daysAgo: number, extraMs = 0) => toSqliteUtc(NOW - daysAgo * DAY + extraMs);

function openNrd(): SqliteDb {
  const raw = openDerivedDb(["nrd_domains"]);
  for (const ddl of liveIndexDdl("nrd_domains").values()) raw.exec(ddl);
  return raw;
}

function seed(raw: SqliteDb, rows: Array<{ domain: string; created_at: string; brand_matched?: number }>): void {
  const ins = raw.prepare(
    "INSERT INTO nrd_domains (domain, registered_date, created_at, brand_matched) VALUES (?, '2026-01-01', ?, ?)",
  );
  for (const r of rows) ins.run(r.domain, r.created_at, r.brand_matched ?? 0);
}

function seedMany(raw: SqliteDb, n: number, createdAt: string, prefix = "bulk"): void {
  raw.exec("BEGIN");
  const ins = raw.prepare(
    "INSERT INTO nrd_domains (domain, registered_date, created_at) VALUES (?, '2026-01-01', ?)",
  );
  for (let i = 0; i < n; i++) ins.run(`${prefix}-${i}.example`, createdAt);
  raw.exec("COMMIT");
}

const domains = (raw: SqliteDb): string[] =>
  (raw.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>).map(
    (r) => r.domain,
  );
const count = (raw: SqliteDb): number =>
  (raw.prepare("SELECT COUNT(*) AS n FROM nrd_domains").all() as Array<{ n: number }>)[0]!.n;

function makeEnv(raw: SqliteDb, kvSeed: Record<string, string> = {}) {
  const log: StatementLogEntry[] = [];
  const binds: unknown[][] = [];
  const db = d1FromSqlite(raw, { log });
  // Wrap prepare→bind to record bind arity per statement.
  const wrapped = {
    ...db,
    prepare: (sql: string) => {
      const st = db.prepare(sql);
      return {
        ...st,
        bind: (...args: unknown[]) => {
          binds.push(args);
          return st.bind(...args);
        },
      };
    },
  } as unknown as D1Database;
  const kv = fakeKv(kvSeed);
  const env = { DB: wrapped, CACHE: kv } as unknown as Env;
  return { env, kv, log, binds };
}

const clock = () => NOW;

describe.skipIf(!hasSqlite())("purgeNrdDomains (nrd_domains tiered retention)", () => {
  it("retention is 30 days; the phantom hold clamps at 30 + 7", () => {
    expect(NRD_RETENTION_DAYS).toBe(30);
    expect(NRD_PHANTOM_HOLD_MAX_DAYS).toBe(37);
  });

  it("no phantom cursor → holds at the clamp floor: rows older than 37d deleted, 30–37d kept", async () => {
    const raw = openNrd();
    seed(raw, [
      { domain: "ancient.example", created_at: ts(400) },
      { domain: "old.example", created_at: ts(38) },
      { domain: "just-below-floor.example", created_at: ts(37, -1_000) },
      { domain: "at-floor.example", created_at: ts(37) },
      { domain: "held-35.example", created_at: ts(35) },
      { domain: "held-31.example", created_at: ts(31) },
      { domain: "recent.example", created_at: ts(2) },
    ]);
    const { env } = makeEnv(raw);
    const r = await purgeNrdDomains(env, { now: clock });
    expect(r.skipped).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.cursor).toBeNull();
    expect(r.phantom_hold_clamped).toBe(true);
    expect(r.held_by_matcher).toBe(true);
    expect(r.cutoff).toBe(ts(NRD_PHANTOM_HOLD_MAX_DAYS));
    expect(r.deleted).toBe(3);
    expect(domains(raw)).toEqual([
      "at-floor.example",
      "held-31.example",
      "held-35.example",
      "recent.example",
    ]);
  });

  it("a STALE phantom cursor (older than 37d) is clamped: unscanned rows below the floor are purged", async () => {
    const raw = openNrd();
    const cursor = ts(150);
    seed(raw, [
      { domain: "scanned.example", created_at: ts(200) },
      { domain: "unscanned-old.example", created_at: ts(120) },
      { domain: "unscanned-held.example", created_at: ts(35) },
      { domain: "recent.example", created_at: ts(5) },
    ]);
    const { env } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: cursor });
    const r = await purgeNrdDomains(env, { now: clock });
    expect(r.cursor).toBe(cursor);
    expect(r.phantom_hold_clamped).toBe(true);
    expect(r.held_by_matcher).toBe(true);
    expect(r.cutoff).toBe(ts(37));
    expect(r.deleted).toBe(2);
    expect(domains(raw)).toEqual(["recent.example", "unscanned-held.example"]);
  });

  it("brand_matched = 1 rows are never purged, at any age, with or without a cursor", async () => {
    for (const kvSeed of [{}, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(0) }]) {
      const raw = openNrd();
      seed(raw, [
        { domain: "matched-ancient.example", created_at: ts(400), brand_matched: 1 },
        { domain: "matched-old.example", created_at: ts(45), brand_matched: 1 },
        { domain: "unmatched-ancient.example", created_at: ts(400) },
        { domain: "unmatched-old.example", created_at: ts(45) },
        { domain: "unmatched-recent.example", created_at: ts(3) },
      ]);
      const { env } = makeEnv(raw, kvSeed);
      const r = await purgeNrdDomains(env, { now: clock, chunkSize: 1 });
      expect(r.error).toBeUndefined();
      expect(r.deleted).toBe(2);
      expect(domains(raw)).toEqual([
        "matched-ancient.example",
        "matched-old.example",
        "unmatched-recent.example",
      ]);
    }
  });

  it("matched rows do not stall the chunk loop (a full chunk of only-older matched rows still drains)", async () => {
    const raw = openNrd();
    raw.exec("BEGIN");
    const ins = raw.prepare(
      "INSERT INTO nrd_domains (domain, registered_date, created_at, brand_matched) VALUES (?, '2026-01-01', ?, 1)",
    );
    for (let i = 0; i < 15; i++) ins.run(`kept-${i}.example`, ts(200));
    raw.exec("COMMIT");
    seedMany(raw, 12, ts(100));
    const { env } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(0) });
    const r = await purgeNrdDomains(env, { now: clock, chunkSize: 5 });
    expect(r.deleted).toBe(12);
    expect(r.more_remaining).toBe(false);
    expect(count(raw)).toBe(15);
  });

  it("cursor newer than 30d → rows older than 30d deleted, newer kept", async () => {
    const raw = openNrd();
    seed(raw, [
      { domain: "old-1.example", created_at: ts(120) },
      { domain: "old-2.example", created_at: ts(31) },
      { domain: "edge-new.example", created_at: ts(NRD_RETENTION_DAYS, 1_000) },
      { domain: "recent.example", created_at: ts(10) },
      { domain: "today.example", created_at: ts(0) },
    ]);
    const { env } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(1) });
    const r = await purgeNrdDomains(env, { now: clock });
    expect(r.skipped).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.held_by_matcher).toBe(false);
    expect(r.phantom_hold_clamped).toBe(false);
    expect(r.age_cutoff).toBe(ts(NRD_RETENTION_DAYS));
    expect(r.cutoff).toBe(r.age_cutoff);
    expect(r.deleted).toBe(2);
    expect(r.more_remaining).toBe(false);
    expect(domains(raw)).toEqual(["edge-new.example", "recent.example", "today.example"]);
  });

  it("cursor between 30d and 37d old → only rows older than the cursor deleted, held_by_matcher", async () => {
    const raw = openNrd();
    const cursor = ts(34);
    seed(raw, [
      { domain: "scanned.example", created_at: ts(36) },
      { domain: "unscanned-old.example", created_at: ts(32) },
      { domain: "recent.example", created_at: ts(5) },
    ]);
    const { env } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: cursor });
    const r = await purgeNrdDomains(env, { now: clock });
    expect(r.held_by_matcher).toBe(true);
    expect(r.phantom_hold_clamped).toBe(false);
    expect(r.cursor).toBe(cursor);
    expect(r.cutoff).toBe(cursor);
    expect(r.deleted).toBe(1);
    expect(domains(raw)).toEqual(["recent.example", "unscanned-old.example"]);
  });

  it("a row exactly at the cursor is kept (strict <, matcher re-scans >=)", async () => {
    const raw = openNrd();
    const cursor = ts(33);
    seed(raw, [
      { domain: "before.example", created_at: ts(33, -1_000) },
      { domain: "at-cursor.example", created_at: cursor },
    ]);
    const { env } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: cursor });
    const r = await purgeNrdDomains(env, { now: clock });
    expect(r.deleted).toBe(1);
    expect(domains(raw)).toEqual(["at-cursor.example"]);
  });

  it("purges more than one chunk across multiple statements", async () => {
    const raw = openNrd();
    seedMany(raw, 25, ts(100));
    seed(raw, [{ domain: "keep.example", created_at: ts(1) }]);
    const { env, log } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(0) });
    const r = await purgeNrdDomains(env, { now: clock, chunkSize: 10 });
    expect(r.deleted).toBe(25);
    expect(r.statements).toBe(3); // 10 + 10 + 5
    expect(r.more_remaining).toBe(false);
    expect(log.filter((e) => /^DELETE/i.test(e.sql)).length).toBe(3);
    expect(domains(raw)).toEqual(["keep.example"]);
  });

  it("time cap → stops early with more_remaining=true; a later run finishes", async () => {
    const raw = openNrd();
    seedMany(raw, 30, ts(100));
    const { env, kv } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(0) });
    // Each clock read advances 6s; softCap 10s → stops after the 2nd chunk.
    let t = NOW;
    const ticking = () => {
      const v = t;
      t += 6_000;
      return v;
    };
    const r = await purgeNrdDomains(env, { now: ticking, chunkSize: 10, softCapMs: 10_000 });
    expect(r.more_remaining).toBe(true);
    expect(r.deleted).toBe(20);
    expect(count(raw)).toBe(10);
    const stamped = parseNrdRetentionLastResult(kv.store.get(NRD_RETENTION_LAST_RESULT_KEY) ?? null);
    expect(stamped?.more_remaining).toBe(true);

    const r2 = await purgeNrdDomains(env, { now: clock, chunkSize: 10 });
    expect(r2.deleted).toBe(10);
    expect(r2.more_remaining).toBe(false);
    expect(count(raw)).toBe(0);
  });

  it("KV cursor read throwing → nothing deleted, error recorded", async () => {
    const raw = openNrd();
    seed(raw, [{ domain: "old.example", created_at: ts(300) }]);
    const { env, log } = makeEnv(raw);
    const kv = fakeKv();
    (env as unknown as { CACHE: KVNamespace }).CACHE = {
      ...kv,
      get: async () => {
        throw new Error("kv down");
      },
      put: kv.put,
    } as unknown as KVNamespace;
    const r = await purgeNrdDomains(env, { now: clock });
    expect(r.skipped).toBe("cursor_read_failed");
    expect(r.error).toContain("kv down");
    expect(r.deleted).toBe(0);
    expect(count(raw)).toBe(1);
    expect(log.some((e) => /DELETE/i.test(e.sql))).toBe(false);
  });

  it("an unrecognised cursor format → nothing deleted", async () => {
    const raw = openNrd();
    seed(raw, [{ domain: "old.example", created_at: ts(300) }]);
    const { env } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: "2026-10-03T12:00:00.000Z" });
    const r = await purgeNrdDomains(env, { now: clock });
    expect(r.skipped).toBe("cursor_unrecognized");
    expect(count(raw)).toBe(1);
  });

  it("a D1 failure never throws — returns error + more_remaining", async () => {
    const raw = openDerivedDb([]); // no nrd_domains table → DELETE fails
    const { env } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(0) });
    const r = await purgeNrdDomains(env, { now: clock });
    expect(r.error).toMatch(/no such table/);
    expect(r.more_remaining).toBe(true);
    expect(r.deleted).toBe(0);
  });

  it("every statement binds ≤ 100 variables", async () => {
    const raw = openNrd();
    seedMany(raw, 25, ts(100));
    const { env, binds } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(0) });
    await purgeNrdDomains(env, { now: clock, chunkSize: 10 });
    expect(binds.length).toBeGreaterThan(0);
    for (const b of binds) expect(b.length).toBeLessThanOrEqual(100);
    const placeholders = (NRD_RETENTION_PURGE_SQL.match(/\?/g) ?? []).length;
    expect(placeholders).toBe(2);
  });

  it("writes the KV last-result stamp", async () => {
    const raw = openNrd();
    seed(raw, [{ domain: "old.example", created_at: ts(300) }]);
    const { env, kv } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(0) });
    await purgeNrdDomains(env, { now: clock });
    const last = parseNrdRetentionLastResult(kv.store.get(NRD_RETENTION_LAST_RESULT_KEY) ?? null);
    expect(last).not.toBeNull();
    expect(last!.deleted).toBe(1);
    expect(last!.ran_at).toBe(new Date(NOW).toISOString());
  });
});

describe.skipIf(!hasSqlite())("idx_nrd_domains_created (migration 0279)", () => {
  const plan = (raw: SqliteDb, sql: string, ...b: unknown[]): string =>
    (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...b) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(" | ");

  it("is defined by migrations and survives replay", () => {
    const ddl = liveIndexDdl("nrd_domains").get("idx_nrd_domains_created");
    expect(ddl).toBeDefined();
    expect(ddl!.replace(/\s+/g, " ")).toMatch(/ON nrd_domains\(created_at\)/);
  });

  it("the purge subquery seeks idx_nrd_domains_created (no scan, no temp sort)", () => {
    const raw = openNrd();
    seedMany(raw, 50, ts(100));
    seed(raw, [{ domain: "matched.example", created_at: ts(100), brand_matched: 1 }]);
    raw.exec("ANALYZE");
    // Pinned shape: created_at range + brand_matched residual (never purge
    // matched rows), 2 binds.
    expect(NRD_RETENTION_PURGE_SQL).toBe(
      "DELETE FROM nrd_domains WHERE rowid IN (SELECT rowid FROM nrd_domains WHERE created_at < ? AND brand_matched = 0 ORDER BY created_at LIMIT ?)",
    );
    const sub = /\((SELECT rowid FROM nrd_domains[^)]*)\)/.exec(NRD_RETENTION_PURGE_SQL)![1]!;
    const p = plan(raw, sub, ts(30), 5000);
    expect(p).toContain("idx_nrd_domains_created (created_at<?)");
    expect(p).not.toMatch(/TEMP B-TREE/);
    expect(p).not.toMatch(/SCAN nrd_domains(?! USING)/);
    const full = plan(raw, NRD_RETENTION_PURGE_SQL, ts(30), 5000);
    expect(full).toContain("idx_nrd_domains_created");
  });
});

describe("shouldRunNrdRetention (Navigator gate)", () => {
  const at = (iso: string) => new Date(iso);
  const last = (over: Partial<NrdRetentionResult>): NrdRetentionResult => ({
    ran_at: "2026-10-04T00:02:00.000Z",
    deleted: 0,
    cutoff: null,
    age_cutoff: "2026-07-06 00:02:00",
    cursor: null,
    held_by_matcher: false,
    more_remaining: false,
    statements: 0,
    duration_ms: 0,
    ...over,
  });

  it("opens only at UTC hour 0, at any minute", () => {
    expect(NRD_RETENTION_HOUR_UTC).toBe(0);
    for (const m of ["00", "05", "07", "30", "55"]) {
      expect(shouldRunNrdRetention(at(`2026-10-04T00:${m}:00Z`), null)).toBe(true);
    }
    for (let h = 1; h < 24; h++) {
      const hh = String(h).padStart(2, "0");
      expect(shouldRunNrdRetention(at(`2026-10-04T${hh}:00:00Z`), null)).toBe(false);
      expect(shouldRunNrdRetention(at(`2026-10-04T${hh}:35:00Z`), null)).toBe(false);
    }
  });

  it("runs once per UTC day; continues when more_remaining or errored", () => {
    const tick = at("2026-10-04T00:10:00Z");
    expect(shouldRunNrdRetention(tick, last({}))).toBe(false);
    expect(shouldRunNrdRetention(tick, last({ skipped: "no_cursor" }))).toBe(false);
    expect(shouldRunNrdRetention(tick, last({ more_remaining: true }))).toBe(true);
    expect(shouldRunNrdRetention(tick, last({ error: "boom" }))).toBe(true);
    // Yesterday's run → today opens again.
    expect(shouldRunNrdRetention(tick, last({ ran_at: "2026-10-03T00:02:00.000Z" }))).toBe(true);
  });

  it("navigator dispatches it behind an hour-only gate (no minute check)", () => {
    const src = readFileSync(resolve(__dirname, "..", "src", "cron", "navigator.ts"), "utf8");
    const start = src.indexOf("── 2d. nrd_domains retention");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("} catch (err) {\n    status = 'failed'", start));
    expect(block).toContain("scheduledTime.getUTCHours() === 0");
    expect(block).toContain("shouldRunNrdRetention(scheduledTime, last)");
    expect(block).toContain("purgeNrdDomains(env, { softCapMs })");
    expect(block).toContain("NAVIGATOR_SOFT_CAP_MS - (Date.now() - start)");
    expect(block).not.toMatch(/getUTCMinutes|getMinutes/);
  });
});

describe("buildNrdRetentionDiag (KV-only diagnostics block)", () => {
  it("reports has_run=false with no stamp, and never touches D1", async () => {
    const env = {
      CACHE: fakeKv(),
      DB: new Proxy({}, { get: () => { throw new Error("D1 must not be read"); } }),
    } as unknown as Env;
    const d = await buildNrdRetentionDiag(env);
    expect(d.has_run).toBe(false);
    expect(d.held_by_matcher).toBeNull();
    expect(d.phantom_hold_clamped).toBeNull();
  });

  it("surfaces the last-result stamp fields", async () => {
    const stamp: NrdRetentionResult = {
      ran_at: "2026-10-04T00:02:00.000Z",
      deleted: 1234,
      cutoff: "2026-06-01 00:00:00",
      age_cutoff: "2026-07-06 00:02:00",
      cursor: "2026-06-01 00:00:00",
      held_by_matcher: true,
      phantom_hold_clamped: false,
      more_remaining: false,
      statements: 1,
      duration_ms: 42,
    };
    const env = {
      CACHE: fakeKv({ [NRD_RETENTION_LAST_RESULT_KEY]: JSON.stringify(stamp) }),
      DB: new Proxy({}, { get: () => { throw new Error("D1 must not be read"); } }),
    } as unknown as Env;
    const d = await buildNrdRetentionDiag(env);
    expect(d).toMatchObject({
      has_run: true,
      last_run_at: stamp.ran_at,
      deleted: 1234,
      cutoff: stamp.cutoff,
      cursor: stamp.cursor,
      held_by_matcher: true,
      phantom_hold_clamped: false,
      more_remaining: false,
      skipped: null,
      error: null,
    });
  });
});

// ── Phantom matcher nrd cursor = "scanned up to" watermark ──────────────
// The purge's no-unscanned-rows guarantee depends on the matcher's nrd
// cursor meaning "every row with created_at < cursor has been scanned".
// An untruncated incremental run must therefore advance it to
// MAX(nrd_domains.created_at) even with zero matches; a truncated run keeps
// the matched-row rule.
describe.skipIf(!hasSqlite())("phantom matcher nrd cursor (gates the retention purge)", () => {
  function openMatcherDb(): SqliteDb {
    const raw = openDerivedDb(["nrd_domains", "phantom_domains", "brands"]);
    for (const ddl of liveIndexDdl("nrd_domains").values()) raw.exec(ddl);
    // tier='tracked' → createAlert returns null (NX2 gate): no alerts table needed.
    raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b1', 'Acme', 'acme.example', 'tracked')").run();
    return raw;
  }
  const addPhantom = (raw: SqliteDb, id: string, domain: string) =>
    raw
      .prepare(
        "INSERT INTO phantom_domains (id, brand_id, domain, source_model, status) VALUES (?, 'b1', ?, 'test', 'predicted')",
      )
      .run(id, domain);

  async function runNrd(raw: SqliteDb, kv: ReturnType<typeof fakeKv>, limit = 500) {
    const { runPhantomMatch } = await import("../src/lib/phantom-matcher");
    const db = d1FromSqlite(raw);
    const env = { DB: db, CACHE: kv } as unknown as Env;
    return runPhantomMatch(env, db, { source: "nrd", limit });
  }

  it("(a) no matches: an incremental run advances the cursor to MAX(created_at)", async () => {
    const raw = openMatcherDb();
    seed(raw, [
      { domain: "a.example", created_at: ts(5) },
      { domain: "b.example", created_at: ts(2) },
      { domain: "c.example", created_at: ts(1) },
    ]);
    addPhantom(raw, "p-none", "never-registered.example");
    const kv = fakeKv({ [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(10) });
    const r = await runNrd(raw, kv);
    expect(r.by_source.nrd.matched).toBe(0);
    expect(r.by_source.nrd.cursor_after).toBe(ts(1));
    expect(kv.store.get(PHANTOM_MATCHER_NRD_CURSOR_KEY)).toBe(ts(1));
  });

  it("(a') first-ever incremental run with zero matches sets a cursor", async () => {
    const raw = openMatcherDb();
    seed(raw, [{ domain: "a.example", created_at: ts(3) }]);
    const kv = fakeKv();
    await runNrd(raw, kv);
    expect(kv.store.get(PHANTOM_MATCHER_NRD_CURSOR_KEY)).toBe(ts(3));
  });

  it("full=1 neither reads nor advances the cursor", async () => {
    const raw = openMatcherDb();
    seed(raw, [{ domain: "a.example", created_at: ts(3) }]);
    const kv = fakeKv({ [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(10) });
    const { runPhantomMatch } = await import("../src/lib/phantom-matcher");
    const db = d1FromSqlite(raw);
    await runPhantomMatch({ DB: db, CACHE: kv } as unknown as Env, db, { source: "nrd", full: true });
    expect(kv.store.get(PHANTOM_MATCHER_NRD_CURSOR_KEY)).toBe(ts(10));
  });

  it("(b) truncated run (join rows >= limit) keeps the matched-row rule", async () => {
    const raw = openMatcherDb();
    seed(raw, [
      { domain: "hit1.example", created_at: ts(6) },
      { domain: "hit2.example", created_at: ts(5) },
      { domain: "hit3.example", created_at: ts(4) },
      { domain: "newest.example", created_at: ts(1) },
    ]);
    addPhantom(raw, "p1", "hit1.example");
    addPhantom(raw, "p2", "hit2.example");
    addPhantom(raw, "p3", "hit3.example");
    const kv = fakeKv({ [PHANTOM_MATCHER_NRD_CURSOR_KEY]: ts(10) });
    const r = await runNrd(raw, kv, 2);
    expect(r.by_source.nrd.scanned).toBe(2);
    // Newest MATCHED row of the truncated page — not MAX(created_at) = ts(1).
    expect(kv.store.get(PHANTOM_MATCHER_NRD_CURSOR_KEY)).toBe(ts(5));
  });

  it("(c) a row inserted at the advanced cursor's created_at is re-scanned (>=) and not purged (<)", async () => {
    const raw = openMatcherDb();
    // Both rows sit inside the 37-day clamp window, so the cursor (not the
    // clamp floor) is the binding hold.
    seed(raw, [
      { domain: "old.example", created_at: ts(36) },
      { domain: "boundary.example", created_at: ts(34) },
    ]);
    const kv = fakeKv();
    await runNrd(raw, kv);
    const cursor = kv.store.get(PHANTOM_MATCHER_NRD_CURSOR_KEY)!;
    expect(cursor).toBe(ts(34));

    // Late row with the SAME created_at second, matching a predicted phantom.
    seed(raw, [{ domain: "late.example", created_at: cursor }]);
    addPhantom(raw, "p-late", "late.example");

    const { env } = makeEnv(raw, { [PHANTOM_MATCHER_NRD_CURSOR_KEY]: cursor });
    const purge = await purgeNrdDomains(env, { now: clock });
    expect(purge.held_by_matcher).toBe(true);
    expect(purge.phantom_hold_clamped).toBe(false);
    expect(purge.deleted).toBe(1); // only old.example
    expect(domains(raw)).toEqual(["boundary.example", "late.example"]);

    const r = await runNrd(raw, kv);
    expect(r.by_source.nrd.matched).toBe(1);
    const status = (raw.prepare("SELECT status FROM phantom_domains WHERE id = 'p-late'").all() as Array<{ status: string }>)[0]!.status;
    expect(status).toBe("registered");
  });
});
