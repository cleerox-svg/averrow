import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import {
  handleTenantAlertDetail,
  handleTenantUpdateAlert,
  handleTenantBulkUpdateAlerts,
} from "../src/handlers/tenantData";
import { handleCreateTakedown } from "../src/handlers/takedowns";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

// FIX 3 (appsec) — view-layer cross-org exec-PII isolation.
//
// A brand is many-to-many with orgs. Org A registers exec "Jane Doe" under
// brand X and the exec-monitor cron writes an `executive_impersonation`
// alert stamped org_id = A. Brand X is ALSO monitored by org B. The
// brand-scoped tenant paths must NOT surface (or let B mutate) that alert,
// while brand-wide alerts (org_id NULL — phishing/threat-feed/…) stay
// visible to BOTH orgs.
//
// No SQL engine in this harness, so the fake D1 APPLIES the org predicate
// itself from the captured binds AND only when the query actually contains
// `a.org_id IS NULL OR a.org_id = ?` — so removing the predicate from a
// handler (regression) makes these tests fail.

const ORG_A: AuthContext = {
  userId: "uA", email: "a@x.com", role: "client",
  orgId: "1", orgRole: "analyst", embeddedScope: undefined,
};
const ORG_B: AuthContext = {
  userId: "uB", email: "b@x.com", role: "client",
  orgId: "2", orgRole: "analyst", embeddedScope: undefined,
};

interface AlertFix {
  id: string;
  brand_id: string;
  org_id: number | null;
  status?: string;
  title?: string;
  summary?: string;
}

function makeEnv(opts: {
  alerts: AlertFix[];
  orgBrands: Record<string, number[]>; // brand_id -> owning org_ids
}): Env {
  const isAlertOrgQuery = (sql: string) =>
    sql.includes("FROM alerts a") && sql.includes("JOIN org_brands");
  const hasOrgPredicate = (sql: string) =>
    sql.includes("a.org_id IS NULL OR a.org_id = ?");

  const visible = (row: AlertFix, orgNum: number, sql: string): boolean => {
    const members = opts.orgBrands[row.brand_id] ?? [];
    if (!members.includes(orgNum)) return false; // org_brands join
    if (hasOrgPredicate(sql) && row.org_id !== null && row.org_id !== orgNum) return false;
    return true;
  };

  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const api = {
        bind(...b: unknown[]) {
          binds = b;
          return api;
        },
        async first<T>() {
          // Single-row ownership / detail query:
          //   binds = [orgId(str), alertId, Number(orgId)]
          if (isAlertOrgQuery(sql)) {
            const orgNum = Number(binds[0] as string);
            const alertId = binds[1] as string;
            const row = opts.alerts.find((a) => a.id === alertId);
            if (!row || !visible(row, orgNum, sql)) return null as T;
            return {
              ...row,
              current_status: row.status ?? "new",
              brand_name: "BrandShared",
              brand_domain: "shared.example",
            } as T;
          }
          return null as T; // users / org_members lookups → null
        },
        async all<T>() {
          // Bulk owned query: binds = [orgId, ...ids, Number(orgId)]
          if (isAlertOrgQuery(sql)) {
            const orgNum = Number(binds[0] as string);
            const ids = binds.slice(1, -1) as string[];
            const rows = opts.alerts
              .filter((a) => ids.includes(a.id) && visible(a, orgNum, sql))
              .map((a) => ({ id: a.id }));
            return { results: rows as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return api;
    },
  };
  // No AUDIT_DB — audit() swallows its own errors, so writes still return.
  return { DB: db as unknown as D1Database } as unknown as Env;
}

const FIXTURE = {
  alerts: [
    { id: "al-exec", brand_id: "brand-shared", org_id: 1, status: "new", title: "impersonating Jane Doe" },
    { id: "al-phish", brand_id: "brand-shared", org_id: null, status: "new", title: "phishing site" },
  ] as AlertFix[],
  orgBrands: { "brand-shared": [1, 2] }, // BOTH orgs monitor the shared brand
};

function detailReq(): Request {
  return new Request("https://api.local/", { method: "GET" });
}
function patchReq(bodyObj: Record<string, unknown>): Request {
  return new Request("https://api.local/", {
    method: "PATCH",
    body: JSON.stringify(bodyObj),
    headers: { "content-type": "application/json" },
  });
}

describe("tenant alert detail read — org-private exec alert isolation (FIX 3)", () => {
  it("org A (owner) CAN read its own executive_impersonation alert", async () => {
    const env = makeEnv(FIXTURE);
    const res = await handleTenantAlertDetail(detailReq(), env, "1", "al-exec", ORG_A);
    expect(res.status).toBe(200);
  });

  it("org B (co-monitors the brand) CANNOT read org A's executive_impersonation alert", async () => {
    const env = makeEnv(FIXTURE);
    const res = await handleTenantAlertDetail(detailReq(), env, "2", "al-exec", ORG_B);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it("a brand-wide (org_id NULL) alert stays visible to BOTH orgs (no over-restriction)", async () => {
    const env = makeEnv(FIXTURE);
    const a = await handleTenantAlertDetail(detailReq(), env, "1", "al-phish", ORG_A);
    const b = await handleTenantAlertDetail(detailReq(), env, "2", "al-phish", ORG_B);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe("tenant alert write — org B cannot mutate org A's exec alert (FIX 3)", () => {
  it("org B update of org A's exec alert is blocked (404)", async () => {
    const env = makeEnv(FIXTURE);
    const res = await handleTenantUpdateAlert(
      patchReq({ status: "acknowledged" }), env, "2", "al-exec", ORG_B,
    );
    expect(res.status).toBe(404);
  });

  it("org A update of its own exec alert succeeds (200)", async () => {
    const env = makeEnv(FIXTURE);
    const res = await handleTenantUpdateAlert(
      patchReq({ status: "acknowledged" }), env, "1", "al-exec", ORG_A,
    );
    expect(res.status).toBe(200);
  });

  it("org B bulk-update of org A's exec alert touches 0 rows", async () => {
    const env = makeEnv(FIXTURE);
    const res = await handleTenantBulkUpdateAlerts(
      patchReq({ alert_ids: ["al-exec"], status: "acknowledged" }), env, "2", ORG_B,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { updated: number } };
    expect(body.data.updated).toBe(0);
  });

  it("org A bulk-update of its own exec alert touches it", async () => {
    const env = makeEnv(FIXTURE);
    const res = await handleTenantBulkUpdateAlerts(
      patchReq({ alert_ids: ["al-exec"], status: "acknowledged" }), env, "1", ORG_A,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { updated: number } };
    expect(body.data.updated).toBe(1);
  });
});

// ─── FIX 5 — takedown evidence-fetch org isolation ───────────────
// handleCreateTakedown auto-fills evidence from a cited alert scoped only
// by brand_id. A co-monitoring org B must not be able to copy org A's
// exec-impersonation evidence (which embeds the exec's name) into its own
// takedown. The org-private predicate must gate that evidence SELECT.
describe("takedown create — cited exec-alert evidence is org-isolated (FIX 5)", () => {
  interface TkAlert { id: string; brand_id: string; org_id: number | null; severity: string; summary: string; ai_assessment: string | null; }

  function makeTakedownEnv(opts: { alerts: TkAlert[]; orgBrands: Record<string, number[]> }) {
    const inserts: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const api = {
          bind(...b: unknown[]) { binds = b; return api; },
          async first<T>() {
            if (sql.includes("FROM org_brands") && sql.includes("brand_id = ?")) {
              const orgNum = Number(binds[0] as string);
              const brandId = binds[1] as string;
              return ((opts.orgBrands[brandId] ?? []).includes(orgNum) ? { ok: 1 } : null) as T;
            }
            if (sql.includes("FROM alerts") && sql.includes("severity, summary, ai_assessment")) {
              // binds = [source_id, brandId, Number(orgId)]
              const alertId = binds[0] as string;
              const brandId = binds[1] as string;
              const orgNum = binds[2] as number;
              const hasPredicate = sql.includes("org_id IS NULL OR org_id = ?");
              const row = opts.alerts.find((a) => a.id === alertId && a.brand_id === brandId);
              if (!row) return null as T;
              if (hasPredicate && row.org_id !== null && row.org_id !== orgNum) return null as T;
              return { severity: row.severity, summary: row.summary, ai_assessment: row.ai_assessment } as T;
            }
            return null as T;
          },
          async run() {
            if (sql.includes("INSERT INTO takedown_requests")) inserts.push(binds);
            return { meta: { changes: 1 } };
          },
          async all<T>() { return { results: [] as T[] }; },
        };
        return api;
      },
    };
    // No AUDIT_DB — audit() swallows its own errors.
    return { env: { DB: db as unknown as D1Database } as unknown as Env, inserts };
  }

  const TK_FIXTURE = {
    alerts: [
      { id: "al-exec", brand_id: "brand-shared", org_id: 1, severity: "high", summary: "Fake profile impersonating Jane Doe (CEO)", ai_assessment: "likely impersonation" },
      { id: "al-phish", brand_id: "brand-shared", org_id: null, severity: "critical", summary: "Phishing page harvesting credentials", ai_assessment: null },
    ] as TkAlert[],
    orgBrands: { "brand-shared": [1, 2] },
  };

  function createReq(bodyObj: Record<string, unknown>): Request {
    return new Request("https://api.local/", {
      method: "POST",
      body: JSON.stringify(bodyObj),
      headers: { "content-type": "application/json" },
    });
  }

  // evidence_detail is bind index 10 in the takedown_requests INSERT.
  const EVIDENCE_DETAIL_IDX = 10;

  it("org A citing its own exec alert copies the exec evidence into the takedown", async () => {
    const { env, inserts } = makeTakedownEnv(TK_FIXTURE);
    const res = await handleCreateTakedown(
      createReq({ brand_id: "brand-shared", target_type: "url", target_value: "http://evil", evidence_summary: "manual", source_type: "alert", source_id: "al-exec" }),
      env, "1", ORG_A,
    );
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(String(inserts[0]![EVIDENCE_DETAIL_IDX])).toContain("Jane Doe");
  });

  it("org B citing org A's exec alert gets NO exec evidence (predicate returns nothing, no crash)", async () => {
    const { env, inserts } = makeTakedownEnv(TK_FIXTURE);
    const res = await handleCreateTakedown(
      createReq({ brand_id: "brand-shared", target_type: "url", target_value: "http://evil", evidence_summary: "manual", source_type: "alert", source_id: "al-exec" }),
      env, "2", ORG_B,
    );
    // Create is not rejected, but the evidence SELECT returned nothing, so
    // org A's exec PII was NOT copied into org B's takedown.
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![EVIDENCE_DETAIL_IDX]).toBeNull();
  });

  it("a NULL-org_id alert on the shared brand is citable by BOTH orgs", async () => {
    const a = makeTakedownEnv(TK_FIXTURE);
    const resA = await handleCreateTakedown(
      createReq({ brand_id: "brand-shared", target_type: "url", target_value: "http://evil", evidence_summary: "manual", source_type: "alert", source_id: "al-phish" }),
      a.env, "1", ORG_A,
    );
    const b = makeTakedownEnv(TK_FIXTURE);
    const resB = await handleCreateTakedown(
      createReq({ brand_id: "brand-shared", target_type: "url", target_value: "http://evil", evidence_summary: "manual", source_type: "alert", source_id: "al-phish" }),
      b.env, "2", ORG_B,
    );
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(String(a.inserts[0]![EVIDENCE_DETAIL_IDX])).toContain("Phishing page");
    expect(String(b.inserts[0]![EVIDENCE_DETAIL_IDX])).toContain("Phishing page");
  });
});
