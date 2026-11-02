/**
 * Strategist D1 read-spend (migration 0315), measured in prod 2026-11-02
 * (threats ≈1.51M, ~1.19M active with campaign_id IS NULL):
 *
 *   Strategy-1 IP GROUP BY ........... idx_threats_campaign, 2,018,626 rows
 *   Strategy-2 registrar GROUP BY .... idx_threats_campaign, 1,195,570
 *   per-registrar UPDATE (≤10/run) ... idx_threats_campaign, ~1.2M each
 *   NX4 registrar brand COUNT (≤10) .. idx_threats_brand_created, ~315K each
 *   campaign brand/provider refresh .. every campaign, ~0.7M
 *   fallback COUNT(DISTINCT …) ....... idx_threats_campaign, ~1.19M each
 *
 * Plans are taken on openMigratedDb() (every migration, tables + indexes) in
 * three planner-stat modes: none, ANALYZE over seeded data, and injected
 * prod-shaped sqlite_stat1 (which reproduces the idx_threats_campaign
 * mis-pick — the control). The baseline is the same schema without 0315 and
 * with the INDEXED BY hints stripped (= the pre-0315 SQL).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, sqlContaining, sqliteTimestampHoursAgo,
  type SqliteDb,
} from "./sqlite-d1-harness";
import { stripIndexedBy } from "../src/lib/indexed-by-fallback";
import {
  strategistAgent, refreshCampaignCounts, fullCountRefreshKey, shouldRunFullCountRefresh,
} from "../src/agents/strategist";

const ROOT = resolve(__dirname, "..");
const MIGRATION = "0315_threats_strategist_no_campaign_indexes.sql";
const SRC = readFileSync(resolve(ROOT, "src/agents/strategist.ts"), "utf8");

const IP_IDX = "idx_threats_no_campaign_ip";
const REG_IDX = "idx_threats_no_campaign_registrar";

// The statements exactly as the agent issues them.
const S1 = sqlContaining(SRC, ["GROUP BY ip_address", "HAVING COUNT(*) >= 3"]);
const S2 = sqlContaining(SRC, ["GROUP BY registrar", "HAVING COUNT(*) >= 5"]);
const REG_UPDATE = sqlContaining(SRC, ["UPDATE threats", "WHERE registrar = ?"]);
const IP_UPDATE = sqlContaining(SRC, ["UPDATE threats SET campaign_id = ?", "WHERE ip_address = ?"]);
const FB_IP = sqlContaining(SRC, ["COUNT(DISTINCT ip_address)"]);
const FB_REG = sqlContaining(SRC, ["COUNT(DISTINCT registrar)"]);
// Brands context read — its template has a ${regPlaceholders} interpolation,
// so it is reconstructed here and pinned to the source by a marker check.
const REG_BRANDS_MARKER = "SELECT DISTINCT t.registrar, t.target_brand_id, b.name FROM threats t";
const regBrandsSql = (n: number): string =>
  `${REG_BRANDS_MARKER}
           LEFT JOIN brands b ON b.id = t.target_brand_id
           WHERE t.registrar IN (${Array(n).fill("?").join(",")}) AND t.status = 'active'
             AND t.target_brand_id IS NOT NULL
             AND t.created_at >= datetime('now', '-7 days')`;
const OLD_REG_BRANDS = (n: number): string =>
  `SELECT DISTINCT t.registrar, b.name FROM threats t
     JOIN brands b ON b.id = t.target_brand_id
    WHERE t.registrar IN (${Array(n).fill("?").join(",")}) AND t.status = 'active'
      AND t.created_at >= datetime('now', '-7 days')`;
const OLD_NX4 = `SELECT COUNT(DISTINCT target_brand_id) AS n FROM threats
  WHERE registrar = ? AND target_brand_id IS NOT NULL AND status = 'active'
    AND created_at >= datetime('now', '-7 days')`;

function plan(db: SqliteDb, sql: string): string {
  const n = (sql.match(/\?/g) ?? []).length;
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill("x")) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");
}

// ─── seeding ──────────────────────────────────────────────────────────

const REGISTRARS = ["Gname", "NICENIC INTERNATIONAL GROUP CO., LIMITED", "Namecheap", "Tucows", "Rare"];

/**
 * A prod-proportioned threats table: ~20% already in campaigns, ~15%
 * inactive, most rows older than 7 days; registrar on ~60%, IP on ~70%,
 * some dangling target_brand_ids and brands sharing a name.
 */
function seed(db: SqliteDb, n = 6000): void {
  db.exec("BEGIN");
  const b = db.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)");
  for (let i = 0; i < 40; i++) b.run(`b${i}`, `Brand ${i % 30}`, `b${i}.com`); // b30..b39 share names
  const c = db.prepare("INSERT INTO campaigns (id, name, threat_count, status) VALUES (?, ?, 0, 'active')");
  for (let i = 0; i < 30; i++) c.run(`camp${i}`, `Camp ${i}`);
  const t = db.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, ip_address, registrar, severity, status,
       target_brand_id, hosting_provider_id, campaign_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'medium', ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i++) {
    const hoursAgo = i % 10 < 3 ? i % 160 : 200 + (i % 4000); // 30% inside the 7-day window
    t.run(
      `t${i}`,
      ["feed_a", "feed_b", "feed_c"][i % 3]!,
      ["phishing", "malware_distribution", "typosquatting"][i % 3]!,
      i % 7 ? `d${i % 900}.example` : null,
      i % 10 < 7 ? `198.51.${i % 13}.${i % 37}` : null,
      i % 5 < 3 ? REGISTRARS[Math.floor(i / 5) % REGISTRARS.length]! : null,
      i % 7 === 0 ? "remediated" : "active",
      i % 4 === 0 ? null : i % 11 === 0 ? `dangling${i % 3}` : `b${i % 40}`,
      i % 3 ? `hp${i % 9}` : null,
      i % 5 === 0 ? `camp${i % 30}` : null,
      sqliteTimestampHoursAgo(hoursAgo),
    );
  }
  db.exec("COMMIT");
}

/** Prod-shaped planner stats (see header). */
function injectProdStats(db: SqliteDb): void {
  db.exec("ANALYZE");
  db.exec("DELETE FROM sqlite_stat1");
  const ins = db.prepare("INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES ('threats', ?, ?)");
  const stats: Array<[string, string]> = [
    ["idx_threats_campaign", "1510000 242"],
    ["idx_threats_status_created", "1510000 300000 2"],
    ["idx_threats_status", "1510000 300000"],
    ["idx_threats_brand_created", "1510000 150 2"],
    ["idx_threats_brand_status", "1510000 150 100"],
    ["idx_threats_created_brand", "1510000 2 1"],
    ["idx_threats_ip_source_feed", "1510000 3 1"],
    [IP_IDX, "900000 3 2 1 1 1"],
    [REG_IDX, "600000 2 1 1 1"],
  ];
  for (const [i, s] of stats) ins.run(i, s);
  ins.run(null, "1510000");
  db.exec("ANALYZE sqlite_schema");
}

const MODES: Array<[string, (db: SqliteDb) => void]> = [
  ["no stats", () => {}],
  ["ANALYZE over seeded rows", (db) => { seed(db); db.exec("ANALYZE"); }],
  ["prod-shaped sqlite_stat1", injectProdStats],
];

// ─── migration ────────────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("migration 0315", () => {
  it("is the only 0315 and is additive (CREATE INDEX IF NOT EXISTS only)", () => {
    expect(readdirSync(resolve(ROOT, "migrations")).filter((f) => f.startsWith("0315_"))).toEqual([MIGRATION]);
    const sql = readFileSync(resolve(ROOT, "migrations", MIGRATION), "utf8")
      .split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect(sql).not.toMatch(/\b(DROP|ALTER|UPDATE|DELETE|INSERT)\b/i);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
  });

  it("each pinned query's WHERE literally contains its index's partial WHERE terms", () => {
    const db = openMigratedDb();
    const where = (idx: string): string =>
      (db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").all(idx) as Array<{ sql: string }>)[0]!
        .sql.split(/\bWHERE\b/)[1]!.trim();
    for (const [idx, sqls] of [[IP_IDX, [S1, FB_IP]], [REG_IDX, [S2, REG_UPDATE, FB_REG]]] as const) {
      for (const term of where(idx).split(/\s+AND\s+/)) {
        for (const q of sqls) expect(q.replace(/\s+/g, " ")).toContain(term.trim());
      }
    }
  });

  it("the reconstructed brands context read matches the source template", () => {
    const ws = (s: string) => s.replace(/\s+/g, " ");
    expect(ws(SRC)).toContain(ws(regBrandsSql(1).replace("IN (?)", "IN (${regPlaceholders})")));
  });

  it("only strategist.ts names the new indexes", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /idx_threats_no_campaign_/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(resolve(ROOT, "src"));
    expect(hits.map((p) => p.replace(`${ROOT}/`, ""))).toEqual(["src/agents/strategist.ts"]);
  });
});

// ─── plans ────────────────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("strategist query plans", () => {
  it("control: without 0315, prod-shaped stats reproduce the idx_threats_campaign walk", () => {
    const db = openMigratedDb({ exclude: [MIGRATION] });
    injectProdStats(db);
    for (const q of [S1, S2, REG_UPDATE, FB_IP, FB_REG]) {
      expect(plan(db, stripIndexedBy(q))).toContain("USING INDEX idx_threats_campaign (campaign_id=?)");
    }
    // (The removed NX4 registrar COUNT planned via idx_threats_brand_created
    // in prod; its replacement is a read the run already did — see parity.)
  });

  // With the seeded ANALYZE stats the planner sometimes finds them on its
  // own; with no stats or prod-shaped stats it never does. Hence the pins.
  it("unpinned, the no-stats and prod-stats planners never pick the 0315 indexes", () => {
    for (const [, prep] of MODES.filter(([m]) => !m.startsWith("ANALYZE"))) {
      const db = openMigratedDb();
      prep(db);
      for (const q of [S1, S2, REG_UPDATE]) expect(plan(db, stripIndexedBy(q))).not.toMatch(/no_campaign/);
    }
  });

  for (const [mode, prep] of MODES) {
    describe(mode, () => {
      const db = openMigratedDb();
      prep(db);

      it("Strategy-1: covering ip-ordered scan of the partial index, no GROUP BY sort", () => {
        const p = plan(db, S1);
        expect(p).toMatch(new RegExp(`^SEARCH threats USING COVERING INDEX ${IP_IDX} \\(ip_address>\\?\\)`));
        expect(p).not.toContain("TEMP B-TREE FOR GROUP BY");
        expect(p).not.toContain("idx_threats_campaign");
      });

      it("Strategy-2: covering 7-day range seek", () => {
        expect(plan(db, S2)).toMatch(new RegExp(`^SEARCH threats USING COVERING INDEX ${REG_IDX} \\(created_at>\\?\\)`));
      });

      it("per-registrar UPDATE: 7-day range seek on the partial index", () => {
        expect(plan(db, REG_UPDATE)).toMatch(new RegExp(`^SEARCH threats USING INDEX ${REG_IDX} \\(created_at>\\?\\)`));
      });

      it("per-IP UPDATE still seeks by ip_address (no regression)", () => {
        expect(plan(db, IP_UPDATE)).toMatch(/SEARCH threats USING INDEX idx_threats_(no_campaign_ip|ip_source_feed) \(ip_address=\?\)/);
      });

      it("fallback distinct counts use the covering partial indexes", () => {
        expect(plan(db, FB_IP)).toMatch(new RegExp(`SEARCH threats USING COVERING INDEX ${IP_IDX}`));
        expect(plan(db, FB_REG)).toMatch(new RegExp(`SEARCH threats USING COVERING INDEX ${REG_IDX} \\(created_at>\\?\\)`));
      });

      it("registrar brands context read stays on the 7-day status range (not idx_threats_brand_created)", () => {
        const p = plan(db, regBrandsSql(3));
        expect(p).toMatch(/^SEARCH t USING INDEX idx_threats_status_created \(status=\? AND created_at>\?\)/);
        expect(p).not.toContain("idx_threats_brand_created");
      });

      it("touched-only count refresh seeks campaigns by PK and threats by campaign_id", () => {
        const log: string[] = [];
        const capture = {
          prepare: (sql: string) => ({ bind: () => ({ run: async () => { log.push(sql); } }), run: async () => { log.push(sql); } }),
        } as unknown as D1Database;
        return refreshCampaignCounts(capture, ["a", "b"]).then(() => {
          expect(log).toHaveLength(1);
          const p = plan(db, log[0]!);
          expect(p).toMatch(/^SEARCH campaigns USING INDEX sqlite_autoindex_campaigns_1 \(id=\?\)/);
          expect(p).toMatch(/idx_threats_campaign \(campaign_id=\?\)/);
          expect(p).not.toMatch(/SCAN campaigns/);
        });
      });

      it("the admin strategist-backlog count is unaffected (cannot use the 0315 indexes)", () => {
        const stats = readFileSync(resolve(ROOT, "src/handlers/admin/stats.ts"), "utf8");
        const q = /"(SELECT COUNT\(\*\) AS n FROM threats WHERE status = 'active' AND campaign_id IS NULL[^"]*)"/.exec(stats)![1]!;
        const before = openMigratedDb({ exclude: [MIGRATION] });
        prep(before);
        expect(plan(db, q)).not.toMatch(/no_campaign/);
        expect(plan(db, q)).toBe(plan(before, q));
      });
    });
  }
});

// ─── result parity ────────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("rewritten queries return what the originals did", () => {
  const db = openMigratedDb();
  seed(db);
  const rows = (sql: string, ...b: unknown[]) => db.prepare(sql).all(...b) as Array<Record<string, unknown>>;
  const sorted = (r: Array<Record<string, unknown>>) => r.map((x) => JSON.stringify(x)).sort();

  it("seed actually produces clusters, registrars and brand fan-out", () => {
    expect(rows(S1).length).toBeGreaterThan(5);
    expect(rows(S2).length).toBe(REGISTRARS.length);
  });

  // LIMIT is dropped for the set comparison: ties at the cut-off are broken
  // by access path (pre-existing, unchanged), so the limited sets may differ
  // in WHICH tied rows they keep but not in their threat_count profile.
  const noLimit = (q: string) => q.replace(/\s+LIMIT \d+\s*$/, "");
  it("Strategy-1 / Strategy-2 top-N have the same threat_count profile hinted and unhinted", () => {
    for (const q of [S1, S2]) {
      const counts = (sql: string) => rows(sql).map((r) => r.threat_count);
      expect(counts(q)).toEqual(counts(stripIndexedBy(q)));
    }
  });

  for (const [name, q] of [["Strategy-1", S1], ["Strategy-2", S2], ["fallback IP", FB_IP], ["fallback registrar", FB_REG]] as const) {
    it(`${name}: hinted == unhinted`, () => {
      const a = rows(noLimit(q));
      const b = rows(noLimit(stripIndexedBy(q)));
      // GROUP_CONCAT(DISTINCT) order follows the access path; compare as sets.
      const norm = (r: Array<Record<string, unknown>>) => r.map((x) => ({
        ...x,
        ...(typeof x.sources === "string" ? { sources: x.sources.split(",").sort().join(",") } : {}),
        ...(typeof x.types === "string" ? { types: x.types.split(",").sort().join(",") } : {}),
      }));
      expect(sorted(norm(a))).toEqual(sorted(norm(b)));
      expect(a.length).toBeGreaterThan(0);
    });
  }

  it("NX4: brand ids from the context read == the old per-registrar COUNT(DISTINCT)", () => {
    const ids = new Map<string, Set<string>>();
    for (const r of rows(regBrandsSql(REGISTRARS.length), ...REGISTRARS)) {
      const s = ids.get(r.registrar as string) ?? new Set<string>();
      s.add(r.target_brand_id as string);
      ids.set(r.registrar as string, s);
    }
    let dangling = 0;
    for (const reg of REGISTRARS) {
      const old = rows(OLD_NX4, reg)[0]!.n as number;
      expect(ids.get(reg)?.size ?? 0).toBe(old);
      dangling += [...(ids.get(reg) ?? [])].filter((x) => x.startsWith("dangling")).length;
    }
    expect(dangling).toBeGreaterThan(0); // the seed exercises ids missing from brands
    expect(rows(OLD_NX4, "no-such-registrar")[0]!.n).toBe(0);
  });

  it("brand-name context: deduped names == the old DISTINCT (registrar, name)", () => {
    const names = new Map<string, string[]>();
    for (const r of rows(regBrandsSql(REGISTRARS.length), ...REGISTRARS)) {
      if (r.name === null) continue;
      const arr = names.get(r.registrar as string) ?? [];
      if (!arr.includes(r.name as string)) arr.push(r.name as string);
      names.set(r.registrar as string, arr);
    }
    const old = new Map<string, string[]>();
    for (const r of rows(OLD_REG_BRANDS(REGISTRARS.length), ...REGISTRARS)) {
      old.set(r.registrar as string, [...(old.get(r.registrar as string) ?? []), r.name as string]);
    }
    for (const reg of REGISTRARS) expect([...(names.get(reg) ?? [])].sort()).toEqual([...(old.get(reg) ?? [])].sort());
  });

  it("per-registrar UPDATE: hinted and original assign exactly the same rows", () => {
    const run = (q: string): string[] => {
      const d = openMigratedDb();
      seed(d);
      for (const [i, reg] of REGISTRARS.entries()) d.prepare(q).run(`new${i}`, reg);
      return (d.prepare("SELECT id || ':' || COALESCE(campaign_id, '-') AS k FROM threats ORDER BY id").all() as Array<{ k: string }>)
        .map((r) => r.k);
    };
    const hinted = run(REG_UPDATE);
    // Pre-0315 statement, verbatim.
    const original = `UPDATE threats SET campaign_id = ?
           WHERE registrar = ? AND campaign_id IS NULL AND status = 'active'
             AND created_at >= datetime('now', '-7 days')`;
    expect(hinted).toEqual(run(original));
    expect(hinted.filter((k) => k.includes(":new")).length).toBeGreaterThan(0);
  });
});

// ─── campaign count refresh ───────────────────────────────────────────

describe.skipIf(!hasSqlite())("campaign brand/provider count refresh", () => {
  function setup(): SqliteDb {
    const db = openMigratedDb();
    db.exec(`
      INSERT INTO campaigns (id, name, threat_count, brand_count, provider_count, status) VALUES
        ('c1', 'one', 0, 99, 99, 'active'), ('c2', 'two', 0, 99, 99, 'active');
      INSERT INTO threats (id, source_feed, threat_type, severity, status, target_brand_id, hosting_provider_id, campaign_id) VALUES
        ('x1', 'f', 'phishing', 'low', 'active', 'bA', 'p1', 'c1'),
        ('x2', 'f', 'phishing', 'low', 'active', 'bB', 'p1', 'c1'),
        ('x3', 'f', 'phishing', 'low', 'active', NULL, NULL, 'c1'),
        ('x4', 'f', 'phishing', 'low', 'active', 'bA', 'p2', 'c2');
    `);
    return db;
  }
  const counts = (db: SqliteDb) =>
    db.prepare("SELECT id, brand_count AS b, provider_count AS p FROM campaigns WHERE id IN ('c1', 'c2') ORDER BY id").all();

  it("ids → only those campaigns are recomputed", async () => {
    const db = setup();
    await refreshCampaignCounts(d1FromSqlite(db), ["c1"]);
    expect(counts(db)).toEqual([{ id: "c1", b: 2, p: 1 }, { id: "c2", b: 99, p: 99 }]);
  });

  it('"all" → every campaign, same values as the pre-0315 global statement', async () => {
    const db = setup();
    await refreshCampaignCounts(d1FromSqlite(db), "all");
    expect(counts(db)).toEqual([{ id: "c1", b: 2, p: 1 }, { id: "c2", b: 1, p: 1 }]);
  });

  it("empty id set issues no statement", async () => {
    const log: unknown[] = [];
    const db = setup();
    await refreshCampaignCounts(d1FromSqlite(db, { log: log as never }), []);
    expect(log).toHaveLength(0);
  });

  it("day stamp gate: missing → full, present → touched-only, KV error → full", async () => {
    const now = new Date("2026-11-02T06:10:00Z");
    expect(fullCountRefreshKey(now)).toBe("strategist:campaign_counts_full:2026-11-02");
    expect(await shouldRunFullCountRefresh(fakeKv(), now)).toBe(true);
    expect(await shouldRunFullCountRefresh(fakeKv({ [fullCountRefreshKey(now)]: "1" }), now)).toBe(false);
    const broken = { get: async () => { throw new Error("kv down"); } } as unknown as KVNamespace;
    expect(await shouldRunFullCountRefresh(broken, now)).toBe(true);
  });

  describe("end to end (execute)", () => {
    function seedRun(db: SqliteDb): void {
      db.exec(`
        INSERT INTO campaigns (id, name, threat_count, brand_count, provider_count, status) VALUES
          ('stale', 'untouched', 1, 99, 99, 'active');
        INSERT INTO threats (id, source_feed, threat_type, severity, status, target_brand_id, campaign_id) VALUES
          ('s1', 'f', 'phishing', 'low', 'active', 'bZ', 'stale');
      `);
      const ins = db.prepare(
        `INSERT INTO threats (id, source_feed, threat_type, severity, status, ip_address, target_brand_id, hosting_provider_id, created_at)
         VALUES (?, 'f', 'phishing', 'low', 'active', '203.0.113.9', ?, ?, ?)`,
      );
      for (let i = 0; i < 4; i++) ins.run(`ip${i}`, `b${i % 2}`, `hp${i % 3}`, sqliteTimestampHoursAgo(1));
    }
    async function run(kv: KVNamespace & { store: Map<string, string> }) {
      const db = openMigratedDb();
      seedRun(db);
      const env = {
        DB: d1FromSqlite(db, { swallow: (_s, e) => /no such table/.test(e.message) }),
        CACHE: kv,
        AI_MODE: "rules_only",
      } as never;
      const result = await strategistAgent.execute({ env, runId: "r", agentName: "strategist", input: {}, triggeredBy: null });
      const camp = db.prepare(
        `SELECT id, brand_count AS b, provider_count AS p FROM campaigns
          WHERE json_valid(attack_pattern) AND json_extract(attack_pattern, '$.ip') = '203.0.113.9'`,
      ).all() as Array<{ id: string; b: number; p: number }>;
      const stale = db.prepare("SELECT brand_count AS b FROM campaigns WHERE id = 'stale'").all() as Array<{ b: number }>;
      return { result, camp, stale: stale[0]!.b };
    }

    it("stamped day: the new IP campaign is counted, the untouched one is left alone", async () => {
      const kv = fakeKv({ [fullCountRefreshKey(new Date())]: "1" });
      const { result, camp, stale } = await run(kv);
      expect(camp).toHaveLength(1);
      expect(camp[0]).toMatchObject({ b: 2, p: 3 });
      expect(stale).toBe(99);
      expect(result.output.campaignCountsRefreshed).toBe(1);
    });

    it("first run of the day: every campaign is recomputed and the day is stamped", async () => {
      const kv = fakeKv();
      const { result, camp, stale } = await run(kv);
      expect(camp[0]).toMatchObject({ b: 2, p: 3 });
      expect(stale).toBe(1);
      expect(result.output.campaignCountsRefreshed).toBe("all");
      expect(kv.store.has(fullCountRefreshKey(new Date()))).toBe(true);
    });
  });
});
