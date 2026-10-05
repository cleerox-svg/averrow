/**
 * Lookalike official-domain rule (alert-triage rule family 5), driven
 * against REAL SQLITE.
 *
 * Prod, 2026-10-05: three HIGH `lookalike_domain_active` alerts were
 * another brand's own official domain — zoom.com (lookalike of zoom.us),
 * cloud.com (of icloud.com), ing.com (of bing.com). Each is both a
 * `brand_safe_domains` row and a `brands.canonical_domain`. This file
 * proves, with the production SQL rather than a mock re-implementing it:
 *
 *   - the one lookup statement is an index search on both tables,
 *   - `runAlertTriageBackfill` (POST /api/admin/alerts/backfill-triage)
 *     dismisses those three and keeps a real squat,
 *   - `createAlert`'s real-time hook dismisses at birth,
 *   - the seeder never stores such a permutation, and its lookup stays
 *     at <=100 binds per statement.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../src/types";
import { applyLookalikeSchema } from "./lookalike-schema";
import { runAlertTriageBackfill } from "../src/lib/alert-triage";
import { createAlert } from "../src/lib/alerts";
import { loadOfficialDomainMatches } from "../src/lib/safeDomains";
import { generateAndStoreLookalikes } from "../src/scanners/lookalike-domains";
import { generatePermutations } from "../src/lib/dnstwist";

type Stmt = {
  all(...p: unknown[]): unknown[];
  get(...p: unknown[]): unknown;
  run(...p: unknown[]): { changes: number };
};
type Sqlite = { exec(sql: string): void; prepare(sql: string): Stmt };
type SqliteCtor = new (path: string) => Sqlite;

const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: SqliteCtor | null = null;
try {
  DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: SqliteCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const hasSqlite = (): boolean => DatabaseSync !== null;

/** brand_safe_domains comes from its migration so the index is the real one. */
const SAFE_DOMAINS_DDL = readFileSync(
  resolve(__dirname, "..", "migrations", "0015_brand_safe_domains.sql"),
  "utf8",
);

const DDL = `
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE brands (
    id TEXT PRIMARY KEY,
    name TEXT,
    canonical_domain TEXT,
    tier TEXT
  );
  -- migration 0042
  CREATE UNIQUE INDEX idx_brands_domain ON brands(canonical_domain);
  CREATE TABLE alerts (
    id TEXT PRIMARY KEY,
    brand_id TEXT, user_id TEXT, alert_type TEXT, severity TEXT,
    title TEXT, summary TEXT, details TEXT,
    source_type TEXT, source_id TEXT,
    ai_assessment TEXT, ai_recommendations TEXT, org_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new',
    resolved_at TEXT, resolution_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  );
`;

interface Harness {
  db: Sqlite;
  DB: D1Database;
  /** Bind counts of every prepared statement that touched brand_safe_domains. */
  lookupBinds: number[];
}

function harness(): Harness {
  const db = new DatabaseSync!(":memory:");
  db.exec(DDL);
  db.exec(SAFE_DOMAINS_DDL);
  applyLookalikeSchema(db);

  // The prod rows behind the three false HIGH alerts, plus the brands the
  // lookalikes were generated for.
  const brands: Array<[string, string, string, string]> = [
    ["brand_zoom", "Zoom Video", "zoom.us", "monitored"],
    ["brand_icloud", "iCloud", "icloud.com", "monitored"],
    ["brand_bing", "Bing", "bing.com", "monitored"],
    ["brand_zoom_com", "Zoom", "zoom.com", "monitored"],
    ["brand_cloud_com", "Cloud", "cloud.com", "tracked"],
    ["brand_ing", "ING", "ing.com", "monitored"],
  ];
  for (const b of brands) {
    db.prepare(`INSERT INTO brands (id, name, canonical_domain, tier) VALUES (?, ?, ?, ?)`).run(...b);
  }
  for (const [id, brand, domain] of [
    ["s1", "brand_zoom_com", "zoom.com"],
    ["s2", "brand_zoom_com", "*.zoom.com"],
    ["s3", "brand_cloud_com", "cloud.com"],
    ["s4", "brand_ing", "ing.com"],
  ]) {
    db.prepare(`INSERT INTO brand_safe_domains (id, brand_id, domain) VALUES (?, ?, ?)`).run(id, brand, domain);
  }

  const lookupBinds: number[] = [];
  type Bound = { sql: string; params: unknown[] };
  const DB = {
    prepare(sql: string) {
      const wrap = (params: unknown[]) => ({
        sql,
        params,
        async all<T>() {
          if (sql.includes("brand_safe_domains")) lookupBinds.push(params.length);
          return { results: db.prepare(sql).all(...params) as T[], meta: {} };
        },
        async first<T>() {
          return (db.prepare(sql).get(...params) ?? null) as T | null;
        },
        async run() {
          return { meta: { changes: db.prepare(sql).run(...params).changes } };
        },
      });
      return { ...wrap([]), bind: (...p: unknown[]) => wrap(p) };
    },
    async batch(stmts: Bound[]) {
      return stmts.map((st) => ({ meta: { changes: db.prepare(st.sql).run(...st.params).changes } }));
    },
  };
  return { db, DB: DB as unknown as D1Database, lookupBinds };
}

function insertAlert(db: Sqlite, id: string, brandId: string, alertType: string, details: object, createdAt: string) {
  db.prepare(
    `INSERT INTO alerts (id, brand_id, user_id, alert_type, severity, title, summary, details, source_type, source_id, created_at)
     VALUES (?, ?, 'system', ?, 'high', 't', 's', ?, 'lookalike_scanner', ?, ?)`,
  ).run(id, brandId, alertType, JSON.stringify(details), `l_${id}`, createdAt);
}

describe.skipIf(!hasSqlite())("official-domain lookup — one indexed statement", () => {
  it("searches both tables by index, never scans", async () => {
    const h = harness();
    await loadOfficialDomainMatches(h.DB, ["zoom.com"]);
    expect(h.lookupBinds).toEqual([3]); // zoom.com, *.zoom.com (safe) + zoom.com (canonical)

    // Re-run the exact statement shape under EXPLAIN QUERY PLAN.
    const sql = `SELECT s.domain AS domain, s.brand_id AS brand_id, b.name AS brand_name,
              'safe_domain' AS source
         FROM brand_safe_domains s
         LEFT JOIN brands b ON b.id = s.brand_id
        WHERE s.domain IN (?,?)
       UNION ALL
       SELECT b.canonical_domain AS domain, b.id AS brand_id, b.name AS brand_name,
              'canonical_domain' AS source
         FROM brands b
        WHERE b.canonical_domain IN (?)`;
    const plan = (h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("zoom.com", "*.zoom.com", "zoom.com") as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toMatch(/SEARCH s USING INDEX idx_safe_domains_domain/);
    expect(plan).toMatch(/SEARCH b USING (?:COVERING )?INDEX idx_brands_domain/);
    expect(plan).not.toMatch(/SCAN (?:s|b)\b/);
  });
});

describe.skipIf(!hasSqlite())("runAlertTriageBackfill — the three known false HIGH alerts", () => {
  it("dismisses zoom.com / cloud.com / ing.com, keeps a real squat, and reports by_type", async () => {
    const h = harness();
    insertAlert(h.db, "a-zoom", "brand_zoom", "lookalike_domain_active", { lookalike_domain: "zoom.com", original_domain: "zoom.us" }, "2026-10-01 00:00:01");
    insertAlert(h.db, "a-cloud", "brand_icloud", "lookalike_domain_active", { lookalike_domain: "cloud.com", original_domain: "icloud.com" }, "2026-10-01 00:00:02");
    insertAlert(h.db, "a-ing", "brand_bing", "lookalike_domain_active", { lookalike_domain: "ing.com", original_domain: "bing.com" }, "2026-10-01 00:00:03");
    // A confirmed-new-registration alert (PR #1793 shape) for a real squat.
    insertAlert(h.db, "a-squat", "brand_zoom", "lookalike_domain_active", { new_registration: true, lookalike_domain: "zoom-us.com" }, "2026-10-01 00:00:04");
    // typosquat_bimi carries `domain`, not `lookalike_domain`.
    insertAlert(h.db, "a-bimi", "brand_zoom", "typosquat_bimi", { domain: "zoom.com", brand_domain: "zoom.us" }, "2026-10-01 00:00:05");

    const res = await runAlertTriageBackfill(h.DB, { limit: 500 });
    expect(res.scanned).toBe(5);
    expect(res.dismissed).toBe(4);
    expect(res.kept).toBe(1);
    expect(res.by_type).toEqual({
      lookalike_domain_active: { scanned: 4, dismissed: 3, kept: 1 },
      typosquat_bimi: { scanned: 1, dismissed: 1, kept: 0 },
    });
    // The whole batch's lookup is a single statement.
    expect(h.lookupBinds).toHaveLength(1);

    const rows = Object.fromEntries(
      (h.db.prepare(`SELECT id, status, resolution_notes FROM alerts`).all() as Array<{ id: string; status: string; resolution_notes: string | null }>)
        .map((r) => [r.id, r]),
    );
    expect(rows["a-zoom"]).toMatchObject({ status: "false_positive", resolution_notes: "auto: zoom.com is the official domain of Zoom" });
    expect(rows["a-cloud"]).toMatchObject({ status: "false_positive", resolution_notes: "auto: cloud.com is the official domain of Cloud" });
    expect(rows["a-ing"]).toMatchObject({ status: "false_positive", resolution_notes: "auto: ing.com is the official domain of ING" });
    expect(rows["a-squat"]).toMatchObject({ status: "new", resolution_notes: null });
    expect(rows["a-bimi"]!.status).toBe("false_positive");

    // Idempotent: a re-run finds nothing new to dismiss.
    const again = await runAlertTriageBackfill(h.DB, { limit: 500 });
    expect(again.dismissed).toBe(0);
  });
});

describe.skipIf(!hasSqlite())("createAlert real-time hook — lookalike family", () => {
  it("files an official-domain lookalike already dismissed, and leaves a real squat new", async () => {
    const h = harness();
    const fp = await createAlert(h.DB, {
      brandId: "brand_zoom", userId: "system", alertType: "lookalike_domain_active", severity: "high",
      title: "New lookalike domain registered: zoom.com", summary: "s",
      details: { new_registration: true, lookalike_domain: "zoom.com" }, sourceType: "lookalike_scanner", sourceId: "l1",
    });
    const real = await createAlert(h.DB, {
      brandId: "brand_zoom", userId: "system", alertType: "lookalike_domain_active", severity: "high",
      title: "Lookalike domain registered: zoom-us.com", summary: "s",
      details: { lookalike_domain: "zoom-us.com" }, sourceType: "lookalike_scanner", sourceId: "l2",
    });
    const status = (id: string | null) =>
      (h.db.prepare(`SELECT status, resolution_notes FROM alerts WHERE id = ?`).get(id) as { status: string; resolution_notes: string | null });
    expect(status(fp)).toEqual({ status: "false_positive", resolution_notes: "auto: zoom.com is the official domain of Zoom" });
    expect(status(real)).toEqual({ status: "new", resolution_notes: null });
  });
});

describe.skipIf(!hasSqlite())("generateAndStoreLookalikes — official domains are never seeded", () => {
  it.each([
    ["brand_zoom", "zoom.us", "zoom.com"],
    ["brand_icloud", "icloud.com", "cloud.com"],
    ["brand_bing", "bing.com", "ing.com"],
  ])("%s (%s) never stores %s", async (brandId, domain, official) => {
    const h = harness();
    expect(generatePermutations(domain).map((p) => p.domain), "precondition: dnstwist generates it").toContain(official);

    const created = await generateAndStoreLookalikes({ DB: h.DB } as unknown as Env, brandId, domain);
    const stored = (h.db.prepare(`SELECT domain FROM lookalike_domains WHERE brand_id = ?`).all(brandId) as Array<{ domain: string }>)
      .map((r) => r.domain);
    expect(stored).not.toContain(official);
    expect(created).toBe(generatePermutations(domain).length - 1);
    // Every lookup statement stays under D1's 100-bind limit.
    expect(h.lookupBinds.length).toBeGreaterThan(0);
    for (const n of h.lookupBinds) expect(n).toBeLessThanOrEqual(99);
  });

  it("fails open: a lookup error still seeds every permutation", async () => {
    const h = harness();
    h.db.exec(`DROP TABLE brand_safe_domains`);
    const created = await generateAndStoreLookalikes({ DB: h.DB } as unknown as Env, "brand_zoom", "zoom.us");
    expect(created).toBe(generatePermutations("zoom.us").length);
  });

  it("chunks a large host list at <=99 binds per statement", async () => {
    const h = harness();
    const hosts = Array.from({ length: 200 }, (_, i) => `host${i}.example`);
    await loadOfficialDomainMatches(h.DB, hosts);
    expect(h.lookupBinds.length).toBe(Math.ceil(200 / 33));
    for (const n of h.lookupBinds) expect(n).toBeLessThanOrEqual(99);
  });
});
