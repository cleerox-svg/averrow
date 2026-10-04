// Pin: /api/observatory/stats caches its COUNT(DISTINCT target_brand_id)
// brand-cube read in its own 1h cachedValue (D1 read-spend PR, fix 8).
//
// Before, every stats miss (per period × source_feed, 15-min response TTL)
// re-ran the DISTINCT over the whole brand-cube window. Now a stats miss
// recomputes the four cheap tiles but serves brands_monitored from
// `cv:observatory.brands_distinct:<hours>h:<source_feed segment>`.

import { describe, it, expect } from "vitest";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  fakeKv,
  sqliteTimestampHoursAgo,
  type SqliteDb,
  type StatementLogEntry,
} from "./sqlite-d1-harness";
import { handleObservatoryStats, OBSERVATORY_BRANDS_DISTINCT_TTL_S } from "../src/handlers/observatory";
import type { Env } from "../src/types";

const DISTINCT_RE = /COUNT\(DISTINCT target_brand_id\)/;

function hourBucket(hoursAgo: number): string {
  return sqliteTimestampHoursAgo(hoursAgo).slice(0, 13) + ":00:00";
}

function seed(): SqliteDb {
  const raw = openDerivedDb(["threat_cube_geo", "threat_cube_status", "threat_cube_brand", "campaigns"]);
  const ins = raw.prepare(
    `INSERT INTO threat_cube_brand (hour_bucket, target_brand_id, threat_type, severity, source_feed, threat_count)
     VALUES (?, ?, 'phishing', 'high', ?, 1)`,
  );
  ins.run(hourBucket(2), "b1", "phishtank");
  ins.run(hourBucket(3), "b2", "spam_trap");
  ins.run(hourBucket(24 * 3), "b3", "phishtank"); // in 7d, not in 24h
  return raw;
}

function makeEnv(raw: SqliteDb, log: StatementLogEntry[]) {
  const db = d1FromSqlite(raw, { log });
  const withSession = () => ({ prepare: db.prepare.bind(db), getBookmark: () => null });
  const kv = fakeKv();
  const env = { DB: { ...db, prepare: db.prepare, batch: db.batch, withSession }, CACHE: kv } as unknown as Env;
  return { env, kv };
}

async function stats(env: Env, qs: string): Promise<{ brands_monitored: number }> {
  const res = await handleObservatoryStats(new Request(`https://x/api/observatory/stats?${qs}`), env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { brands_monitored: number } }).data;
}

function dropResponseKeys(kv: ReturnType<typeof fakeKv>): void {
  for (const k of [...kv.store.keys()]) if (k.startsWith("observatory_stats:")) kv.store.delete(k);
}

describe.skipIf(!hasSqlite())("observatory stats — distinct brands cachedValue", () => {
  it("TTL is 1h", () => {
    expect(OBSERVATORY_BRANDS_DISTINCT_TTL_S).toBe(3600);
  });

  it("a stats miss reuses the cached distinct count (no DISTINCT re-scan)", async () => {
    const raw = seed();
    const log: StatementLogEntry[] = [];
    const { env, kv } = makeEnv(raw, log);

    const first = await stats(env, "period=7d");
    expect(first.brands_monitored).toBe(3);
    expect(log.filter((l) => DISTINCT_RE.test(l.sql))).toHaveLength(1);
    expect(kv.store.has("cv:observatory.brands_distinct:168h:all")).toBe(true);

    dropResponseKeys(kv);
    const before = log.length;
    const second = await stats(env, "period=7d");
    expect(second.brands_monitored).toBe(3);
    const after = log.slice(before);
    expect(after.length).toBeGreaterThan(0); // the other tiles did recompute
    expect(after.filter((l) => DISTINCT_RE.test(l.sql))).toHaveLength(0);
  });

  it("keys by window and by source_feed (the query filters on it)", async () => {
    const raw = seed();
    const log: StatementLogEntry[] = [];
    const { env, kv } = makeEnv(raw, log);

    expect((await stats(env, "period=24h")).brands_monitored).toBe(2);
    expect((await stats(env, "period=7d&source_feed=spam_trap")).brands_monitored).toBe(1);
    expect((await stats(env, "period=7d&source_feed=feeds")).brands_monitored).toBe(2);
    // Empty / absent / `all` source_feed share one segment (sourceFeedCacheSegment).
    expect((await stats(env, "period=7d&source_feed=")).brands_monitored).toBe(3);
    dropResponseKeys(kv);
    const before = log.length;
    expect((await stats(env, "period=7d")).brands_monitored).toBe(3);
    expect(log.slice(before).filter((l) => DISTINCT_RE.test(l.sql))).toHaveLength(0);

    expect([...kv.store.keys()].filter((k) => k.startsWith("cv:observatory.brands_distinct:")).sort()).toEqual([
      "cv:observatory.brands_distinct:168h:all",
      "cv:observatory.brands_distinct:168h:feeds",
      "cv:observatory.brands_distinct:168h:spam_trap",
      "cv:observatory.brands_distinct:24h:all",
    ]);
    expect(log.filter((l) => l.error)).toEqual([]);
  });
});
