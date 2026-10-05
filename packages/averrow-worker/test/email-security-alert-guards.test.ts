/**
 * Email-security alert guards (review fix, G4 follow-up).
 *
 *  (a) The ANONYMOUS public check (GET /api/v1/public/email-security/:domain)
 *      must never create alerts or emit alert.created, and never write brand
 *      state (which would silently consume a BIMI/DMARC transition).
 *  (b) The BIMI families dedup: bimi_removed / dmarc_downgraded ≤1 per brand
 *      per 24h; vmc_expiring ≤1 per brand per expiry_date per 7 days.
 *
 * The DNS scan is mocked; everything else is real (node:sqlite with the
 * migration-derived schema). The `bimi_*` brand columns exist in prod out
 * of band (no migration adds them), so the test adds them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const emitOrgEvent = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../src/lib/org-events", () => ({
  emitOrgEvent: (...args: unknown[]) => emitOrgEvent(...args),
}));

const vmcExpiry = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
const scanResult = {
  domain: "acme.example",
  score: 40,
  grade: "A",
  dmarc: { exists: true, policy: "none" },
  bimi: { record: null, svg_url: null, vmc_url: "https://vmc.example/c.pem", vmc_valid: true, vmc_expiry: vmcExpiry, grade: "C" },
};
vi.mock("../src/email-security", () => ({
  runEmailSecurityScan: async () => scanResult,
  saveEmailSecurityScan: async () => {},
}));

const { handleScanBrandEmailSecurity, handlePublicEmailSecurity } = await import("../src/handlers/emailSecurity");

describe.skipIf(!hasSqlite())("email-security alert guards (real SQLite)", () => {
  let raw: SqliteDb;
  let env: Env;

  const resetBrandState = () =>
    raw.prepare("UPDATE brands SET bimi_record = 'v=BIMI1; l=x', email_security_grade = 'A' WHERE id = 'b1'").run();
  const countAlerts = (type: string) =>
    (raw.prepare("SELECT COUNT(*) AS n FROM alerts WHERE alert_type = ?").all(type) as Array<{ n: number }>)[0]!.n;

  beforeEach(() => {
    raw = openDerivedDb(["brands", "alerts", "org_brands"]);
    for (const col of ["bimi_record", "bimi_svg_url", "bimi_vmc_url", "bimi_vmc_valid", "bimi_vmc_expiry", "bimi_grade", "bimi_last_checked"]) {
      raw.exec(`ALTER TABLE brands ADD COLUMN ${col} TEXT`);
    }
    raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b1', 'Acme', 'acme.example', 'customer')").run();
    raw.prepare("INSERT INTO org_brands (org_id, brand_id) VALUES (1, 'b1')").run();
    resetBrandState();
    env = { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;
    emitOrgEvent.mockClear();
  });

  it("(a) the anonymous public check creates no alerts, emits nothing, writes no brand state", async () => {
    const res = await handlePublicEmailSecurity(new Request("https://averrow.com/api/v1/public/email-security/acme.example"), env, "acme.example");
    expect(res.status).toBe(200);
    expect(countAlerts("bimi_removed") + countAlerts("dmarc_downgraded") + countAlerts("vmc_expiring")).toBe(0);
    expect(emitOrgEvent).not.toHaveBeenCalled();
    const brand = raw.prepare("SELECT bimi_record, email_security_grade FROM brands WHERE id = 'b1'").all() as Array<Record<string, unknown>>;
    expect(brand[0]).toEqual({ bimi_record: "v=BIMI1; l=x", email_security_grade: "A" });
  });

  it("(b) repeated staff scans raise each BIMI family once inside its window", async () => {
    const pending: Promise<unknown>[] = [];
    const execCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
    const scan = () => handleScanBrandEmailSecurity(new Request("https://averrow.com/api/email-security/scan/b1", { method: "POST" }), env, "b1", execCtx);

    expect((await scan()).status).toBe(200);
    expect(countAlerts("bimi_removed")).toBe(1);
    expect(countAlerts("dmarc_downgraded")).toBe(1);
    expect(countAlerts("vmc_expiring")).toBe(1);

    // Same transitions observed again (state reset) — all deduped.
    resetBrandState();
    await scan();
    resetBrandState();
    await scan();
    expect(countAlerts("bimi_removed")).toBe(1);
    expect(countAlerts("dmarc_downgraded")).toBe(1);
    expect(countAlerts("vmc_expiring")).toBe(1);

    // Delivery went through the request's waitUntil, once per created alert.
    await Promise.all(pending);
    expect(emitOrgEvent).toHaveBeenCalledTimes(3);
  });

  it("(b) a renewed certificate (new expiry_date) may alert again", async () => {
    await handleScanBrandEmailSecurity(new Request("https://averrow.com/x", { method: "POST" }), env, "b1");
    raw.prepare("UPDATE alerts SET details = json_set(details, '$.expiry_date', '2000-01-01') WHERE alert_type = 'vmc_expiring'").run();
    resetBrandState();
    await handleScanBrandEmailSecurity(new Request("https://averrow.com/x", { method: "POST" }), env, "b1");
    expect(countAlerts("vmc_expiring")).toBe(2);
  });
});
