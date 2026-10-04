// PR-C: ops alerts are platform-wide for staff and actionable only by
// `edit_alerts` holders.
//
// Real router (registerDashboardRoutes) + real guards (signed JWTs through
// requireAuth / requireStaff / requirePermission) + real handlers, against an
// in-memory SQLite whose schema is DERIVED from migrations/
// (test/sqlite-d1-harness.ts) — a phantom column fails the test.
//
// Fixture: alerts stamped with several DIFFERENT tenant users (the way
// lib/alert-fanout.ts stamps them) across several brands. No alert belongs to
// any staff caller, so before PR-C (`a.user_id = ?` pin) every staff read was
// empty and every mutation 404'd / updated 0 rows.

import { describe, it, expect, beforeEach } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { handleTenantAlerts, handleTenantAlertDetail, AVERROW_SOC_LABEL } from "../src/handlers/tenantData";
import type { AuthContext } from "../src/middleware/auth";
import { deriveSchema, splitStatements } from "./migration-schema";
import { signJWT } from "../src/lib/jwt";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env, JWTPayload, UserRole } from "../src/types";

const SECRET = "test-secret-ops-alerts-platform-wide";

const TABLES = ["users", "brands", "alerts", "threats", "saas_techniques", "takedown_requests", "org_brands"];

const STAFF_ROLES: UserRole[] = ["super_admin", "admin", "analyst", "sales", "support", "billing", "auditor"];
const EDITORS: UserRole[] = ["super_admin", "admin", "analyst", "support"];
const NON_EDITOR_STAFF: UserRole[] = ["sales", "billing", "auditor"];
// bulk-takedown creates takedown_requests → needs edit_alerts AND manage_takedowns.
const TAKEDOWN_EDITORS: UserRole[] = ["super_admin", "admin", "analyst"];

// users.role CHECK admits only super_admin/admin/analyst/client; requireAuth
// reads only `status` back, the role comes from the signed JWT.
const DB_ROLE: Record<UserRole, string> = {
  super_admin: "super_admin", admin: "admin", analyst: "analyst",
  sales: "analyst", support: "analyst", billing: "analyst", auditor: "analyst", client: "client",
};

// Seeded alerts. Created-at offsets are minutes ago (larger = older).
// a_crit_new_newest is the expected triage `top`: most severe, then newest.
const ALERTS: Array<{ id: string; brand: string; user: string; severity: string; status: string; minsAgo: number }> = [
  { id: "a_low_new",          brand: "b1", user: "t_alice", severity: "low",      status: "new",          minsAgo: 1 },
  { id: "a_high_new",         brand: "b2", user: "t_bob",   severity: "high",     status: "new",          minsAgo: 2 },
  { id: "a_crit_new_old",     brand: "b1", user: "t_carol", severity: "critical", status: "new",          minsAgo: 60 },
  { id: "a_crit_new_newest",  brand: "b3", user: "t_bob",   severity: "critical", status: "new",          minsAgo: 10 },
  { id: "a_med_ack",          brand: "b2", user: "t_alice", severity: "medium",   status: "acknowledged", minsAgo: 5 },
  { id: "a_high_resolved",    brand: "b3", user: "t_carol", severity: "high",     status: "resolved",     minsAgo: 3 },
];
const NEW_COUNT = ALERTS.filter((a) => a.status === "new").length; // 4
const CRITICAL_NEW = ALERTS.filter((a) => a.status === "new" && a.severity === "critical").length; // 2

function ts(minsAgo: number): string {
  return new Date(Date.now() - minsAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");
}

function seed(db: SqliteDb): void {
  db.exec(`
    INSERT INTO brands (id, name, canonical_domain) VALUES
      ('b1', 'Brand One', 'one.example'),
      ('b2', 'Brand Two', 'two.example'),
      ('b3', 'Brand Three', 'three.example');
  `);
  const roles: UserRole[] = [...STAFF_ROLES, "client"];
  for (const role of roles) {
    db.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, ?, 'active')")
      .run(`u_${role}`, `${role}@averrow.local`, role, DB_ROLE[role]);
  }
  for (const t of ["t_alice", "t_bob", "t_carol"]) {
    db.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, 'client', 'active')")
      .run(t, `${t}@cust.example`, t);
  }
  const ins = db.prepare(
    `INSERT INTO alerts (id, brand_id, user_id, alert_type, severity, title, summary, status, created_at, updated_at)
     VALUES (?, ?, ?, 'phishing_detected', ?, ?, 'summary', ?, ?, ?)`,
  );
  for (const a of ALERTS) ins.run(a.id, a.brand, a.user, a.severity, `Alert ${a.id}`, a.status, ts(a.minsAgo), ts(a.minsAgo));
}

interface AuditCall { sql: string; bound: unknown[] }

function auditDb(calls: AuditCall[]): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...bound: unknown[]) => ({
        run: async () => {
          calls.push({ sql, bound });
          return { success: true, meta: {} };
        },
      }),
    }),
  } as unknown as D1Database;
}

let raw: SqliteDb;
let env: Env;
let kv: ReturnType<typeof fakeKv>;
let audits: AuditCall[];
let router: RouterType<IRequest>;

function payloadFor(role: UserRole): Omit<JWTPayload, "iat" | "exp"> {
  const p: Omit<JWTPayload, "iat" | "exp"> = { sub: `u_${role}`, email: `${role}@averrow.local`, role };
  if (role === "client") {
    p.org_id = "7";
    p.org_role = "admin";
    p.org_scope = { org_id: 7, brand_ids: ["b1"] };
  }
  return p;
}

async function call(role: UserRole, path: string, method = "GET", body?: unknown): Promise<Response> {
  const token = await signJWT(payloadFor(role), SECRET, 300);
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return (await router.fetch(new Request(`https://averrow.com${path}`, init), env)) as Response;
}

function statusOf(id: string): string {
  const rows = raw.prepare("SELECT status FROM alerts WHERE id = ?").all(id) as Array<{ status: string }>;
  return rows[0]!.status;
}

describe.skipIf(!hasSqlite())("PR-C: ops alerts are platform-wide for staff", () => {
  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    seed(raw);
    const d1 = d1FromSqlite(raw);
    const withSession = () => ({ prepare: (sql: string) => d1.prepare(sql), getBookmark: () => null });
    kv = fakeKv();
    audits = [];
    env = {
      JWT_SECRET: SECRET,
      DB: Object.assign(d1, { withSession }),
      CACHE: kv,
      AUDIT_DB: auditDb(audits),
    } as unknown as Env;
    router = Router();
    registerDashboardRoutes(router);
  });

  for (const role of STAFF_ROLES) {
    it(`${role}: list returns every alert, severity-ordered then newest`, async () => {
      const res = await call(role, "/api/alerts?limit=50");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Array<{ id: string; severity: string }>; total: number }>();
      expect(body.total).toBe(ALERTS.length);
      expect(body.data.map((a) => a.id)).toEqual([
        "a_crit_new_newest", "a_crit_new_old",
        "a_high_new", "a_high_resolved",
        "a_med_ack",
        "a_low_new",
      ]);
    });

    it(`${role}: get reaches an alert owned by a tenant user`, async () => {
      const res = await call(role, "/api/alerts/a_high_new");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { id: string; brand_name: string } }>();
      expect(body.data.id).toBe("a_high_new");
      expect(body.data.brand_name).toBe("Brand Two");
    });

    it(`${role}: stats count the whole platform`, async () => {
      const res = await call(role, "/api/alerts/stats");
      expect(res.status).toBe(200);
      const { data } = await res.json<{ data: Record<string, unknown> }>();
      expect(data.total).toBe(ALERTS.length);
      expect(data.new_count).toBe(NEW_COUNT);
      expect(data.critical).toBe(2);
      expect(data.high).toBe(2);
      expect(data.auto_dismissed).toBe(0);
      // by_brand (unbounded GROUP BY, unused by ops) was dropped.
      expect(data).not.toHaveProperty("by_brand");
    });

    it(`${role}: triage-summary is platform-wide with the most-severe-newest top`, async () => {
      const res = await call(role, "/api/alerts/triage-summary");
      expect(res.status).toBe(200);
      const body = await res.json<{ success: boolean; data: Record<string, unknown> }>();
      expect(body).toEqual({
        success: true,
        data: {
          new_count: NEW_COUNT,
          critical_count: CRITICAL_NEW,
          top: {
            id: "a_crit_new_newest",
            title: "Alert a_crit_new_newest",
            severity: "critical",
            brand_id: "b3",
            brand_name: "Brand Three",
            alert_type: "phishing_detected",
            created_at: ts(10),
          },
        },
      });
      expect([...kv.store.keys()]).toContain("alerts_triage:global");
    });
  }

  it("triage-summary top is null when nothing is new", async () => {
    raw.exec("UPDATE alerts SET status = 'acknowledged'");
    const { data } = await (await call("admin", "/api/alerts/triage-summary")).json<{ data: Record<string, unknown> }>();
    expect(data).toEqual({ new_count: 0, critical_count: 0, top: null });
  });

  for (const role of EDITORS) {
    it(`${role}: PATCH acts on any tenant's alert and is audited with the actor`, async () => {
      const res = await call(role, "/api/alerts/a_high_new", "PATCH", { status: "acknowledged" });
      expect(res.status).toBe(200);
      expect(statusOf("a_high_new")).toBe("acknowledged");
      const entry = audits.find((a) => a.bound.includes("alert_update"));
      expect(entry, "alert_update audit row").toBeDefined();
      expect(entry!.bound[1]).toBe(`u_${role}`); // user_id = who acted
      expect(entry!.bound[4]).toBe("a_high_new");
      expect(JSON.parse(String(entry!.bound[5]))).toMatchObject({ previous_status: "new", new_status: "acknowledged" });
    });

    it(`${role}: PATCH staff claim writes staff_assigned_to, never the customer's assigned_to`, async () => {
      const res = await call(role, "/api/alerts/a_low_new", "PATCH", { staff_assigned_to: `u_${role}` });
      expect(res.status).toBe(200);
      const row = raw.prepare("SELECT assigned_to, assigned_at, staff_assigned_to, staff_assigned_at FROM alerts WHERE id = 'a_low_new'").all()[0] as Record<string, unknown>;
      expect(row.staff_assigned_to).toBe(`u_${role}`);
      expect(row.staff_assigned_at).not.toBeNull();
      expect(row.assigned_to).toBeNull();
      expect(row.assigned_at).toBeNull();
      const entry = audits.find((a) => a.bound.includes("alert_update"))!;
      expect(JSON.parse(String(entry.bound[5]))).toMatchObject({ previous_staff_assigned_to: null, staff_assigned_to: `u_${role}` });
    });

    it(`${role}: bulk-acknowledge by ids spans tenants`, async () => {
      const res = await call(role, "/api/alerts/bulk-acknowledge", "POST", { alert_ids: ["a_low_new", "a_high_new", "a_med_ack"] });
      expect(res.status).toBe(200);
      const { data } = await res.json<{ data: { updated: number } }>();
      expect(data.updated).toBe(2); // a_med_ack was already acknowledged
      expect(statusOf("a_low_new")).toBe("acknowledged");
      expect(statusOf("a_high_new")).toBe("acknowledged");
      expect(audits.some((a) => a.bound.includes("alert_bulk_acknowledge") && a.bound[1] === `u_${role}`)).toBe(true);
    });

    it(`${role}: bulk-acknowledge by brand covers every tenant user's alerts`, async () => {
      const res = await call(role, "/api/alerts/bulk-acknowledge", "POST", { brand_id: "b1" });
      expect(res.status).toBe(200);
      const { data } = await res.json<{ data: { updated: number } }>();
      expect(data.updated).toBe(2); // a_low_new (alice) + a_crit_new_old (carol)
    });

  }

  for (const role of TAKEDOWN_EDITORS) {
    it(`${role}: bulk-takedown resolves alerts from any tenant`, async () => {
      const res = await call(role, "/api/alerts/bulk-takedown", "POST", { alert_ids: ["a_high_new", "a_crit_new_old"] });
      expect(res.status).toBe(200);
      const { data } = await res.json<{ data: { takedowns_created: number; alerts_acknowledged: number; alert_ids: string[]; remaining: number } }>();
      expect(data.takedowns_created).toBe(2);
      expect(data.alerts_acknowledged).toBe(2);
      expect([...data.alert_ids].sort()).toEqual(["a_crit_new_old", "a_high_new"]);
      expect(data.remaining).toBe(0);
      const n = raw.prepare("SELECT COUNT(*) AS n FROM takedown_requests").all()[0] as { n: number };
      expect(n.n).toBe(2);
      expect(audits.some((a) => a.bound.includes("alert_bulk_takedown") && a.bound[1] === `u_${role}`)).toBe(true);
    });
  }

  it("support (edit_alerts but no manage_takedowns): bulk-takedown is 403 and creates nothing", async () => {
    const res = await call("support", "/api/alerts/bulk-takedown", "POST", { alert_ids: ["a_high_new", "a_crit_new_old"] });
    expect(res.status).toBe(403);
    const body = await res.json<{ success: boolean; error: string }>();
    expect(body).toEqual({ success: false, error: "Forbidden: requires 'manage_takedowns' permission" });
    const n = raw.prepare("SELECT COUNT(*) AS n FROM takedown_requests").all()[0] as { n: number };
    expect(n.n).toBe(0);
    expect(statusOf("a_high_new")).toBe("new");
    expect(statusOf("a_crit_new_old")).toBe("new");
    expect(audits).toEqual([]);
  });

  for (const role of NON_EDITOR_STAFF) {
    it(`${role}: every alert mutation is 403 and nothing changes`, async () => {
      const results = [
        await call(role, "/api/alerts/a_high_new", "PATCH", { status: "acknowledged" }),
        await call(role, "/api/alerts/bulk-acknowledge", "POST", { alert_ids: ["a_high_new"] }),
        await call(role, "/api/alerts/bulk-takedown", "POST", { alert_ids: ["a_high_new"] }),
      ];
      expect(results.map((r) => r.status)).toEqual([403, 403, 403]);
      expect(statusOf("a_high_new")).toBe("new");
      expect(audits).toEqual([]);
    });
  }

  it("client is 403 on every /api/alerts route, read or write", async () => {
    const results = [
      await call("client", "/api/alerts"),
      await call("client", "/api/alerts/a_low_new"),
      await call("client", "/api/alerts/stats"),
      await call("client", "/api/alerts/triage-summary"),
      await call("client", "/api/alerts/a_low_new", "PATCH", { status: "acknowledged" }),
      await call("client", "/api/alerts/bulk-acknowledge", "POST", { alert_ids: ["a_low_new"] }),
      await call("client", "/api/alerts/bulk-takedown", "POST", { alert_ids: ["a_low_new"] }),
    ];
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect(statusOf("a_low_new")).toBe("new");
  });

  it("a PATCH drops the cached triage summary + stats, so the next read reflects it", async () => {
    const before = await (await call("analyst", "/api/alerts/triage-summary")).json<{ data: { new_count: number; critical_count: number; top: { id: string } } }>();
    expect(before.data.new_count).toBe(NEW_COUNT);
    expect(before.data.top.id).toBe("a_crit_new_newest");
    await call("analyst", "/api/alerts/stats");
    expect(kv.store.has("alerts_triage:global")).toBe(true);
    expect(kv.store.has("alerts_stats:global")).toBe(true);

    // A different staff member acts — the shared global cache must drop.
    const patch = await call("support", "/api/alerts/a_crit_new_newest", "PATCH", { status: "resolved" });
    expect(patch.status).toBe(200);
    expect(kv.store.has("alerts_triage:global")).toBe(false);
    expect(kv.store.has("alerts_stats:global")).toBe(false);

    const after = await (await call("analyst", "/api/alerts/triage-summary")).json<{ data: { new_count: number; critical_count: number; top: { id: string } } }>();
    expect(after.data.new_count).toBe(NEW_COUNT - 1);
    expect(after.data.critical_count).toBe(CRITICAL_NEW - 1);
    expect(after.data.top.id).toBe("a_crit_new_old");

    const stats = await (await call("analyst", "/api/alerts/stats")).json<{ data: { new_count: number; resolved: number } }>();
    expect(stats.data.new_count).toBe(NEW_COUNT - 1);
    expect(stats.data.resolved).toBe(2);
  });

  it("a bulk-acknowledge also drops the cached triage summary", async () => {
    await call("admin", "/api/alerts/triage-summary");
    expect(kv.store.has("alerts_triage:global")).toBe(true);
    await call("admin", "/api/alerts/bulk-acknowledge", "POST", { brand_id: "b3" });
    const after = await (await call("admin", "/api/alerts/triage-summary")).json<{ data: { new_count: number; top: { id: string } } }>();
    expect(after.data.new_count).toBe(NEW_COUNT - 1);
    expect(after.data.top.id).toBe("a_crit_new_old");
  });

  // ─── PR-C review fixes ──────────────────────────────────────────────

  function auditDetails(action: string): Record<string, unknown> {
    const entry = audits.find((a) => a.bound.includes(action));
    expect(entry, `${action} audit row`).toBeDefined();
    return JSON.parse(String(entry!.bound[5])) as Record<string, unknown>;
  }

  /** Seed `n` extra status='new' alerts on `brand` (all owned by a tenant user). */
  function seedNew(brand: string, n: number, prefix = "bulk"): void {
    const ins = raw.prepare(
      `INSERT INTO alerts (id, brand_id, user_id, alert_type, severity, title, summary, status, created_at, updated_at)
       VALUES (?, ?, 't_alice', 'phishing_detected', 'medium', ?, 'summary', 'new', ?, ?)`,
    );
    for (let i = 0; i < n; i++) ins.run(`${prefix}_${i}`, brand, `Bulk ${i}`, ts(100 + i), ts(100 + i));
  }

  function count(sql: string): number {
    return (raw.prepare(sql).all()[0] as { n: number }).n;
  }

  describe("staff assignment + notes", () => {
    it("PATCH with assigned_to is 400 and changes nothing", async () => {
      const res = await call("admin", "/api/alerts/a_low_new", "PATCH", { assigned_to: "u_admin", status: "acknowledged" });
      expect(res.status).toBe(400);
      const body = await res.json<{ success: boolean; error: string }>();
      expect(body.error).toMatch(/staff_assigned_to/);
      expect(statusOf("a_low_new")).toBe("new");
      expect(audits).toEqual([]);
    });

    it("staff_assigned_to must be an active staff user (client / unknown / suspended → 400)", async () => {
      raw.prepare("INSERT INTO users (id, email, name, role, status) VALUES ('u_gone', 'gone@averrow.local', 'gone', 'analyst', 'suspended')").run();
      for (const bad of ["t_alice", "u_client", "u_nope", "u_gone", "", 42]) {
        const res = await call("admin", "/api/alerts/a_low_new", "PATCH", { staff_assigned_to: bad });
        expect(res.status, String(bad)).toBe(400);
      }
      const row = raw.prepare("SELECT staff_assigned_to FROM alerts WHERE id = 'a_low_new'").all()[0] as Record<string, unknown>;
      expect(row.staff_assigned_to).toBeNull();
    });

    it("any staff user (even a non-editor role) can be the staff assignee; null releases the claim", async () => {
      expect((await call("admin", "/api/alerts/a_low_new", "PATCH", { staff_assigned_to: "u_sales" })).status).toBe(200);
      expect((await call("admin", "/api/alerts/a_low_new", "PATCH", { staff_assigned_to: null })).status).toBe(200);
      const row = raw.prepare("SELECT staff_assigned_to, staff_assigned_at FROM alerts WHERE id = 'a_low_new'").all()[0] as Record<string, unknown>;
      expect(row).toEqual({ staff_assigned_to: null, staff_assigned_at: null });
    });

    it("notes go to staff_notes (never resolution_notes); audit notes truncated to 500", async () => {
      const longNote = "n".repeat(1200);
      const res = await call("analyst", "/api/alerts/a_high_new", "PATCH", { status: "resolved", notes: longNote });
      expect(res.status).toBe(200);
      const row = raw.prepare("SELECT status, resolved_at, resolution_notes, staff_notes FROM alerts WHERE id = 'a_high_new'").all()[0] as Record<string, unknown>;
      expect(row.status).toBe("resolved");
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolution_notes).toBeNull();
      expect(row.staff_notes).toBe(longNote);
      const d = auditDetails("alert_update");
      expect(String(d.staff_notes)).toHaveLength(500);
    });

    it("notes alone is a valid PATCH; over 4000 chars is 400", async () => {
      expect((await call("analyst", "/api/alerts/a_high_new", "PATCH", { notes: "triaged" })).status).toBe(200);
      expect(statusOf("a_high_new")).toBe("new");
      expect((await call("analyst", "/api/alerts/a_high_new", "PATCH", { notes: "x".repeat(4001) })).status).toBe(400);
    });

    it("get-by-id carries the customer assignee name, the staff assignee + notes, and the SaaS technique columns", async () => {
      raw.exec("UPDATE alerts SET assigned_to = 't_alice' WHERE id = 'a_high_new'");
      await call("admin", "/api/alerts/a_high_new", "PATCH", { staff_assigned_to: "u_analyst", notes: "internal: checking registrar" });
      const res = await call("support", "/api/alerts/a_high_new");
      expect(res.status).toBe(200);
      const { data } = await res.json<{ data: Record<string, unknown> }>();
      expect(data).toMatchObject({
        id: "a_high_new",
        assigned_to: "t_alice",
        assigned_to_name: "t_alice",
        assigned_to_email: "t_alice@cust.example",
        staff_assigned_to: "u_analyst",
        staff_assigned_to_name: "analyst",
        staff_assigned_to_email: "analyst@averrow.local",
        staff_notes: "internal: checking registrar",
      });
      expect(data.staff_assigned_at).not.toBeNull();
      for (const k of ["saas_technique_id", "saas_technique_name", "saas_technique_phase", "saas_technique_phase_label", "saas_technique_severity"]) {
        expect(data, k).toHaveProperty(k);
      }
    });

    it("list rows carry staff_assigned_to_name + staff_notes", async () => {
      await call("admin", "/api/alerts/a_low_new", "PATCH", { staff_assigned_to: "u_admin", notes: "mine" });
      const { data } = await (await call("analyst", "/api/alerts?limit=50")).json<{ data: Array<Record<string, unknown>> }>();
      const row = data.find((a) => a.id === "a_low_new")!;
      expect(row).toMatchObject({ staff_assigned_to: "u_admin", staff_assigned_to_name: "admin", staff_notes: "mine", assigned_to: null });
    });
  });

  describe("tenant view of staff actions", () => {
    const TENANT: AuthContext = {
      userId: "t_alice", email: "t_alice@cust.example", role: "client",
      orgId: "7", orgRole: "admin", embeddedScope: undefined,
    } as AuthContext;

    beforeEach(() => {
      raw.exec("INSERT INTO org_brands (org_id, brand_id) VALUES (7, 'b1'), (7, 'b2')");
    });

    async function tenantList(): Promise<Array<Record<string, unknown>>> {
      const res = await handleTenantAlerts(new Request("https://averrow.com/api/orgs/7/alerts"), env, "7", TENANT);
      expect(res.status).toBe(200);
      return (await res.json<{ data: Array<Record<string, unknown>> }>()).data;
    }
    async function tenantDetail(id: string): Promise<Record<string, unknown>> {
      const res = await handleTenantAlertDetail(new Request(`https://averrow.com/api/orgs/7/alerts/${id}`), env, "7", id, TENANT);
      expect(res.status).toBe(200);
      return (await res.json<{ data: Record<string, unknown> }>()).data;
    }

    it("a staff claim shows as 'Averrow SOC'; no staff_* key, staff name or staff note reaches the customer", async () => {
      await call("analyst", "/api/alerts/a_high_new", "PATCH", { status: "investigating", staff_assigned_to: "u_analyst", notes: "SECRET-STAFF-NOTE" });

      const list = await tenantList();
      const detail = await tenantDetail("a_high_new");
      for (const view of [list.find((a) => a.id === "a_high_new")!, detail]) {
        expect(view.status).toBe("investigating"); // staff status changes ARE visible
        expect(view.assigned_to).toBeNull();
        expect(view.assigned_to_name).toBe(AVERROW_SOC_LABEL);
        expect(view.handled_by_averrow).toBe(true);
        expect(view.resolution_notes ?? null).toBeNull();
        expect(Object.keys(view).filter((k) => k.startsWith("staff_"))).toEqual([]);
        const text = JSON.stringify(view);
        expect(text).not.toContain("SECRET-STAFF-NOTE");
        expect(text).not.toContain("u_analyst");
        expect(text).not.toContain("analyst@averrow.local");
      }
      // Alerts staff never touched: no label, flag false.
      const untouched = list.find((a) => a.id === "a_low_new")!;
      expect(untouched).toMatchObject({ handled_by_averrow: false, assigned_to_name: null });
    });

    it("the customer's own assignee is untouched and wins over the staff claim", async () => {
      raw.exec("UPDATE alerts SET assigned_to = 't_bob', assigned_at = datetime('now') WHERE id = 'a_low_new'");
      await call("admin", "/api/alerts/a_low_new", "PATCH", { staff_assigned_to: "u_admin" });
      const row = raw.prepare("SELECT assigned_to FROM alerts WHERE id = 'a_low_new'").all()[0] as Record<string, unknown>;
      expect(row.assigned_to).toBe("t_bob");
      const detail = await tenantDetail("a_low_new");
      expect(detail).toMatchObject({ assigned_to: "t_bob", assigned_to_name: "t_bob", handled_by_averrow: true });
      expect(Object.keys(detail).filter((k) => k.startsWith("staff_"))).toEqual([]);
    });
  });

  describe("bulk caps (D1 100-bind limit)", () => {
    const tooMany = Array.from({ length: 91 }, (_, i) => `x_${i}`);

    it("more than 90 alert_ids → 400 on both bulk endpoints, nothing changes", async () => {
      for (const path of ["/api/alerts/bulk-acknowledge", "/api/alerts/bulk-takedown"]) {
        const res = await call("admin", path, "POST", { alert_ids: [...tooMany, "a_low_new"] });
        expect(res.status, path).toBe(400);
        expect((await res.json<{ error: string }>()).error).toMatch(/at most 90/);
      }
      expect(statusOf("a_low_new")).toBe("new");
      expect(count("SELECT COUNT(*) AS n FROM takedown_requests")).toBe(0);
    });

    it("exactly 90 ids is accepted", async () => {
      seedNew("b2", 90);
      const ids = Array.from({ length: 90 }, (_, i) => `bulk_${i}`);
      const res = await call("admin", "/api/alerts/bulk-acknowledge", "POST", { alert_ids: ids });
      expect(res.status).toBe(200);
      expect((await res.json<{ data: { updated: number } }>()).data.updated).toBe(90);
    });

    it("brand-wide acknowledge caps at 90, returns remaining, audits the affected ids", async () => {
      seedNew("b1", 95); // + a_low_new + a_crit_new_old already new on b1 = 97
      const first = await call("admin", "/api/alerts/bulk-acknowledge", "POST", { brand_id: "b1" });
      expect(first.status).toBe(200);
      const d1 = (await first.json<{ data: { updated: number; remaining: number; alert_ids: string[] } }>()).data;
      expect(d1.updated).toBe(90);
      expect(d1.remaining).toBe(7);
      expect(d1.alert_ids).toHaveLength(90);
      // most severe first: the critical b1 alert is in the first page
      expect(d1.alert_ids).toContain("a_crit_new_old");
      const ad = auditDetails("alert_bulk_acknowledge");
      expect(ad.affected_ids).toEqual(d1.alert_ids);
      expect((ad.affected_ids as unknown[]).every((x) => typeof x === "string")).toBe(true);

      const second = await call("admin", "/api/alerts/bulk-acknowledge", "POST", { brand_id: "b1" });
      const d2 = (await second.json<{ data: { updated: number; remaining: number } }>()).data;
      expect(d2).toMatchObject({ updated: 7, remaining: 0 });
      expect(count("SELECT COUNT(*) AS n FROM alerts WHERE brand_id = 'b1' AND status = 'new'")).toBe(0);
    });
  });

  describe("bulk takedown", () => {
    it("ids path skips resolved / false_positive / investigating alerts", async () => {
      raw.exec("UPDATE alerts SET status = 'false_positive' WHERE id = 'a_low_new'");
      raw.exec("UPDATE alerts SET status = 'investigating' WHERE id = 'a_crit_new_old'");
      const res = await call("admin", "/api/alerts/bulk-takedown", "POST", {
        alert_ids: ["a_high_resolved", "a_low_new", "a_crit_new_old", "a_med_ack", "a_high_new"],
      });
      expect(res.status).toBe(200);
      const { data } = await res.json<{ data: { takedowns_created: number; alerts_acknowledged: number; alert_ids: string[] } }>();
      expect(data.takedowns_created).toBe(2);
      expect([...data.alert_ids].sort()).toEqual(["a_high_new", "a_med_ack"]);
      expect(data.alerts_acknowledged).toBe(1); // a_med_ack was already acknowledged
      expect(statusOf("a_high_resolved")).toBe("resolved");
      expect(statusOf("a_low_new")).toBe("false_positive");
      expect(statusOf("a_crit_new_old")).toBe("investigating");
      const linked = raw.prepare("SELECT source_type, source_id FROM takedown_requests ORDER BY source_id").all();
      expect(linked).toEqual([
        { source_type: "alert", source_id: "a_high_new" },
        { source_type: "alert", source_id: "a_med_ack" },
      ]);
      expect(auditDetails("alert_bulk_takedown")).toMatchObject({ takedowns_created: 2 });
    });

    it("by brand: only new/acknowledged alerts, and a repeat call creates no duplicates", async () => {
      const res = await call("admin", "/api/alerts/bulk-takedown", "POST", { brand_id: "b3" });
      expect(res.status).toBe(200);
      const { data } = await res.json<{ data: { takedowns_created: number; alert_ids: string[]; remaining: number } }>();
      expect(data).toMatchObject({ takedowns_created: 1, alert_ids: ["a_crit_new_newest"], remaining: 0 });
      expect(statusOf("a_crit_new_newest")).toBe("acknowledged");
      expect(statusOf("a_high_resolved")).toBe("resolved");
      expect(auditDetails("alert_bulk_takedown").affected_ids).toEqual(["a_crit_new_newest"]);

      const again = await call("admin", "/api/alerts/bulk-takedown", "POST", { brand_id: "b3" });
      expect(again.status).toBe(404);
      expect(count("SELECT COUNT(*) AS n FROM takedown_requests")).toBe(1);
    });

    it("by brand: bounded to 90 per call with remaining", async () => {
      seedNew("b2", 95); // + a_high_new (new) + a_med_ack (ack) = 97 eligible
      const d1 = (await (await call("admin", "/api/alerts/bulk-takedown", "POST", { brand_id: "b2" }))
        .json<{ data: { takedowns_created: number; remaining: number } }>()).data;
      expect(d1).toMatchObject({ takedowns_created: 90, remaining: 7 });
      const d2 = (await (await call("admin", "/api/alerts/bulk-takedown", "POST", { brand_id: "b2" }))
        .json<{ data: { takedowns_created: number; remaining: number } }>()).data;
      expect(d2).toMatchObject({ takedowns_created: 7, remaining: 0 });
      expect(count("SELECT COUNT(*) AS n FROM takedown_requests")).toBe(97);
    });

    it("is atomic: takedown inserts + acknowledge share one batch, so a failing acknowledge rolls back every insert", async () => {
      // Make the harness batch transactional like D1's, and record what ran inside it.
      const batched: string[] = [];
      (env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch = async (stmts: unknown[]) => {
        raw.exec("BEGIN");
        try {
          const out: unknown[] = [];
          for (const s of stmts as Array<{ run: () => Promise<unknown>; __sql: string }>) {
            batched.push(s.__sql);
            out.push(await s.run());
          }
          raw.exec("COMMIT");
          return out;
        } catch (e) {
          raw.exec("ROLLBACK");
          throw e;
        }
      };
      raw.exec(`CREATE TRIGGER fail_ack BEFORE UPDATE OF status ON alerts
                BEGIN SELECT RAISE(ABORT, 'ack failed'); END;`);

      const res = await call("admin", "/api/alerts/bulk-takedown", "POST", { alert_ids: ["a_high_new", "a_crit_new_old"] });
      expect(res.status).toBe(500);
      expect(batched.filter((q) => q.includes("INSERT INTO takedown_requests"))).toHaveLength(2);
      expect(batched.some((q) => q.includes("UPDATE alerts SET status = 'acknowledged'"))).toBe(true);
      expect(count("SELECT COUNT(*) AS n FROM takedown_requests")).toBe(0);
      expect(statusOf("a_high_new")).toBe("new");
      expect(audits).toEqual([]);
    });
  });

  it("stats.auto_dismissed counts only `auto:`-stamped false positives", async () => {
    raw.exec(`UPDATE alerts SET status = 'false_positive', resolution_notes = 'auto: clean enrichment' WHERE id = 'a_low_new'`);
    raw.exec(`UPDATE alerts SET status = 'false_positive', resolution_notes = 'customer says benign' WHERE id = 'a_high_new'`);
    const { data } = await (await call("admin", "/api/alerts/stats")).json<{ data: Record<string, unknown> }>();
    expect(data.dismissed).toBe(2);
    expect(data.auto_dismissed).toBe(1);
  });
});

// ─── Migration 0275: additive only, applies to the pre-0275 shape ─────

describe.skipIf(!hasSqlite())("migration 0275 alert staff fields", () => {
  const file = readFileSync(new URL("../migrations/0275_alert_staff_fields.sql", import.meta.url), "utf8");
  const statements = splitStatements(file);
  const alters = statements.filter((s) => /^ALTER TABLE/i.test(s));
  const indexes = statements.filter((s) => /^CREATE INDEX/i.test(s));

  it("only ADD COLUMNs + CREATE INDEX IF NOT EXISTS (no DROP / column ALTER)", () => {
    expect(alters).toHaveLength(3);
    for (const a of alters) expect(a).toMatch(/^ALTER TABLE alerts ADD COLUMN staff_\w+ TEXT$/);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toMatch(/^CREATE INDEX IF NOT EXISTS/);
    expect(statements).toHaveLength(alters.length + indexes.length);
  });

  it("applies cleanly to the pre-0275 schema; the index statement is re-runnable", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };
    const db = new DatabaseSync(":memory:");
    const altersSet = new Set(alters.map((a) => `${a};`));
    for (const stmt of deriveSchema(["alerts", "takedown_requests"]).ddl) {
      if (!altersSet.has(stmt)) db.exec(stmt);
    }
    const colsBefore = (db.prepare("PRAGMA table_info(alerts)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(colsBefore).not.toContain("staff_assigned_to");
    for (const s of statements) db.exec(s);
    // D1 records applied migrations in d1_migrations and never re-runs a file
    // (ADD COLUMN itself can't be repeated in SQLite); the index is idempotent.
    for (const s of indexes) db.exec(s);
    const colsAfter = (db.prepare("PRAGMA table_info(alerts)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(colsAfter).toEqual(expect.arrayContaining(["staff_assigned_to", "staff_assigned_at", "staff_notes"]));
    const plan = (db.prepare(
      `EXPLAIN QUERY PLAN SELECT 1 FROM takedown_requests tr WHERE tr.source_type = 'alert' AND tr.source_id = ?`,
    ).all("a1") as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_takedown_requests_alert_source");
  });
});
