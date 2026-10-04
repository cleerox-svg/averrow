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
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { signJWT } from "../src/lib/jwt";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env, JWTPayload, UserRole } from "../src/types";

const SECRET = "test-secret-ops-alerts-platform-wide";

const TABLES = ["users", "brands", "alerts", "threats", "saas_techniques", "takedown_requests"];

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
      expect((data.by_brand as unknown[]).length).toBe(3);
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

    it(`${role}: PATCH assignment records previous + new assignee`, async () => {
      const res = await call(role, "/api/alerts/a_low_new", "PATCH", { assigned_to: `u_${role}` });
      expect(res.status).toBe(200);
      const row = raw.prepare("SELECT assigned_to, assigned_at FROM alerts WHERE id = 'a_low_new'").all()[0] as Record<string, unknown>;
      expect(row.assigned_to).toBe(`u_${role}`);
      expect(row.assigned_at).not.toBeNull();
      const entry = audits.find((a) => a.bound.includes("alert_update"))!;
      expect(JSON.parse(String(entry.bound[5]))).toMatchObject({ previous_assigned_to: null, assigned_to: `u_${role}` });
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
      const { data } = await res.json<{ data: { takedowns_created: number; alerts_acknowledged: number } }>();
      expect(data).toEqual({ takedowns_created: 2, alerts_acknowledged: 2 });
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
});
