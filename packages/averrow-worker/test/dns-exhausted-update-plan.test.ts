// Pin: the dns_exhausted_at UPDATE seeks threats by malicious_domain.
//
// `UPDATE threats SET dns_exhausted_at … WHERE malicious_domain IN (…)
//   AND status = 'active' AND ip_address IS NULL AND dns_exhausted_at IS NULL`
// planned in prod as `SEARCH threats USING INDEX idx_threats_ip_source_feed
// (ip_address=?)` — sqlite_stat1 reports a small average row count per
// ip_address value (it can't see the NULL skew), so the planner walked every
// unresolved row instead of ≤50 domain seeks (~9M rows/day across
// lib/dns-backfill.ts and lib/dns-queue-reaper.ts).
//
// The fix prefixes `status` and `ip_address` with unary `+` (a value no-op
// that makes the term ineligible for index lookup), leaving
// `malicious_domain IN (…)` as the only indexable term. This test runs the
// SQL extracted from both source files against the migration-derived threats
// shape + the live (post-DROP) index set, with prod-like planner statistics
// injected, and asserts:
//   1. the ORIGINAL statement reproduces the mis-pick under those stats
//      (so the stats actually exercise the failure), and
//   2. the shipped statements seek by domain and never touch the ip index,
//   3. the shipped statements update exactly the same rows.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";

const SRC = resolve(__dirname, "..", "src");

/** Extract the dns_exhausted_at UPDATE literal from a source file. */
function exhaustedUpdateSql(file: string): string {
  const src = readFileSync(resolve(SRC, file), "utf8");
  const hits = [...src.matchAll(/`([^`]*)`/g)]
    .map((m) => m[1]!)
    .filter((t) => /UPDATE threats/.test(t) && /SET dns_exhausted_at = datetime\('now'\)\s+WHERE/.test(t));
  expect(hits, `${file}: expected exactly one dns_exhausted_at UPDATE`).toHaveLength(1);
  return hits[0]!;
}

function withPlaceholders(sql: string, n: number): string {
  return sql.replace(/\$\{\w+\}/, Array.from({ length: n }, () => "?").join(","));
}

const ORIGINAL_SQL = `
  UPDATE threats
     SET dns_exhausted_at = datetime('now')
   WHERE malicious_domain IN (\${ph})
     AND status = 'active'
     AND ip_address IS NULL
     AND dns_exhausted_at IS NULL`;

function openThreats(): SqliteDb {
  const raw = openDerivedDb(["threats"]);
  for (const ddl of liveIndexDdl("threats").values()) raw.exec(ddl);
  return raw;
}

/**
 * Inject prod-shaped sqlite_stat1 rows (≈700K threats; ~2 rows per
 * ip_address value as ANALYZE averages it, ~3 per domain, ~350K per status)
 * and reload them into the planner.
 */
function injectProdStats(raw: SqliteDb): void {
  raw.exec("ANALYZE");
  raw.exec("DELETE FROM sqlite_stat1");
  const stats: Array<[string, string]> = [
    ["idx_threats_ip_source_feed", "700000 2 1"],
    ["idx_threats_ip", "700000 2"],
    ["idx_threats_domain", "700000 3"],
    ["idx_threats_unresolved_domain", "200000 2"],
    ["idx_threats_unresolved_pending", "200000 50"],
    ["idx_threats_status_created", "700000 350000 1"],
  ];
  const ins = raw.prepare("INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES ('threats', ?, ?)");
  for (const [idx, stat] of stats) ins.run(idx, stat);
  ins.run(null, "700000");
  raw.exec("ANALYZE sqlite_schema");
}

const plan = (raw: SqliteDb, sql: string, binds: unknown[]): string =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");

const DOMAINS = Array.from({ length: 50 }, (_, i) => `dead-${i}.example`);

describe.skipIf(!hasSqlite())("dns_exhausted_at UPDATE query plan", () => {
  it("the live index set still contains the indexes this pin reasons about", () => {
    const live = liveIndexDdl("threats");
    expect(live.has("idx_threats_domain")).toBe(true);
    expect(live.has("idx_threats_ip_source_feed")).toBe(true);
    // Dropped in migration 0200 — must not be materialised.
    expect(live.has("idx_threats_dns_pending_strict")).toBe(false);
  });

  it("prod-like stats reproduce the original mis-pick (control)", () => {
    const raw = openThreats();
    injectProdStats(raw);
    expect(plan(raw, withPlaceholders(ORIGINAL_SQL, DOMAINS.length), DOMAINS))
      .toMatch(/idx_threats_ip(_source_feed)?\b/);
  });

  for (const file of ["lib/dns-backfill.ts", "lib/dns-queue-reaper.ts"]) {
    it(`${file}: seeks by malicious_domain, never the ip index`, () => {
      const raw = openThreats();
      injectProdStats(raw);
      const p = plan(raw, withPlaceholders(exhaustedUpdateSql(file), DOMAINS.length), DOMAINS);
      expect(p).toContain("idx_threats_domain (malicious_domain=?)");
      expect(p).not.toMatch(/idx_threats_ip/);
      expect(p).not.toMatch(/^SCAN threats\b|\| SCAN threats\b/);
    });

    it(`${file}: updates exactly the rows the original predicate did`, () => {
      const seed = (raw: SqliteDb) => {
        const ins = raw.prepare(
          `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, ip_address, status, dns_exhausted_at)
           VALUES (?, 'test', 'phishing', ?, ?, ?, ?)`,
        );
        let n = 0;
        for (const d of ["dead-1.example", "dead-2.example", "live.example"]) {
          for (const ip of [null, "", "1.2.3.4"]) {
            for (const status of ["active", "down"]) {
              for (const ex of [null, "2026-01-01 00:00:00"]) {
                ins.run(`t${n++}`, d, ip, status, ex);
              }
            }
          }
        }
      };
      const binds = ["dead-1.example", "dead-2.example"];
      const run = (sql: string): string[] => {
        const raw = openThreats();
        seed(raw);
        raw.prepare(withPlaceholders(sql, binds.length)).run(...binds);
        return (raw.prepare(
          `SELECT id FROM threats WHERE dns_exhausted_at IS NOT NULL AND dns_exhausted_at != '2026-01-01 00:00:00' ORDER BY id`,
        ).all() as Array<{ id: string }>).map((r) => r.id);
      };
      const before = run(ORIGINAL_SQL);
      expect(before.length).toBe(2); // active + NULL ip + not yet exhausted, per dead domain
      expect(run(exhaustedUpdateSql(file))).toEqual(before);
    });
  }
});
