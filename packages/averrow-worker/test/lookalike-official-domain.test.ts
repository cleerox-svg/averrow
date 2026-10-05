/**
 * Lookalike official-domain rule (alert-triage rule family 5), driven
 * against REAL SQLITE with the production SQL.
 *
 * Prod, 2026-10-05: three HIGH `lookalike_domain_active` alerts were
 * another brand's own official domain — zoom.com (lookalike of zoom.us),
 * cloud.com (of icloud.com), ing.com (of bing.com). Review then showed
 * neither source table is an allowlist by construction (auto_detected
 * safe-domain copies; ai_attributed / public / self-service brands;
 * Tranco typosquats such as cloudfare.com), so only a TRUSTED match may
 * dismiss. This file proves, end to end:
 *
 *   - the trust predicate as SQLite evaluates it, and that the lookup is
 *     an index search on both tables,
 *   - `runAlertTriageBackfill` (POST /api/admin/alerts/backfill-triage)
 *     dismisses the three, marks their lookalike rows benign + parked, and
 *     refuses every untrusted / newly-registered case,
 *   - `createAlert` does the same at birth, and still files the alert as
 *     'new' when the lookup throws,
 *   - the seeder stores trusted matches as benign (not dropped) and seeds
 *     untrusted matches normally, at <=99 binds per statement.
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
import { isUnderSharedHosting, loadOfficialDomainMatches } from "../src/lib/safeDomains";
import { generateAndStoreLookalikes } from "../src/scanners/lookalike-domains";
import { generatePermutations } from "../src/lib/dnstwist";
import { handleUpdateLookalike } from "../src/handlers/lookalikeDomains";
import { handleAddSafeDomain, handleBulkAddSafeDomains, handleDeleteSafeDomain } from "../src/handlers/safeDomains";
import { NRD_LOOKALIKE_CLAIM_SQL } from "../src/lib/lookalike-nrd-matcher";
import { decideLookalikeRegistrationTriage } from "../src/lib/alert-triage";
import type { AuthContext } from "../src/middleware/auth";

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

/** brand_safe_domains comes from its migration so columns + index are real. */
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
    tier TEXT,
    source TEXT,
    tranco_rank INTEGER
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
    staff_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  );
`;

// [id, name, canonical_domain, tier, source, tranco_rank]
const BRANDS: Array<[string, string, string, string, string | null, number | null]> = [
  // The brands the lookalikes were generated FOR.
  ["brand_zoom", "Zoom Video", "zoom.us", "monitored", "tranco", 79],
  ["brand_icloud", "iCloud", "icloud.com", "monitored", "tranco", 57],
  ["brand_bing", "Bing", "bing.com", "monitored", "tranco", 33],
  ["brand_cloudflare", "Cloudflare", "cloudflare.com", "monitored", "tranco", 4],
  ["brand_paypal", "PayPal", "paypal.com", "monitored", "tranco", 50],
  // Prod rows behind the three false HIGH alerts — all TRUSTED.
  ["brand_zoom_com", "Zoom", "zoom.com", "tracked", "tranco", 786],
  ["brand_cloud_com", "Cloud", "cloud.com", "tracked", "tranco", 1660],
  ["brand_ing", "ING", "ing.com", "tracked", "manual", null],
  // UNTRUSTED owners.
  ["brand_cloudfare", "Cloudfare", "cloudfare.com", "tracked", "tranco", 55323],
  ["brand_ai", "PayPal", "paypa1.com", "monitored", "ai_attributed", null],
  ["brand_self", "Paypai", "paypai.com", "tracked", "self_service", null],
  ["brand_assess", "Paypal Secure", "paypal-secure.com", "tracked", "public_assess", null],
  // ai_attributed is never trusted, even with a (forged) top rank or customer tier.
  ["brand_ai_ranked", "Evil", "evil-ranked.com", "customer", "ai_attributed", 10],
  // Trusted via the other clauses.
  ["brand_customer", "Cust", "cust.example", "customer", null, null],
  ["brand_curated", "Cur", "curated.example", "tracked", "curated", null],
  ["brand_nullsrc", "Null", "nullsrc.example", "monitored", null, null],
];

interface Harness {
  db: Sqlite;
  DB: D1Database;
  /** Bind count of every statement that touched brand_safe_domains. */
  lookupBinds: number[];
  /** SQL text of the last such statement. */
  lastLookupSql: () => string;
  row(brandId: string, domain: string): Record<string, unknown> | undefined;
  alert(id: string | null): Record<string, unknown>;
}

function harness(): Harness {
  const db = new DatabaseSync!(":memory:");
  db.exec(DDL);
  db.exec(SAFE_DOMAINS_DDL);
  applyLookalikeSchema(db);

  for (const b of BRANDS) {
    db.prepare(
      `INSERT INTO brands (id, name, canonical_domain, tier, source, tranco_rank) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(...b);
  }
  // [id, brand, domain, source]
  for (const s of [
    ["s1", "brand_zoom_com", "zoom.com", "auto_detected"],
    ["s2", "brand_zoom_com", "*.zoom.com", "auto_detected"],
    ["s3", "brand_ai", "paypa1.com", "auto_detected"],
    ["s4", "brand_ing", "ing.com", "manual"],
    ["s5", "brand_paypal", "paypal-corp.example", "csv_upload"],
  ]) {
    db.prepare(`INSERT INTO brand_safe_domains (id, brand_id, domain, source) VALUES (?, ?, ?, ?)`).run(...s);
  }

  const lookupBinds: number[] = [];
  let lastSql = "";
  type Bound = { sql: string; params: unknown[] };
  const DB = {
    prepare(sql: string) {
      const wrap = (params: unknown[]) => ({
        sql,
        params,
        async all<T>() {
          if (sql.includes("brand_safe_domains")) {
            lookupBinds.push(params.length);
            lastSql = sql;
          }
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
  return {
    db,
    DB: DB as unknown as D1Database,
    lookupBinds,
    lastLookupSql: () => lastSql,
    row: (brandId, domain) =>
      db.prepare(`SELECT * FROM lookalike_domains WHERE brand_id = ? AND domain = ?`).get(brandId, domain) as
        Record<string, unknown> | undefined,
    alert: (id) => db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id) as Record<string, unknown>,
  };
}

let seq = 0;
function seedLookalikeRow(h: Harness, brandId: string, domain: string, over: Record<string, unknown> = {}): void {
  seq += 1;
  const r: Record<string, unknown> = {
    id: `l_${seq}`, brand_id: brandId, domain, permutation_type: "tld_swap",
    registered: 1, status: "monitoring", check_due_at: "2026-10-06 00:00:00",
    last_check_failed_at: "2026-10-01 00:00:00", ...over,
  };
  const cols = Object.keys(r);
  h.db.prepare(`INSERT INTO lookalike_domains (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => r[c] as null));
}

function insertAlert(h: Harness, id: string, brandId: string, alertType: string, details: object, createdAt: string, staffNotes: string | null = null) {
  h.db.prepare(
    `INSERT INTO alerts (id, brand_id, user_id, alert_type, severity, title, summary, details, source_type, source_id, created_at, staff_notes)
     VALUES (?, ?, 'system', ?, 'high', 't', 's', ?, 'lookalike_scanner', ?, ?, ?)`,
  ).run(id, brandId, alertType, JSON.stringify(details), `l_${id}`, createdAt, staffNotes);
}

describe.skipIf(!hasSqlite())("official-domain lookup — trust predicate and plan", () => {
  it("computes `trusted` per the documented predicate", async () => {
    const h = harness();
    const rows = await loadOfficialDomainMatches(h.DB, BRANDS.map((b) => b[2]).concat(["paypal-corp.example"]));
    const canon = Object.fromEntries(rows.filter((r) => r.source === "canonical_domain").map((r) => [r.domain, Number(r.trusted)]));
    expect(canon).toMatchObject({
      "zoom.com": 1, "cloud.com": 1, "ing.com": 1, // tranco <= 20000 / manual
      "cust.example": 1, "curated.example": 1, // customer tier / curated
      "cloudfare.com": 0, // tranco 55,323 — a typosquat in the catalog
      "paypa1.com": 0, "paypai.com": 0, "paypal-secure.com": 0, // ai_attributed / self_service / public_assess
      "evil-ranked.com": 0, // ai_attributed loses even with rank 10 + customer tier
      "nullsrc.example": 0, // NULL source, unranked, not customer
    });
    const safe = Object.fromEntries(rows.filter((r) => r.source === "safe_domain").map((r) => [r.domain, Number(r.trusted)]));
    expect(safe).toMatchObject({ "zoom.com": 0, "paypa1.com": 0, "ing.com": 1, "paypal-corp.example": 1 });
  });

  it("one alert = one statement, an index search on both tables", async () => {
    const h = harness();
    await loadOfficialDomainMatches(h.DB, ["zoom.com"]);
    expect(h.lookupBinds).toEqual([3]); // zoom.com + *.zoom.com (safe), zoom.com (canonical)
    const plan = (h.db.prepare(`EXPLAIN QUERY PLAN ${h.lastLookupSql()}`).all("zoom.com", "*.zoom.com", "zoom.com") as Array<{ detail: string }>)
      .map((r) => r.detail).join("\n");
    expect(plan).toMatch(/SEARCH s USING INDEX idx_safe_domains_domain/);
    expect(plan).toMatch(/SEARCH b USING (?:COVERING )?INDEX idx_brands_domain/);
    expect(plan).not.toMatch(/SCAN (?:s|b)\b/);
  });
});

describe.skipIf(!hasSqlite())("runAlertTriageBackfill — lookalike family", () => {
  it("dismisses the three known false HIGH alerts and parks their rows benign; refuses everything untrusted or new", async () => {
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com");
    seedLookalikeRow(h, "brand_icloud", "cloud.com");
    seedLookalikeRow(h, "brand_bing", "ing.com");
    seedLookalikeRow(h, "brand_cloudflare", "cloudfare.com");
    seedLookalikeRow(h, "brand_paypal", "paypa1.com");
    seedLookalikeRow(h, "brand_zoom", "zoom.co", { registration_evidence: "nrd" });

    let t = 0;
    const at = () => `2026-10-01 00:00:${String(++t).padStart(2, "0")}`;
    insertAlert(h, "a-zoom", "brand_zoom", "lookalike_domain_active", { lookalike_domain: "zoom.com" }, at());
    insertAlert(h, "a-cloud", "brand_icloud", "lookalike_domain_active", { lookalike_domain: "cloud.com" }, at());
    insertAlert(h, "a-ing", "brand_bing", "lookalike_domain_active", { lookalike_domain: "ing.com" }, at());
    insertAlert(h, "a-bimi", "brand_zoom", "typosquat_bimi", { domain: "zoom.com" }, at());
    // Refusals.
    insertAlert(h, "a-newreg", "brand_zoom", "lookalike_domain_active", { lookalike_domain: "zoom.com", new_registration: true }, at());
    insertAlert(h, "a-tranco", "brand_cloudflare", "lookalike_domain_active", { lookalike_domain: "cloudfare.com" }, at());
    insertAlert(h, "a-ai", "brand_paypal", "lookalike_domain_active", { lookalike_domain: "paypa1.com" }, at());
    insertAlert(h, "a-self", "brand_paypal", "lookalike_domain_active", { lookalike_domain: "paypai.com" }, at());
    insertAlert(h, "a-assess", "brand_paypal", "lookalike_domain_active", { lookalike_domain: "paypal-secure.com" }, at(), "analyst: looking at this");
    insertAlert(h, "a-squat", "brand_zoom", "lookalike_domain_active", { lookalike_domain: "zoom-us.com" }, at());

    const res = await runAlertTriageBackfill(h.DB, { limit: 500 });
    expect(res.scanned).toBe(10);
    expect(res.by_type).toEqual({
      lookalike_domain_active: { scanned: 9, dismissed: 3, kept: 6 },
      typosquat_bimi: { scanned: 1, dismissed: 1, kept: 0 },
    });
    expect(h.lookupBinds, "whole batch's official lookup is one statement").toHaveLength(1);

    expect(h.alert("a-zoom")).toMatchObject({ status: "false_positive", resolution_notes: "auto: zoom.com is the official domain of Zoom" });
    expect(h.alert("a-cloud")).toMatchObject({ status: "false_positive", resolution_notes: "auto: cloud.com is the official domain of Cloud" });
    expect(h.alert("a-ing")).toMatchObject({ status: "false_positive", resolution_notes: "auto: ing.com is the official domain of ING" });
    expect(h.alert("a-bimi").status).toBe("false_positive");

    // Lookalike rows: benign, reasoned, parked with no failure stamp (the
    // un-park sweep only re-admits rows with one) — Sparrow skips benign.
    for (const [b, d, brand] of [["brand_zoom", "zoom.com", "Zoom"], ["brand_icloud", "cloud.com", "Cloud"], ["brand_bing", "ing.com", "ING"]]) {
      expect(h.row(b!, d!)).toMatchObject({
        status: "benign",
        status_reason: `auto: ${d} is the official domain of ${brand}`,
        check_due_at: null,
        last_check_failed_at: null,
      });
    }

    // Refused: all stay 'new', with no resolution note.
    for (const id of ["a-newreg", "a-tranco", "a-ai", "a-self", "a-assess", "a-squat"]) {
      expect(h.alert(id), id).toMatchObject({ status: "new", resolution_notes: null });
    }
    // Possible-owner notes, internal only, never over a human note.
    expect(h.alert("a-tranco").staff_notes).toBe("possible official domain of Cloudfare (cloudfare.com) — unverified");
    expect(h.alert("a-ai").staff_notes).toBe("possible official domain of PayPal (paypa1.com) — unverified");
    expect(h.alert("a-self").staff_notes).toBe("possible official domain of Paypai (paypai.com) — unverified");
    expect(h.alert("a-assess").staff_notes).toBe("analyst: looking at this");
    expect(h.alert("a-newreg").staff_notes).toMatch(/newly registered/);
    expect(h.alert("a-squat").staff_notes).toBeNull();
    // Refused rows untouched.
    expect(h.row("brand_cloudflare", "cloudfare.com")).toMatchObject({ status: "monitoring", status_reason: null });
    expect(h.row("brand_paypal", "paypa1.com")).toMatchObject({ status: "monitoring" });

    // Idempotent.
    const again = await runAlertTriageBackfill(h.DB, { limit: 500 });
    expect(again.dismissed).toBe(0);
  });

  it("refuses a page-analysis alert whose row carries NRD registration evidence", async () => {
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com", { registration_evidence: "nrd" });
    insertAlert(h, "a1", "brand_zoom", "lookalike_domain_active", { lookalike_domain: "zoom.com", discovered_by: "page_analysis" }, "2026-10-01 00:00:01");
    await runAlertTriageBackfill(h.DB, { limit: 500 });
    expect(h.alert("a1").status).toBe("new");
    expect(h.row("brand_zoom", "zoom.com")!.status).toBe("monitoring");
  });

  it("never overwrites an analyst's disposition on the lookalike row", async () => {
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com", { status: "confirmed_threat" });
    insertAlert(h, "a1", "brand_zoom", "lookalike_domain_active", { lookalike_domain: "zoom.com" }, "2026-10-01 00:00:01");
    await runAlertTriageBackfill(h.DB, { limit: 500 });
    expect(h.alert("a1").status).toBe("false_positive");
    expect(h.row("brand_zoom", "zoom.com")).toMatchObject({ status: "confirmed_threat", status_reason: null });
  });
});

describe.skipIf(!hasSqlite())("createAlert real-time hook — lookalike family", () => {
  const base = { brandId: "brand_zoom", userId: "system", alertType: "lookalike_domain_active" as const, severity: "high" as const, title: "t", summary: "s", sourceType: "lookalike_scanner" };

  it("files a trusted official-domain lookalike already dismissed and parks its row benign", async () => {
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com");
    const id = await createAlert(h.DB, { ...base, details: { lookalike_domain: "zoom.com" }, sourceId: "l1" });
    expect(h.alert(id)).toMatchObject({ status: "false_positive", resolution_notes: "auto: zoom.com is the official domain of Zoom" });
    expect(h.row("brand_zoom", "zoom.com")).toMatchObject({ status: "benign", check_due_at: null });
  });

  it("keeps a new-registration alert and an untrusted match 'new'", async () => {
    const h = harness();
    const nr = await createAlert(h.DB, { ...base, details: { lookalike_domain: "zoom.com", new_registration: true }, sourceId: "l1" });
    const ut = await createAlert(h.DB, { ...base, brandId: "brand_cloudflare", details: { lookalike_domain: "cloudfare.com" }, sourceId: "l2" });
    expect(h.alert(nr).status).toBe("new");
    expect(h.alert(ut)).toMatchObject({ status: "new", staff_notes: "possible official domain of Cloudfare (cloudfare.com) — unverified" });
  });

  it("still creates the alert as 'new' when the lookup throws (F5)", async () => {
    const h = harness();
    h.db.exec(`DROP TABLE brand_safe_domains`);
    const id = await createAlert(h.DB, { ...base, details: { lookalike_domain: "zoom.com" }, sourceId: "l1" });
    expect(id).toBeTruthy();
    expect(h.alert(id)).toMatchObject({ status: "new", resolution_notes: null });
  });
});

describe.skipIf(!hasSqlite())("generateAndStoreLookalikes — trusted official domains stored benign", () => {
  it.each([
    ["brand_zoom", "zoom.us", "zoom.com", "Zoom"],
    ["brand_icloud", "icloud.com", "cloud.com", "Cloud"],
    ["brand_bing", "bing.com", "ing.com", "ING"],
  ])("%s (%s) stores %s as benign + parked, not dropped", async (brandId, domain, official, brand) => {
    const h = harness();
    expect(generatePermutations(domain).map((p) => p.domain), "precondition: dnstwist generates it").toContain(official);

    const created = await generateAndStoreLookalikes({ DB: h.DB } as unknown as Env, brandId, domain);
    expect(created, "nothing is dropped").toBe(generatePermutations(domain).length);
    expect(h.row(brandId, official)).toMatchObject({
      status: "benign",
      status_reason: `auto: ${official} is the official domain of ${brand}`,
      check_due_at: null,
      last_check_failed_at: null,
    });
    const due = h.db.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains WHERE brand_id = ? AND status = 'monitoring' AND check_due_at IS NOT NULL`,
    ).get(brandId) as { n: number };
    expect(due.n, "every other permutation is due as before").toBe(created - 1);
    for (const n of h.lookupBinds) expect(n).toBeLessThanOrEqual(99);
  });

  it("an UNTRUSTED match (Tranco typosquat cloudfare.com) seeds normally", async () => {
    const h = harness();
    await generateAndStoreLookalikes({ DB: h.DB } as unknown as Env, "brand_cloudflare", "cloudflare.com");
    expect(h.row("brand_cloudflare", "cloudfare.com")).toMatchObject({ status: "monitoring", status_reason: null });
    expect(h.row("brand_cloudflare", "cloudfare.com")!.check_due_at).not.toBeNull();
  });

  it("fails open: a lookup error still seeds every permutation normally", async () => {
    const h = harness();
    h.db.exec(`DROP TABLE brand_safe_domains`);
    const created = await generateAndStoreLookalikes({ DB: h.DB } as unknown as Env, "brand_zoom", "zoom.us");
    expect(created).toBe(generatePermutations("zoom.us").length);
    expect(h.row("brand_zoom", "zoom.com")!.status).toBe("monitoring");
  });

  it("chunks a large host list at <=99 binds per statement", async () => {
    const h = harness();
    await loadOfficialDomainMatches(h.DB, Array.from({ length: 200 }, (_, i) => `host${i}.example`));
    expect(h.lookupBinds.length).toBe(Math.ceil(200 / 33));
    for (const n of h.lookupBinds) expect(n).toBeLessThanOrEqual(99);
  });
});

describe.skipIf(!hasSqlite())("PATCH /api/lookalikes/:id — reverting an auto-benign row", () => {
  const ctx = { userId: "u1", email: "a@x", role: "super_admin", orgId: null, orgRole: null } as unknown as AuthContext;
  const patch = (h: Harness, id: string, body: object) =>
    handleUpdateLookalike(
      new Request("https://x/api/lookalikes/" + id, { method: "PATCH", body: JSON.stringify(body) }),
      { DB: h.DB } as unknown as Env, id, ctx,
    );

  it("clears status_reason and un-parks an auto-benign row set back to monitoring", async () => {
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com", {
      id: "l_auto", status: "benign", status_reason: "auto: zoom.com is the official domain of Zoom",
      check_due_at: null, last_check_failed_at: null,
    });
    const res = await patch(h, "l_auto", { status: "monitoring" });
    expect(res.status).toBe(200);
    const row = h.row("brand_zoom", "zoom.com")!;
    expect(row).toMatchObject({ status: "monitoring", status_reason: null });
    expect(row.check_due_at).not.toBeNull();
  });

  it("leaves a ladder-parked row (no reason) parked, and clears a reason on any status change", async () => {
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.co", { id: "l_ladder", check_due_at: null });
    await patch(h, "l_ladder", { status: "monitoring" });
    expect(h.row("brand_zoom", "zoom.co")!.check_due_at).toBeNull();

    seedLookalikeRow(h, "brand_zoom", "zoom.com", {
      id: "l_auto2", status: "benign", status_reason: "auto: x", check_due_at: null, last_check_failed_at: null,
    });
    await patch(h, "l_auto2", { status: "confirmed_threat" });
    expect(h.row("brand_zoom", "zoom.com")).toMatchObject({ status: "confirmed_threat", status_reason: null, check_due_at: null });
  });
});

const SRC = (rel: string) => readFileSync(resolve(__dirname, "..", "src", rel), "utf8");

describe.skipIf(!hasSqlite())("review fixes (PR #1796)", () => {
  it("B1: a phantom-matcher alert observed in the NRD feed is never dismissed", async () => {
    const h = harness();
    const rows = await loadOfficialDomainMatches(h.DB, ["zoom.com"]);
    expect(decideLookalikeRegistrationTriage({ domain: "zoom.com", matched_source: "nrd" }, { officialRows: rows }))
      .toMatchObject({ action: "keep", reason: "newly_registered_domain" });
    // A CT-observed phantom is not a registration event — still dismissed.
    expect(decideLookalikeRegistrationTriage({ domain: "zoom.com", matched_source: "ct" }, { officialRows: rows }).action)
      .toBe("dismiss");
  });

  it("B2: Flight Control's parked gauge counts ladder parks only, not auto-benign parks", () => {
    const fc = SRC("agents/flightControl.ts");
    const m = fc.match(/'backlog\.lookalike_parked'[^`]*`([^`]*)`/);
    expect(m, "gauge SQL found").not.toBeNull();
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com", { status: "benign", status_reason: "auto: x", check_due_at: null, last_check_failed_at: null });
    seedLookalikeRow(h, "brand_zoom", "zoom.co", { check_due_at: null, last_check_failed_at: "2026-09-01 00:00:00" });
    const n = (h.db.prepare(m![1]).get() as { count: number }).count;
    expect(n).toBe(1);
    const plan = (h.db.prepare(`EXPLAIN QUERY PLAN ${m![1]}`).all() as Array<{ detail: string }>).map((r) => r.detail).join("\n");
    expect(plan).toContain("idx_lookalike_parked");
  });

  it("L1: an NRD claim reverts an AUTO-benign row to monitoring; human benign stays benign", () => {
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com", {
      id: "auto", status: "benign", status_reason: "auto: zoom.com is the official domain of Zoom",
      check_due_at: null, last_check_failed_at: null, registered: 0,
    });
    seedLookalikeRow(h, "brand_icloud", "cloud.com", { id: "human", status: "benign", check_due_at: null, registered: 0 });
    for (const id of ["auto", "human"]) {
      h.db.prepare(NRD_LOOKALIKE_CLAIM_SQL).run("2026-10-04 00:00:00", "1970-01-01 00:00:00", id, "2026-10-04 00:00:00");
    }
    expect(h.row("brand_zoom", "zoom.com")).toMatchObject({ status: "monitoring", status_reason: null, registration_evidence: "nrd" });
    expect(h.row("brand_icloud", "cloud.com")).toMatchObject({ status: "benign", registration_evidence: "nrd" });
  });

  it("L1: the observed-registration path reverts an AUTO-benign row before filing", () => {
    const src = SRC("scanners/lookalike-domains.ts");
    const body = src.slice(src.indexOf("async function fileConfirmedRegistration("));
    expect(body.indexOf("revertAutoBenignOnRegistration(env, row)")).toBeGreaterThan(0);
    expect(body.indexOf("revertAutoBenignOnRegistration(env, row)")).toBeLessThan(body.indexOf("claimRegistrationAlert(env, row.id)"));
    expect(src).toMatch(/WHERE id = \? AND status = 'benign' AND status_reason LIKE 'auto:%'/);
  });

  it("appsec L2: dynamic-DNS / tunnel suffixes are shared hosting", () => {
    for (const d of ["x.ddns.net", "x.hopto.org", "x.zapto.org", "x.no-ip.com", "x.no-ip.org", "x.no-ip.biz",
      "x.mooo.com", "x.duckdns.org", "x.dynu.net", "x.freedns.afraid.org", "x.ngrok.app", "x.ngrok-free.app",
      "x.ngrok.io", "x.localtunnel.me", "x.trycloudflare.com"]) {
      expect(isUnderSharedHosting(d), d).toBe(true);
    }
    expect(isUnderSharedHosting("afraid.org")).toBe(false);
  });

  it("L3: 'Scan now' never enqueues benign rows", () => {
    const src = SRC("handlers/lookalikeDomains.ts");
    const start = src.indexOf("SET check_due_at = '1970-01-01 00:00:00'");
    const sql = "UPDATE lookalike_domains\n       " + src.slice(start, src.indexOf("`", start));
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com", { status: "benign", status_reason: "auto: x", check_due_at: null, last_check_failed_at: null });
    seedLookalikeRow(h, "brand_zoom", "zoom.co", { check_due_at: null });
    h.db.prepare(sql).run("brand_zoom", 100);
    expect(h.row("brand_zoom", "zoom.com")!.check_due_at).toBeNull();
    expect(h.row("brand_zoom", "zoom.co")!.check_due_at).toBe("1970-01-01 00:00:00");
  });

  it("L4: backfill leaves the lookalike row alone when a human moved the alert first", async () => {
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com");
    insertAlert(h, "a1", "brand_zoom", "lookalike_domain_active", { lookalike_domain: "zoom.com" }, "2026-10-01 00:00:01");
    // Race: the alert is acknowledged between the backfill's SELECT and its UPDATE.
    const DB = {
      prepare(sql: string) {
        const st = h.DB.prepare(sql);
        if (!/UPDATE alerts[\s\S]*false_positive/.test(sql)) return st;
        return { ...st, bind: (...p: unknown[]) => {
          h.db.prepare(`UPDATE alerts SET status = 'acknowledged' WHERE id = 'a1'`).run();
          return st.bind(...p);
        } };
      },
    } as unknown as D1Database;
    await runAlertTriageBackfill(DB, { limit: 500 });
    expect(h.alert("a1").status).toBe("acknowledged");
    expect(h.row("brand_zoom", "zoom.com")).toMatchObject({ status: "monitoring", status_reason: null });
  });

  it("L6: registration evidence on ANY brand's row for the domain blocks dismissal", async () => {
    const h = harness();
    seedLookalikeRow(h, "brand_zoom", "zoom.com");
    seedLookalikeRow(h, "brand_icloud", "zoom.com", { registration_evidence: "observed" });
    insertAlert(h, "a1", "brand_zoom", "lookalike_domain_active", { lookalike_domain: "zoom.com" }, "2026-10-01 00:00:01");
    await runAlertTriageBackfill(h.DB, { limit: 500 });
    expect(h.alert("a1").status).toBe("new");
    const id = await createAlert(h.DB, {
      brandId: "brand_zoom", userId: "system", alertType: "lookalike_domain_active", severity: "high",
      title: "t", summary: "s", sourceType: "lookalike_scanner", sourceId: "l9", details: { lookalike_domain: "zoom.com" },
    });
    expect(h.alert(id).status).toBe("new");
    expect(h.row("brand_zoom", "zoom.com")!.status).toBe("monitoring");
  });
});

describe.skipIf(!hasSqlite())("A1: safe-domain writes — gate, audit, 404", () => {
  function auditHarness() {
    const h = harness();
    h.db.exec(`INSERT INTO users (id) VALUES ('u1')`);
    const audits: Array<{ action: string; user_id: string; resource_id: string; details: Record<string, unknown> }> = [];
    const AUDIT_DB = {
      prepare: () => ({
        bind: (...p: unknown[]) => ({
          run: async () => {
            audits.push({ user_id: p[1] as string, action: p[2] as string, resource_id: p[4] as string, details: JSON.parse(p[5] as string) });
            return { meta: {} };
          },
        }),
      }),
    };
    const env = { DB: h.DB, AUDIT_DB } as unknown as Env;
    const req = (body?: object) => new Request("https://x/", { method: "POST", body: body ? JSON.stringify(body) : undefined });
    return { h, env, audits, req };
  }

  it("routes gate every write on manage_takedowns (reads stay requireStaff)", () => {
    const src = SRC("routes/brands.ts");
    for (const route of [
      'router.post("/api/brands/:id/safe-domains",',
      'router.post("/api/brands/:id/safe-domains/bulk",',
      'router.delete("/api/brands/:id/safe-domains/:domainId",',
    ]) {
      const at = src.indexOf(route);
      expect(at, route).toBeGreaterThan(0);
      expect(src.slice(at, at + 300), route).toContain('requirePermission("manage_takedowns")');
    }
    const get = src.indexOf('router.get("/api/brands/:id/safe-domains",');
    expect(src.slice(get, get + 300)).toContain("requireStaff(request, env)");
  });

  it("404s a nonexistent brand on add, bulk add and delete — no row written", async () => {
    const { h, env, audits, req } = auditHarness();
    expect((await handleAddSafeDomain(req({ domain: "x.example" }), env, "nope", "u1")).status).toBe(404);
    expect((await handleBulkAddSafeDomains(req({ domains: ["x.example"] }), env, "nope", "u1")).status).toBe(404);
    expect((await handleDeleteSafeDomain(req(), env, "nope", "s1", "u1")).status).toBe(404);
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM brand_safe_domains WHERE brand_id = 'nope'`).get()).toMatchObject({ n: 0 });
    expect(audits).toEqual([]);
  });

  it("audits add, bulk add and delete with actor, brand, domain and source", async () => {
    const { h, env, audits, req } = auditHarness();
    expect((await handleAddSafeDomain(req({ domain: "Zoom-Corp.example" }), env, "brand_zoom", "u1")).status).toBe(201);
    expect((await handleBulkAddSafeDomains(req({ domains: ["a.example", "b.example", "bad"] }), env, "brand_zoom", "u1")).status).toBe(201);
    const row = h.db.prepare(`SELECT id FROM brand_safe_domains WHERE domain = 'a.example'`).get() as { id: string };
    expect((await handleDeleteSafeDomain(req(), env, "brand_zoom", row.id, "u1")).status).toBe(200);
    expect(audits).toEqual([
      expect.objectContaining({ action: "safe_domain_add", user_id: "u1", resource_id: "brand_zoom",
        details: expect.objectContaining({ brand_id: "brand_zoom", domain: "zoom-corp.example", source: "manual" }) }),
      expect.objectContaining({ action: "safe_domain_bulk_add", user_id: "u1",
        details: expect.objectContaining({ brand_id: "brand_zoom", source: "csv_upload", added: 2, domains: ["a.example", "b.example"] }) }),
      expect.objectContaining({ action: "safe_domain_delete", user_id: "u1",
        details: expect.objectContaining({ brand_id: "brand_zoom", domain: "a.example", source: "csv_upload" }) }),
    ]);
  });
});
