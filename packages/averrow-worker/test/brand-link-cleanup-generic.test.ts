/**
 * brand-link cleanup — `scope=generic_brands` (2026-10-12), driven against a
 * REAL SQLite instance (node:sqlite) through a minimal D1 shim that enforces
 * bind arity on every statement, so the generic-name SQL prefilter, the rowid
 * window, the guarded (log, update) pairs and undo are all executed for real.
 * Self-skips on a runtime without node:sqlite.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import { GENERIC_SCAN_WINDOW, runBrandLinkCleanup, type CleanupBatchResult } from "../src/lib/brand-link-cleanup";
import type { Env } from "../src/types";

interface RawStmt { all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number | bigint } }
interface RawDb { exec(sql: string): void; prepare(sql: string): RawStmt }
type SqliteCtor = new (path: string) => RawDb;

const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: SqliteCtor | null = null;
try {
  DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: SqliteCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

function d1(raw: RawDb): D1Database {
  const make = (sql: string, binds: unknown[]): D1PreparedStatement => {
    const check = () => {
      if (placeholders(sql) !== binds.length) throw new Error(`bind arity: ${placeholders(sql)} vs ${binds.length}`);
      if (binds.length >= 100) throw new Error("D1 100-bind limit");
    };
    return {
      __shim: { sql, binds },
      bind: (...a: unknown[]) => make(sql, a),
      all: async () => { check(); return { results: raw.prepare(sql).all(...binds), success: true, meta: {} }; },
      first: async () => { check(); return (raw.prepare(sql).all(...binds)[0] as unknown) ?? null; },
      run: async () => { check(); const r = raw.prepare(sql).run(...binds); return { success: true, meta: { changes: Number(r.changes) } }; },
    } as unknown as D1PreparedStatement;
  };
  return {
    prepare: (sql: string) => make(sql, []),
    batch: async (stmts: D1PreparedStatement[]) => stmts.map((s) => {
      const { sql, binds } = (s as unknown as { __shim: { sql: string; binds: unknown[] } }).__shim;
      if (placeholders(sql) !== binds.length) throw new Error("bind arity (batch)");
      const r = raw.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes) } };
    }),
  } as unknown as D1Database;
}

const DDL = `
  CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, canonical_domain TEXT, tier TEXT, tranco_rank INTEGER);
  CREATE TABLE threats (
    id TEXT PRIMARY KEY, malicious_domain TEXT, malicious_url TEXT, ioc_value TEXT,
    target_brand_id TEXT, brand_match_method TEXT, source_feed TEXT
  );
  CREATE TABLE alerts (id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT);
  ${readFileSync(resolve(__dirname, "..", "migrations", "0271_brand_link_cleanup_log.sql"), "utf8")}
`;

function harness() {
  const raw = new DatabaseSync!(":memory:");
  raw.exec(DDL);
  const brand = (id: string, name: string, canonical: string, tier = "monitored") =>
    raw.prepare("INSERT INTO brands VALUES (?, ?, ?, ?, 1000)").run(id, name, canonical, tier);
  brand("brand_mail_ru", "Mail", "mail.ru");
  brand("brand_site_com", "Site", "site.com");
  brand("brand_login_gov", "Login", "login.gov");
  brand("brand_xfinity", "Xfinity", "xfinity.com");
  brand("brand_paypal", "PayPal", "paypal.com");
  brand("brand_live_com", "Live", "live.com");
  brand("brand_microsoft_com", "Microsoft", "microsoft.com");
  const threat = (rowid: number, id: string, domain: string, brandId: string, feed: string, method: string | null = null) =>
    raw.prepare(`INSERT INTO threats (rowid, id, malicious_domain, target_brand_id, brand_match_method, source_feed)
                 VALUES (?, ?, ?, ?, ?, ?)`).run(rowid, id, domain, brandId, method, feed);
  threat(1, "t_bare_nrd", "1lookupmails.com", "brand_mail_ru", "nrd_hagezi");
  threat(2, "t_variant", "xfinitymail97.weebly.com", "brand_mail_ru", "numbered_variant_scan");
  threat(3, "t_canon", "mail.ru", "brand_mail_ru", "phishtank", "canonical");
  threat(4, "t_lookalike", "mail-ru.com", "brand_mail_ru", "ct_logs");
  threat(5, "t_paypal", "paypal-secure.com", "brand_paypal", "openphish", "token"); // not generic: untouched
  threat(6, "t_site", "0bmmubit.site-enfejar-ba-zarib-bala.com", "brand_site_com", "numbered_variant_scan", "keyword");
  threat(7, "t_login", "voiceloginqa4.fmr.com", "brand_login_gov", "ct_logs");
  threat(8, "t_live_ms", "outlook-verify-account.com", "brand_live_com", "ct_logs");
  threat(9, "t_live_noise", "live-stream.tv", "brand_live_com", "nrd_hagezi");
  threat(GENERIC_SCAN_WINDOW + 10, "t_far", "membersecurelogin.com", "brand_login_gov", "ct_logs");
  raw.prepare("INSERT INTO alerts VALUES ('a1', 'threat', 't_bare_nrd')").run();
  const env = { DB: d1(raw) } as unknown as Env;
  const brandOf = (id: string) =>
    (raw.prepare("SELECT target_brand_id AS b, brand_match_method AS m FROM threats WHERE id = ?").all(id)[0] as { b: string | null; m: string | null });
  return { raw, env, brandOf };
}

const OPTS = { cursor: 0, limit: 500, runId: "gen1", actor: "internal", scope: "generic_brands" as const };

async function drain(env: Env, mode: "dry_run" | "apply", limit = 500): Promise<CleanupBatchResult[]> {
  const out: CleanupBatchResult[] = [];
  let cursor = 0;
  for (let i = 0; i < 20; i++) {
    const r = await runBrandLinkCleanup(env, { ...OPTS, mode, cursor, limit });
    out.push(r);
    if (r.done) break;
    cursor = r.next_cursor;
  }
  return out;
}

describe.skipIf(DatabaseSync === null)("runBrandLinkCleanup — scope=generic_brands (node:sqlite)", () => {
  it("dry_run: windows by rowid, decides only generic-brand links, writes nothing", async () => {
    const { env, brandOf } = harness();
    const pages = await drain(env, "dry_run");
    expect(pages).toHaveLength(2); // [0, 50000] then (50000, max]
    expect(pages[0]).toMatchObject({ scope: "generic_brands", next_cursor: GENERIC_SCAN_WINDOW, done: false });
    const sum = (k: "scanned" | "keep" | "relink" | "clear") => pages.reduce((n, p) => n + p[k], 0);
    expect(sum("scanned")).toBe(9); // the PayPal link is never read
    expect(sum("keep")).toBe(2); // mail.ru, mail-ru.com
    expect(sum("relink")).toBe(2); // → Xfinity; Live outlook lure → Microsoft
    expect(sum("clear")).toBe(5);
    expect(pages[0]!.removed_by_source).toEqual({ nrd_hagezi: 2, numbered_variant_scan: 2, ct_logs: 2 });
    expect(pages[0]!.added_by_brand).toEqual({ brand_xfinity: 1, brand_microsoft_com: 1 });
    expect(pages[0]!.alerts_affected).toBe(1);
    expect(brandOf("t_bare_nrd").b).toBe("brand_mail_ru");
  });

  it("a full page stops at the last match instead of the window end", async () => {
    const { env } = harness();
    const r = await runBrandLinkCleanup(env, { ...OPTS, mode: "dry_run", limit: 2 });
    expect(r).toMatchObject({ scanned: 2, next_cursor: 2, done: false });
  });

  it("apply logs and changes exactly the decided links; undo restores them", async () => {
    const { env, raw, brandOf } = harness();
    const applied = await drain(env, "apply");
    expect(applied.reduce((n, p) => n + p.changed, 0)).toBe(7);
    expect(brandOf("t_live_ms")).toEqual({ b: "brand_microsoft_com", m: "token" });
    expect(brandOf("t_live_noise").b).toBeNull();

    expect(brandOf("t_bare_nrd")).toEqual({ b: null, m: null });
    expect(brandOf("t_variant")).toEqual({ b: "brand_xfinity", m: "substring" });
    expect(brandOf("t_site").b).toBeNull();
    expect(brandOf("t_login").b).toBeNull();
    expect(brandOf("t_far").b).toBeNull();
    expect(brandOf("t_canon")).toEqual({ b: "brand_mail_ru", m: "canonical" });
    expect(brandOf("t_lookalike")).toEqual({ b: "brand_mail_ru", m: "token" }); // method stamped
    expect(brandOf("t_paypal")).toEqual({ b: "brand_paypal", m: "token" });

    const log = raw.prepare("SELECT threat_id, old_brand_id, old_method, action, reason FROM brand_link_cleanup_log ORDER BY threat_id").all();
    expect(log).toEqual([
      { threat_id: "t_bare_nrd", old_brand_id: "brand_mail_ru", old_method: null, action: "clear", reason: "generic_brand" },
      { threat_id: "t_far", old_brand_id: "brand_login_gov", old_method: null, action: "clear", reason: "generic_brand" },
      { threat_id: "t_live_ms", old_brand_id: "brand_live_com", old_method: null, action: "relink", reason: "generic_brand" },
      { threat_id: "t_live_noise", old_brand_id: "brand_live_com", old_method: null, action: "clear", reason: "generic_brand" },
      { threat_id: "t_login", old_brand_id: "brand_login_gov", old_method: null, action: "clear", reason: "generic_brand" },
      { threat_id: "t_site", old_brand_id: "brand_site_com", old_method: "keyword", action: "clear", reason: "generic_brand" },
      { threat_id: "t_variant", old_brand_id: "brand_mail_ru", old_method: null, action: "relink", reason: "generic_brand" },
    ]);

    const undo = await runBrandLinkCleanup(env, { ...OPTS, mode: "undo", runId: "gen1" });
    expect(undo).toMatchObject({ scanned: 7, changed: 7, skipped: 0 });
    expect(brandOf("t_live_ms").b).toBe("brand_live_com");
    expect(brandOf("t_bare_nrd").b).toBe("brand_mail_ru");
    expect(brandOf("t_variant").b).toBe("brand_mail_ru");
    expect(brandOf("t_site")).toEqual({ b: "brand_site_com", m: "keyword" });
  });

  it("brand= restricts the run to the listed brands", async () => {
    const { env, brandOf } = harness();
    let cursor = 0;
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await runBrandLinkCleanup(env, { ...OPTS, mode: "apply", cursor, brandIds: ["brand_live_com", "brand_site_com"] });
      seen.push(r.scanned);
      if (r.done) break;
      cursor = r.next_cursor;
    }
    expect(seen.reduce((a, b) => a + b, 0)).toBe(3); // t_site, t_live_ms, t_live_noise
    expect(brandOf("t_site").b).toBeNull();
    expect(brandOf("t_live_ms").b).toBe("brand_microsoft_com");
    expect(brandOf("t_bare_nrd").b).toBe("brand_mail_ru"); // Mail not listed → untouched
    expect(brandOf("t_far").b).toBe("brand_login_gov");
  });

  it("scope=all keeps the authoritative-feed generic links protected (unchanged default)", async () => {
    const { env } = harness();
    const r = await runBrandLinkCleanup(env, { ...OPTS, scope: "all", mode: "dry_run" });
    expect(r.scope).toBe("all");
    expect(r.kept_protected.authoritative_source).toBe(7); // nrd ×2, variant ×2, ct ×3
    expect(r.clear + r.relink).toBe(0);
  });
});
