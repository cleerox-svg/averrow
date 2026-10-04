// Pin: GET /api/v1/operations caching (D1 read-spend PR, fix 7).
//
//   1. The response KV TTL outlives Navigator's warm period for every warmed
//      operations key, so a warm refreshes a live key instead of always
//      recomputing an expired one (the old 300s TTL < the 10/15-min warm
//      cadence made every warm a miss).
//   2. The response is byte-identical to the pre-change single query (with
//      its correlated per-cluster json_group_array 14-day subquery), now that
//      the history is a separate cached query and the total a cachedCount.
//   3. A second request is served from KV with zero D1 statements.

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
import {
  handleListOperations,
  OPERATIONS_LIST_TTL_S,
  OPERATIONS_HISTORY_TTL_S,
  OPERATIONS_TOTAL_TTL_S,
} from "../src/handlers/operations";
import { NAVIGATOR_WARM_TARGETS } from "../src/cron/navigator";
import type { Env } from "../src/types";

// Navigator phase cadences (cron/navigator.ts runNavigatorImpl header:
// A every 10 min, A2/B every 15 min, C every 30 min).
const PHASE_PERIOD_S: Record<string, number> = { A: 600, A2: 900, B: 900, C: 1800 };

/** The pre-change list query, verbatim, as the equivalence oracle. */
const LEGACY_SQL = (where: string) => `
  SELECT ic.id, ic.cluster_name, ic.asns, ic.countries, ic.threat_count,
         ic.status, ic.confidence_score, ic.agent_notes,
         ic.first_detected, ic.last_seen, ic.last_updated,
         ic.actor_id, ta.name AS actor_name,
         (
           SELECT json_group_array(daily_count)
           FROM (
             SELECT COUNT(*) as daily_count
             FROM threats t2
             WHERE t2.cluster_id = ic.id
               AND t2.created_at >= datetime('now', '-14 days')
             GROUP BY date(t2.created_at)
             ORDER BY date(t2.created_at) ASC
           )
         ) as threat_history_json
  FROM infrastructure_clusters ic
  LEFT JOIN threat_actors ta ON ta.id = ic.actor_id
  ${where}
  ORDER BY
    CASE ic.status
      WHEN 'accelerating' THEN 0
      WHEN 'pivot' THEN 1
      WHEN 'active' THEN 2
      ELSE 3
    END,
    ic.threat_count DESC
  LIMIT ? OFFSET ?`;

function seed(): SqliteDb {
  const raw = openDerivedDb(["infrastructure_clusters", "threat_actors", "threats"]);
  // The handler selects ic.last_updated, which prod's pre-migration table
  // carries but no migration in this repo adds (0136 is CREATE IF NOT
  // EXISTS over an existing table). Added here so the query runs.
  raw.exec("ALTER TABLE infrastructure_clusters ADD COLUMN last_updated TEXT");
  raw.prepare("INSERT INTO threat_actors (id, name) VALUES ('ta1', 'Actor One')").run();
  const ic = raw.prepare(
    `INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status, confidence_score, actor_id, last_updated)
     VALUES (?, ?, ?, ?, 70, ?, '2026-10-01 00:00:00')`,
  );
  ic.run("c-acc", "Accel", 5, "accelerating", "ta1");
  ic.run("c-act-big", "Active big", 50, "active", null);
  ic.run("c-act-small", "Active small", 3, "active", null);
  ic.run("c-empty", "No recent threats", 9, "active", null);
  ic.run("c-dorm", "Dormant", 99, "dormant", null);
  const t = raw.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, cluster_id, created_at)
     VALUES (?, 'test', 'phishing', 'x.example', ?, ?)`,
  );
  let n = 0;
  const add = (cluster: string, hoursAgo: number, count: number) => {
    for (let i = 0; i < count; i++) t.run(`t${n++}`, cluster, sqliteTimestampHoursAgo(hoursAgo));
  };
  add("c-act-big", 2, 3);
  add("c-act-big", 30, 1);
  add("c-act-big", 24 * 5, 4);
  add("c-act-big", 24 * 20, 7); // outside the 14-day window
  add("c-acc", 24 * 13, 2);
  add("c-acc", 1, 1);
  add("c-act-small", 24 * 3, 1);
  add("c-empty", 24 * 30, 5); // only old rows → []
  add("c-dorm", 5, 2);
  return raw;
}

function legacyResponse(raw: SqliteDb, status: string | null, limit: number, offset: number) {
  const where = status ? "WHERE ic.status = ?" : "";
  const binds = status ? [status, limit, offset] : [limit, offset];
  const rows = raw.prepare(LEGACY_SQL(where)).all(...binds) as Array<Record<string, unknown>>;
  const total = raw.prepare(`SELECT COUNT(*) AS n FROM infrastructure_clusters ic ${where}`)
    .all(...(status ? [status] : [])) as Array<{ n: number }>;
  const data = rows.map((row) => ({
    ...row,
    threat_history: row.threat_history_json ? JSON.parse(row.threat_history_json as string) : undefined,
    threat_history_json: undefined,
  }));
  return JSON.parse(JSON.stringify({ success: true, data, total: total[0]?.n ?? 0 }));
}

function makeEnv(raw: SqliteDb, log: StatementLogEntry[]) {
  const kv = fakeKv();
  const puts: Array<{ key: string; ttl?: number }> = [];
  const origPut = kv.put.bind(kv);
  kv.put = (async (key: string, value: string, opts?: { expirationTtl?: number }) => {
    puts.push({ key, ttl: opts?.expirationTtl });
    return origPut(key, value);
  }) as typeof kv.put;
  const env = { DB: d1FromSqlite(raw, { log }), CACHE: kv } as unknown as Env;
  return { env, kv, puts };
}

describe("operations list cache TTLs", () => {
  it("response TTL exceeds the warm period of every warmed operations key", () => {
    const warms = NAVIGATOR_WARM_TARGETS.filter((w) => w.path.startsWith("/api/v1/operations?"));
    expect(warms.length).toBeGreaterThan(0);
    for (const w of warms) {
      expect(OPERATIONS_LIST_TTL_S, w.path).toBeGreaterThan(PHASE_PERIOD_S[w.phase]!);
    }
    expect(OPERATIONS_LIST_TTL_S).toBe(1800);
    expect(OPERATIONS_HISTORY_TTL_S).toBe(21_600);
    expect(OPERATIONS_TOTAL_TTL_S).toBe(3600);
  });
});

describe.skipIf(!hasSqlite())("handleListOperations — response equivalence + cache", () => {
  const cases: Array<[string, string]> = [
    ["side panel warm", "/api/v1/operations?limit=4&offset=0&status=active"],
    ["campaigns warm", "/api/v1/operations?limit=12&offset=0"],
    ["paged", "/api/v1/operations?limit=2&offset=1"],
    ["no matches", "/api/v1/operations?status=pivot"],
  ];
  for (const [name, path] of cases) {
    it(`${name}: identical to the legacy single-query response`, async () => {
      const raw = seed();
      const log: StatementLogEntry[] = [];
      const { env, puts } = makeEnv(raw, log);
      const res = await handleListOperations(new Request(`https://x${path}`), env);
      expect(res.status).toBe(200);
      const body = await res.json();
      const u = new URL(`https://x${path}`);
      const expected = legacyResponse(
        raw,
        u.searchParams.get("status"),
        Math.min(100, parseInt(u.searchParams.get("limit") ?? "50", 10)),
        parseInt(u.searchParams.get("offset") ?? "0", 10),
      );
      expect(body).toEqual(expected);
      expect(log.filter((l) => l.error)).toEqual([]);
      const listPut = puts.find((p) => p.key.startsWith("operations_list:"));
      expect(listPut?.ttl).toBe(OPERATIONS_LIST_TTL_S);
    });
  }

  it("a sparkline series is oldest-day-first with empty-window clusters as []", async () => {
    const raw = seed();
    const { env } = makeEnv(raw, []);
    const res = await handleListOperations(new Request("https://x/api/v1/operations?limit=12&offset=0"), env);
    const body = (await res.json()) as { data: Array<{ id: string; threat_history: number[] }> };
    const byId = Object.fromEntries(body.data.map((d) => [d.id, d.threat_history]));
    expect(byId["c-empty"]).toEqual([]);
    expect(byId["c-acc"]).toEqual([2, 1]);
  });

  it("second request is a KV hit with zero D1 statements", async () => {
    const raw = seed();
    const log: StatementLogEntry[] = [];
    const { env } = makeEnv(raw, log);
    const req = () => new Request("https://x/api/v1/operations?limit=4&offset=0&status=active");
    const first = await (await handleListOperations(req(), env)).json();
    const n = log.length;
    expect(n).toBeGreaterThan(0);
    const second = await (await handleListOperations(req(), env)).json();
    expect(second).toEqual(first);
    expect(log.length).toBe(n);
  });

  it("history + total survive a response-key expiry (served from their own caches)", async () => {
    const raw = seed();
    const log: StatementLogEntry[] = [];
    const { env, kv } = makeEnv(raw, log);
    const path = "https://x/api/v1/operations?limit=12&offset=0";
    await handleListOperations(new Request(path), env);
    for (const k of [...kv.store.keys()]) if (k.startsWith("operations_list:")) kv.store.delete(k);
    const before = log.length;
    await handleListOperations(new Request(path), env);
    const sqls = log.slice(before).map((l) => l.sql);
    expect(sqls).toHaveLength(1); // only the cheap cluster page query
    expect(sqls[0]).toMatch(/FROM infrastructure_clusters ic/);
    expect(sqls[0]).not.toMatch(/FROM threats/);
  });

  it("unknown status → empty result with no D1 statement and no KV key", async () => {
    const raw = seed();
    const log: StatementLogEntry[] = [];
    const { env, kv } = makeEnv(raw, log);
    const res = await handleListOperations(new Request("https://x/api/v1/operations?status=bogus&limit=12"), env);
    expect(await res.json()).toEqual({ success: true, data: [], total: 0 });
    expect(log).toEqual([]);
    expect(kv.store.size).toBe(0);
    // Same body the pre-whitelist filter produced for a value no cluster has.
    expect(legacyResponse(raw, "bogus", 12, 0)).toEqual({ success: true, data: [], total: 0 });
  });

  it("empty status is 'all' (unchanged)", async () => {
    const raw = seed();
    const { env, kv } = makeEnv(raw, []);
    await handleListOperations(new Request("https://x/api/v1/operations?status=&limit=12&offset=0"), env);
    expect(kv.store.has("operations_list:all:12:0")).toBe(true);
  });

  it("limit/offset are clamped (NaN → default); history IN() never exceeds 100 ids", async () => {
    const raw = seed();
    const ic = raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status) VALUES (?, 'bulk', 1, 'dormant')`,
    );
    for (let i = 0; i < 120; i++) ic.run(`bulk-${String(i).padStart(3, "0")}`);
    const cases: Array<[string, number, string]> = [
      ["limit=-1", 1, "operations_list:all:1:0"],
      ["limit=0", 1, "operations_list:all:1:0"],
      ["limit=abc", 50, "operations_list:all:50:0"],
      ["limit=500", 100, "operations_list:all:100:0"],
      ["limit=5&offset=-3", 5, "operations_list:all:5:0"],
      ["limit=5&offset=xyz", 5, "operations_list:all:5:0"],
    ];
    for (const [qs, rows, key] of cases) {
      const log: StatementLogEntry[] = [];
      const { env, kv } = makeEnv(raw, log);
      const body = (await (await handleListOperations(new Request(`https://x/api/v1/operations?${qs}`), env)).json()) as {
        data: unknown[];
      };
      expect(body.data, qs).toHaveLength(rows);
      expect(kv.store.has(key), qs).toBe(true);
      const hist = log.find((l) => /cluster_id IN \(/.test(l.sql));
      const placeholders = (hist?.sql.match(/\?/g) ?? []).length;
      expect(placeholders, qs).toBeLessThanOrEqual(100);
      expect(log.filter((l) => l.error), qs).toEqual([]);
    }
  });
});
