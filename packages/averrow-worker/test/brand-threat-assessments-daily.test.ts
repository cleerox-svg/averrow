/**
 * Daily brand threat assessments (brand-threat-correlator.ts) run every
 * statement against the fully migrated schema with NO error swallowing.
 *
 * Until 2026-11-10 the run selected brands with `WHERE b.is_monitored = 1`
 * — a column that has never existed — and caught the error, so prod's
 * brand_threat_assessments table never held a row. The email-security read
 * (has_dmarc/has_spf/has_dkim) and both DMARC reads (created_at, spf_result,
 * source_ip on dmarc_reports) also named missing columns behind `.catch()`,
 * which scored every brand "No DMARC record configured". Every query here
 * runs for real, and a SQL error fails the test.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  hasSqlite,
  openMigratedDb,
  d1FromSqlite,
  fakeKv,
  type SqliteDb,
  type StatementLogEntry,
} from "./sqlite-d1-harness";
import {
  runDailyAssessments,
  correlateBrandThreats,
  ASSESSMENT_BRAND_LIMIT,
} from "../src/brand-threat-correlator";
import type { Env } from "../src/types";

const PROD_DMARC_REPORT_RECORDS_DDL = [
  `CREATE TABLE dmarc_report_records (
     id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER NOT NULL, source_ip TEXT NOT NULL,
     count INTEGER DEFAULT 1, disposition TEXT, dkim_result TEXT, spf_result TEXT, dmarc_result TEXT,
     header_from TEXT, envelope_from TEXT, dkim_domain TEXT, spf_domain TEXT, country_code TEXT,
     city TEXT, lat REAL, lng REAL, asn TEXT, org TEXT,
     FOREIGN KEY (report_id) REFERENCES dmarc_reports(id))`,
  "CREATE INDEX idx_drr_report ON dmarc_report_records(report_id)",
  "CREATE INDEX idx_drr_ip ON dmarc_report_records(source_ip)",
  "CREATE INDEX idx_drr_dmarc_result ON dmarc_report_records(dmarc_result)",
];

describe.skipIf(!hasSqlite())("daily brand threat assessments (migrated schema)", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let env: Env;

  beforeEach(() => {
    raw = openMigratedDb();
    // dmarc_report_records predates migrations/ — no migration creates it.
    // Prod DDL copied from sqlite_master (2026-11-10).
    for (const stmt of PROD_DMARC_REPORT_RECORDS_DDL) raw.exec(stmt);
    log = [];
    const ins = raw.prepare(
      "INSERT INTO brands (id, name, canonical_domain, tier, last_threat_seen, email_security_grade) VALUES (?, ?, ?, ?, ?, ?)",
    );
    ins.run("b_cust", "Customer Co", "customer.example", "customer", "2026-01-01 00:00:00", "A");
    ins.run("b_mon_new", "Monitored New", "new.example", "monitored", "2026-11-09 00:00:00", "F");
    ins.run("b_mon_old", "Monitored Old", "old.example", "monitored", "2026-10-01 00:00:00", null);
    ins.run("b_tracked", "Tracked Only", "tracked.example", "tracked", "2026-11-09 00:00:00", null);

    raw.prepare(
      `INSERT INTO email_security_scans (brand_id, domain, dmarc_exists, dmarc_policy, spf_exists, dkim_exists, scanned_at)
       VALUES ('b_cust', 'customer.example', 1, 'reject', 1, 1, datetime('now'))`,
    ).run();
    raw.prepare(
      `INSERT INTO dmarc_reports (brand_id, domain, report_id, total_fail, received_at)
       VALUES ('b_mon_new', 'new.example', 'r1', 7, datetime('now'))`,
    ).run();
    const reportId = (raw.prepare("SELECT id FROM dmarc_reports").all()[0] as { id: number }).id;
    const rec = raw.prepare(
      "INSERT INTO dmarc_report_records (report_id, source_ip, count, spf_result, dkim_result) VALUES (?, ?, ?, ?, ?)",
    );
    rec.run(reportId, "203.0.113.1", 5, "fail", "pass");
    rec.run(reportId, "203.0.113.2", 2, "pass", "fail");
    rec.run(reportId, "203.0.113.3", 9, "pass", "pass");

    env = { DB: d1FromSqlite(raw, { log }), CACHE: fakeKv() } as unknown as Env;
  });

  it("assesses monitored + customer brands (customer first, then most recently targeted), never tracked", async () => {
    const result = await runDailyAssessments(env);
    expect(log.filter((l) => l.error)).toEqual([]);
    expect(result.brandsAssessed).toBe(3);

    const rows = raw.prepare("SELECT brand_id FROM brand_threat_assessments ORDER BY id").all() as Array<{ brand_id: string }>;
    expect(rows.map((r) => r.brand_id)).toEqual(["b_cust", "b_mon_new", "b_mon_old"]);

    const select = log.find((l) => /FROM brands b/.test(l.sql) && /LIMIT/.test(l.sql));
    expect(select?.sql).toContain(`LIMIT ${ASSESSMENT_BRAND_LIMIT}`);
    expect(select?.sql).not.toMatch(/is_monitored|JOIN threats/);
  });

  it("reads the real email-security and DMARC columns", async () => {
    const cust = await correlateBrandThreats(env, "b_cust");
    expect(log.filter((l) => l.error)).toEqual([]);
    expect(cust).not.toBeNull();
    expect(cust!.has_dmarc && cust!.has_spf && cust!.has_dkim).toBe(true);
    expect(cust!.dmarc_policy).toBe("reject");
    expect(cust!.risk_factors.some((f) => /DMARC/.test(f))).toBe(false);

    const mon = await correlateBrandThreats(env, "b_mon_new");
    expect(mon!.dmarc_failures_30d).toBe(7);
    // .1 fails SPF but passes DKIM, .2 the reverse: both pass DMARC, so neither is unauthorized.
    expect(mon!.unauthorized_senders_30d).toBe(0);
  });

  it("runs once per UTC day: a run late yesterday never blocks today's", async () => {
    const kv = env.CACHE as unknown as { put(k: string, v: string): Promise<void>; get(k: string): Promise<string | null> };
    // Yesterday's run, at any minute, must not suppress today's.
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    await kv.put("pipeline:assessments:last_run_date", yesterday);
    expect((await runDailyAssessments(env)).brandsAssessed).toBe(3);
    expect(await kv.get("pipeline:assessments:last_run_date")).toBe(new Date().toISOString().slice(0, 10));
    // A second call the same day is skipped.
    expect((await runDailyAssessments(env)).brandsAssessed).toBe(0);
  });

  it("a failed brand selection does not mark the day done", async () => {
    const realDb = env.DB;
    (env as { DB: unknown }).DB = { prepare: () => { throw new Error("no such column: x"); } };
    await expect(runDailyAssessments(env)).rejects.toThrow(/no such column/);
    expect(await env.CACHE.get("pipeline:assessments:last_run_date")).toBeNull();
    (env as { DB: unknown }).DB = realDb;
    expect((await runDailyAssessments(env)).brandsAssessed).toBe(3);
  });

  it("unauthorized senders are sources passing neither SPF nor DKIM", async () => {
    raw.prepare(
      "INSERT INTO dmarc_report_records (report_id, source_ip, count, spf_result, dkim_result) VALUES ((SELECT id FROM dmarc_reports), '198.51.100.9', 3, 'fail', 'fail')",
    ).run();
    const mon = await correlateBrandThreats(env, "b_mon_new");
    // .1 (spf fail, dkim pass) and .2 (spf pass, dkim fail) passed DMARC; only .9 failed both.
    expect(mon!.unauthorized_senders_30d).toBe(1);
  });

  it("the DMARC reads the code actually runs seek the brand/received_at index", async () => {
    await correlateBrandThreats(env, "b_mon_new");
    const dmarcReads = log.filter((l) => /FROM dmarc_reports/.test(l.sql));
    expect(dmarcReads).toHaveLength(2);
    for (const r of dmarcReads) {
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${r.sql}`).all(...(r.binds ?? [])) as Array<{ detail: string }>)
        .map((p) => p.detail)
        .join(" | ");
      expect(plan).toContain("idx_dmarc_reports_brand_received");
      if (/dmarc_report_records/.test(r.sql)) expect(plan).toContain("idx_drr_report");
    }
  });
});
