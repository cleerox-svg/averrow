// Staff are never named to a customer, and never write through the tenant
// alert routes (owner decision 2026-10-04; appsec follow-up to PR #1770).
//
//   B1 — tenant PATCH /alerts/:id and POST /alerts/bulk refuse platform-staff
//        callers (super_admin passes canPerformHITL + verifyOrgAccess, so
//        without the refusal it wrote resolution_notes / assigned_to, an
//        org-visible audit row with raw notes, and a customer webhook).
//   B3 — tenant reads mask a staff user in assigned_to as "Averrow SOC";
//        customers can't assign to staff (incl. the lead-conversion
//        placeholder super_admin); the tenant audit log masks staff actors.
//   O1 — ops bulk-takedown stamps takedown_requests.org_id from the alert;
//        tenant takedown PATCH refuses a takedown owned by another org, or by
//        no org (brand-wide org_id NULL rows: refused, never claimed).
//   F1 — tenant alert reads drop alerts.user_id (fan-out owner / staff scanner).
//   O-a — user ids inside audit details are masked whoever the actor is.
//   O-b — an actor with no users row is "Former user", notes dropped.
//   O-f — an assigned_to with no users row is masked, never echoed raw.
//   O-d — tenant takedown list/get hide another org's takedowns.
//
// Real handlers against in-memory SQLite whose schema is derived from
// migrations/ (test/sqlite-d1-harness.ts).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/lib/org-events", () => ({
  emitOrgEvent: vi.fn(async () => {}),
}));

import { emitOrgEvent } from "../src/lib/org-events";
import {
  handleTenantAlerts,
  handleTenantAlertDetail,
  handleTenantUpdateAlert,
  handleTenantBulkUpdateAlerts,
  handleTenantAuditLog,
  AVERROW_SOC_LABEL,
  FORMER_USER_LABEL,
  STAFF_TENANT_ALERT_WRITE_ERROR,
} from "../src/handlers/tenantData";
import { handleBulkTakedown } from "../src/handlers/alerts";
import { handleUpdateTakedown, handleListTakedowns, handleGetTakedown } from "../src/handlers/takedowns";
import type { AuthContext } from "../src/middleware/auth";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env, UserRole } from "../src/types";

const TABLES = ["users", "brands", "alerts", "org_brands", "org_members", "takedown_requests"];

const STAFF_NAME = "Sam Staffer";
const STAFF_EMAIL = "sam@averrow.local";

interface AuditCall { sql: string; bound: unknown[] }

function auditDb(calls: AuditCall[], rows: Array<Record<string, unknown>> = []): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...bound: unknown[]) => ({
        run: async () => {
          calls.push({ sql, bound });
          return { success: true, meta: {} };
        },
        all: async () => ({ results: rows, success: true, meta: {} }),
        first: async () => ({ total: rows.length }),
      }),
    }),
  } as unknown as D1Database;
}

let raw: SqliteDb;
let env: Env;
let audits: AuditCall[];

function makeEnv(auditRows: Array<Record<string, unknown>> = []): Env {
  audits = [];
  return {
    DB: d1FromSqlite(raw),
    CACHE: fakeKv(),
    AUDIT_DB: auditDb(audits, auditRows),
  } as unknown as Env;
}

function seed(db: SqliteDb): void {
  db.exec(`
    INSERT INTO brands (id, name, canonical_domain) VALUES
      ('b1', 'Brand One', 'one.example'),
      ('b2', 'Brand Two', 'two.example');
    INSERT INTO org_brands (org_id, brand_id) VALUES (7, 'b1'), (8, 'b1'), (8, 'b2');
  `);
  const user = db.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, ?, 'active')");
  user.run("u_staff", STAFF_EMAIL, STAFF_NAME, "super_admin");
  user.run("u_placeholder", "lead@averrow.local", "Lead Converter", "super_admin");
  user.run("t_alice", "alice@cust.example", "Alice Customer", "client");
  user.run("t_bob", "bob@cust.example", "Bob Customer", "client");
  const member = db.prepare("INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES (?, ?, ?, 'active', ?)");
  member.run(7, "t_alice", "admin", "manual");
  member.run(7, "t_bob", "analyst", "manual");
  member.run(7, "u_placeholder", "owner", "lead_conversion");
  const alert = db.prepare(
    `INSERT INTO alerts (id, brand_id, user_id, org_id, alert_type, severity, title, summary, status, assigned_to, created_at, updated_at)
     VALUES (?, 'b1', 't_alice', ?, 'phishing_detected', 'high', ?, 'summary', 'new', ?, datetime('now'), datetime('now'))`,
  );
  alert.run("a_plain", null, "Plain alert", null);
  alert.run("a_staff_assignee", null, "Legacy staff-assigned alert", "u_staff");
  alert.run("a_own", null, "Customer-assigned alert", "t_bob");
  alert.run("a_org7", 7, "Org 7 private alert", null);
  alert.run("a_gone_assignee", null, "Assignee deleted", "u_gone");
  // Fan-out owner is the lead-conversion placeholder (staff) — user_id must
  // never reach the customer.
  seedStaffOwnedAlert(db);
}

function seedStaffOwnedAlert(db: SqliteDb): void {
  db.prepare(
    `INSERT INTO alerts (id, brand_id, user_id, org_id, alert_type, severity, title, summary, status, created_at, updated_at)
     VALUES ('a_staff_owner', 'b1', 'u_placeholder', NULL, 'social_impersonation', 'high', 'Staff-owned', 'summary', 'new', datetime('now'), datetime('now'))`,
  ).run();
}

const CLIENT: AuthContext = {
  userId: "t_alice", email: "alice@cust.example", role: "client",
  orgId: "7", orgRole: "admin", embeddedScope: undefined,
} as AuthContext;

function staffCtx(role: UserRole): AuthContext {
  return { userId: "u_staff", email: STAFF_EMAIL, role, orgId: "7", orgRole: "owner", embeddedScope: undefined } as AuthContext;
}

function req(method: string, body?: unknown): Request {
  return new Request("https://averrow.com/api/orgs/7/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function alertRow(id: string): Record<string, unknown> {
  return raw.prepare("SELECT * FROM alerts WHERE id = ?").all(id)[0] as Record<string, unknown>;
}

describe.skipIf(!hasSqlite())("tenant alert routes — staff refusal and masking", () => {
  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    seed(raw);
    env = makeEnv();
    vi.mocked(emitOrgEvent).mockClear();
  });

  describe("B1: staff can't write through the tenant alert routes", () => {
    // super_admin is the role that actually passes canPerformHITL +
    // verifyOrgAccess; the lead-conversion placeholder also carries an org
    // owner claim. Every staff role is refused, whatever its org claim.
    for (const role of ["super_admin", "admin", "analyst", "support"] as UserRole[]) {
      it(`${role}: PATCH is 403 and writes nothing (no alert change, no audit, no webhook)`, async () => {
        const res = await handleTenantUpdateAlert(
          req("PATCH", { status: "resolved", notes: "STAFF-NOTE", assigned_to: "t_bob" }),
          env, "7", "a_plain", staffCtx(role),
        );
        expect(res.status).toBe(403);
        expect((await res.json<{ error: string }>()).error).toBe(STAFF_TENANT_ALERT_WRITE_ERROR);
        const row = alertRow("a_plain");
        expect(row).toMatchObject({ status: "new", resolution_notes: null, assigned_to: null });
        expect(audits).toEqual([]);
        expect(emitOrgEvent).not.toHaveBeenCalled();
      });

      it(`${role}: bulk is 403 and writes nothing`, async () => {
        const res = await handleTenantBulkUpdateAlerts(
          req("POST", { alert_ids: ["a_plain", "a_own"], status: "resolved", notes: "STAFF-NOTE" }),
          env, "7", staffCtx(role),
        );
        expect(res.status).toBe(403);
        expect(alertRow("a_plain").status).toBe("new");
        expect(alertRow("a_own").status).toBe("new");
        expect(audits).toEqual([]);
        expect(emitOrgEvent).not.toHaveBeenCalled();
      });
    }

    it("a client org member still triages: status + notes + assignee, audit + webhook", async () => {
      const res = await handleTenantUpdateAlert(
        req("PATCH", { status: "resolved", notes: "customer closed", assigned_to: "t_bob" }),
        env, "7", "a_plain", CLIENT,
      );
      expect(res.status).toBe(200);
      expect(alertRow("a_plain")).toMatchObject({ status: "resolved", resolution_notes: "customer closed", assigned_to: "t_bob" });
      expect(audits).toHaveLength(1);
      expect(emitOrgEvent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(emitOrgEvent).mock.calls[0]![3]).toMatchObject({ updated_by: "t_alice", notes: "customer closed" });
    });

    it("a client org member still bulk-triages", async () => {
      const res = await handleTenantBulkUpdateAlerts(
        req("POST", { alert_ids: ["a_plain", "a_own"], status: "acknowledged" }),
        env, "7", CLIENT,
      );
      expect(res.status).toBe(200);
      expect((await res.json<{ data: { updated: number } }>()).data.updated).toBe(2);
      expect(alertRow("a_plain").status).toBe("acknowledged");
    });
  });

  describe("B3: customers can't assign to staff", () => {
    for (const target of ["u_staff", "u_placeholder"]) {
      it(`PATCH assigning to ${target} is 400`, async () => {
        const res = await handleTenantUpdateAlert(req("PATCH", { assigned_to: target }), env, "7", "a_plain", CLIENT);
        expect(res.status).toBe(400);
        const { error } = await res.json<{ error: string }>();
        // u_staff isn't an org member; the placeholder IS an active owner row
        // (provisioned_by='lead_conversion') — still refused as staff.
        expect(error).toBe(target === "u_placeholder" ? "Cannot assign to Averrow staff" : "Assignee must be an active member of this organization");
        expect(alertRow("a_plain").assigned_to).toBeNull();
      });

      it(`bulk assigning to ${target} is 400`, async () => {
        const res = await handleTenantBulkUpdateAlerts(req("POST", { alert_ids: ["a_plain"], assigned_to: target }), env, "7", CLIENT);
        expect(res.status).toBe(400);
        expect(alertRow("a_plain").assigned_to).toBeNull();
      });
    }

    it("a staff user that IS an active member is refused as staff", async () => {
      raw.exec("INSERT INTO org_members (org_id, user_id, role, status) VALUES (7, 'u_staff', 'analyst', 'active')");
      const res = await handleTenantUpdateAlert(req("PATCH", { assigned_to: "u_staff" }), env, "7", "a_plain", CLIENT);
      expect(res.status).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe("Cannot assign to Averrow staff");
    });

    it("unassigning still works", async () => {
      const res = await handleTenantUpdateAlert(req("PATCH", { assigned_to: null }), env, "7", "a_own", CLIENT);
      expect(res.status).toBe(200);
      expect(alertRow("a_own").assigned_to).toBeNull();
    });
  });

  describe("B3: a staff user in assigned_to reads as Averrow SOC", () => {
    function assertMasked(view: Record<string, unknown>): void {
      expect(view.assigned_to_name).toBe(AVERROW_SOC_LABEL);
      expect(view.handled_by_averrow).toBe(true);
      expect(view.assigned_to).toBeNull();
      const text = JSON.stringify(view);
      expect(text).not.toContain(STAFF_NAME);
      expect(text).not.toContain(STAFF_EMAIL);
      expect(text).not.toContain("u_staff");
    }

    it("list", async () => {
      const res = await handleTenantAlerts(new Request("https://averrow.com/api/orgs/7/alerts"), env, "7", CLIENT);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(STAFF_NAME);
      expect(text).not.toContain(STAFF_EMAIL);
      const { data } = JSON.parse(text) as { data: Array<Record<string, unknown>> };
      assertMasked(data.find((a) => a.id === "a_staff_assignee")!);
      // The customer's own (client) assignee is still named.
      expect(data.find((a) => a.id === "a_own")).toMatchObject({
        assigned_to: "t_bob", assigned_to_name: "Bob Customer", handled_by_averrow: false,
      });
      expect(data.find((a) => a.id === "a_plain")).toMatchObject({ assigned_to_name: null, handled_by_averrow: false });
    });

    it("detail", async () => {
      const res = await handleTenantAlertDetail(new Request("https://averrow.com/x"), env, "7", "a_staff_assignee", CLIENT);
      expect(res.status).toBe(200);
      assertMasked((await res.json<{ data: Record<string, unknown> }>()).data);

      const own = await handleTenantAlertDetail(new Request("https://averrow.com/x"), env, "7", "a_own", CLIENT);
      expect((await own.json<{ data: Record<string, unknown> }>()).data).toMatchObject({ assigned_to_name: "Bob Customer" });
    });
  });

  describe("F1 / O-f: alert reads drop user_id and mask unresolvable assignees", () => {
    it("list: no user_id on any row; staff owner id never present", async () => {
      const res = await handleTenantAlerts(new Request("https://averrow.com/api/orgs/7/alerts"), env, "7", CLIENT);
      const text = await res.text();
      expect(text).not.toContain("u_placeholder");
      expect(text).not.toContain("u_gone");
      const { data } = JSON.parse(text) as { data: Array<Record<string, unknown>> };
      expect(data.length).toBeGreaterThan(0);
      for (const row of data) expect(row).not.toHaveProperty("user_id");
      expect(data.find((a) => a.id === "a_gone_assignee")).toMatchObject({
        assigned_to: null, assigned_to_name: FORMER_USER_LABEL, handled_by_averrow: false,
      });
    });

    it("detail: no user_id; deleted assignee masked", async () => {
      const owner = await handleTenantAlertDetail(new Request("https://averrow.com/x"), env, "7", "a_staff_owner", CLIENT);
      const ownerView = (await owner.json<{ data: Record<string, unknown> }>()).data;
      expect(ownerView).not.toHaveProperty("user_id");
      expect(JSON.stringify(ownerView)).not.toContain("u_placeholder");

      const gone = await handleTenantAlertDetail(new Request("https://averrow.com/x"), env, "7", "a_gone_assignee", CLIENT);
      const goneView = (await gone.json<{ data: Record<string, unknown> }>()).data;
      expect(goneView).toMatchObject({ assigned_to: null, assigned_to_name: FORMER_USER_LABEL, handled_by_averrow: false });
      expect(JSON.stringify(goneView)).not.toContain("u_gone");
    });
  });

  describe("B3: tenant audit log masks staff actors", () => {
    it("staff actor → Averrow SOC with notes dropped; client actor named", async () => {
      env = makeEnv([
        {
          id: "au1", timestamp: "2026-10-01T00:00:00Z", user_id: "u_staff", action: "tenant_alert_update",
          resource_type: "alert", resource_id: "a_plain",
          details: JSON.stringify({ org_id: "7", new_status: "resolved", notes: "STAFF-INTERNAL" }), outcome: "success",
        },
        {
          id: "au2", timestamp: "2026-10-01T00:00:01Z", user_id: "t_bob", action: "tenant_alert_update",
          resource_type: "alert", resource_id: "a_own",
          details: JSON.stringify({ org_id: "7", new_status: "resolved", notes: "customer note" }), outcome: "success",
        },
      ]);
      const res = await handleTenantAuditLog(new Request("https://averrow.com/x"), env, "7", CLIENT);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(STAFF_NAME);
      expect(text).not.toContain(STAFF_EMAIL);
      expect(text).not.toContain("STAFF-INTERNAL");
      const { data } = JSON.parse(text) as { data: Array<{ id: string; actor: string; details: string }> };
      const staffRow = data.find((d) => d.id === "au1")!;
      expect(staffRow.actor).toBe(AVERROW_SOC_LABEL);
      expect(JSON.parse(staffRow.details)).toEqual({ org_id: "7", new_status: "resolved" });
      const clientRow = data.find((d) => d.id === "au2")!;
      expect(clientRow.actor).toBe("Bob Customer");
      expect(JSON.parse(clientRow.details).notes).toBe("customer note");
    });
  });

  describe("O-a / O-b: audit details user ids and unknown actors", () => {
    function auditRow(id: string, userId: string | null, details: Record<string, unknown>): Record<string, unknown> {
      return {
        id, timestamp: "2026-10-01T00:00:00Z", user_id: userId, action: "tenant_alert_update",
        resource_type: "alert", resource_id: "a_plain", details: JSON.stringify(details), outcome: "success",
      };
    }

    it("a client actor's details: staff / unknown ids masked, member ids kept, notes kept", async () => {
      env = makeEnv([
        auditRow("c1", "t_bob", { org_id: "7", assigned_to: "u_staff", notes: "customer note" }),
        auditRow("c2", "t_bob", { org_id: "7", assigned_to: "t_alice" }),
        auditRow("c3", "t_bob", { org_id: "7", staff_assigned_to: "u_placeholder", new_owner_user_id: "u_gone" }),
      ]);
      const res = await handleTenantAuditLog(new Request("https://averrow.com/x"), env, "7", CLIENT);
      const text = await res.text();
      for (const leak of ["u_staff", "u_placeholder", "u_gone", STAFF_NAME, STAFF_EMAIL]) expect(text).not.toContain(leak);
      const { data } = JSON.parse(text) as { data: Array<{ id: string; actor: string; details: string }> };
      const byId = (id: string) => JSON.parse(data.find((d) => d.id === id)!.details) as Record<string, unknown>;
      expect(byId("c1")).toEqual({ org_id: "7", assigned_to: null, assigned_to_name: AVERROW_SOC_LABEL, notes: "customer note" });
      expect(byId("c2")).toEqual({ org_id: "7", assigned_to: "t_alice" });
      expect(byId("c3")).toEqual({
        org_id: "7",
        staff_assigned_to: null, staff_assigned_to_name: AVERROW_SOC_LABEL,
        new_owner_user_id: null, new_owner_user_id_name: FORMER_USER_LABEL,
      });
    });

    it("an actor with no users row reads as Former user with notes dropped", async () => {
      env = makeEnv([auditRow("g1", "u_gone", { org_id: "7", new_status: "resolved", notes: "WHO-WROTE-THIS" })]);
      const res = await handleTenantAuditLog(new Request("https://averrow.com/x"), env, "7", CLIENT);
      const text = await res.text();
      expect(text).not.toContain("u_gone");
      expect(text).not.toContain("WHO-WROTE-THIS");
      const { data } = JSON.parse(text) as { data: Array<{ actor: string; details: string }> };
      expect(data[0]!.actor).toBe(FORMER_USER_LABEL);
      expect(JSON.parse(data[0]!.details)).toEqual({ org_id: "7", new_status: "resolved" });
    });
  });

  describe("O-d: tenant takedown reads respect org ownership", () => {
    function seedTd(id: string, orgId: number | null, status = "draft"): void {
      raw.prepare(
        `INSERT INTO takedown_requests (id, org_id, brand_id, target_type, target_value, evidence_summary, status)
         VALUES (?, ?, 'b1', 'domain', 'evil.example', 'evidence', ?)`,
      ).run(id, orgId, status);
    }
    const ORG8: AuthContext = {
      userId: "t_carol", email: "carol@other.example", role: "client",
      orgId: "8", orgRole: "admin", embeddedScope: undefined,
    } as AuthContext;

    beforeEach(() => {
      seedTd("td7", 7, "requested");
      seedTd("td8", 8);
      seedTd("tdnull", null);
    });

    it("list: org 8 sees its own + brand-wide, not org 7's (rows, total, status_counts)", async () => {
      const res = await handleListTakedowns(new Request("https://averrow.com/api/orgs/8/takedowns"), env, "8", ORG8);
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Array<{ id: string }>; total: number; status_counts: Array<{ status: string; count: number }> }>();
      expect(body.data.map((d) => d.id).sort()).toEqual(["td8", "tdnull"]);
      expect(body.total).toBe(2);
      expect(body.status_counts).toEqual([{ status: "draft", count: 2 }]);
    });

    it("list with a filter keeps bind order right", async () => {
      const res = await handleListTakedowns(new Request("https://averrow.com/api/orgs/7/takedowns?status=requested"), env, "7", CLIENT);
      const body = await res.json<{ data: Array<{ id: string }>; total: number }>();
      expect(body.data.map((d) => d.id)).toEqual(["td7"]);
      expect(body.total).toBe(1);
    });

    it("get: another org's takedown is 404; own and brand-wide are readable", async () => {
      expect((await handleGetTakedown(new Request("https://averrow.com/x"), env, "8", "td7", ORG8)).status).toBe(404);
      expect((await handleGetTakedown(new Request("https://averrow.com/x"), env, "8", "td8", ORG8)).status).toBe(200);
      expect((await handleGetTakedown(new Request("https://averrow.com/x"), env, "8", "tdnull", ORG8)).status).toBe(200);
      expect((await handleGetTakedown(new Request("https://averrow.com/x"), env, "7", "td7", CLIENT)).status).toBe(200);
    });
  });

  describe("O1: takedown org ownership", () => {
    it("ops bulk-takedown stamps org_id from the alert (NULL for brand-wide)", async () => {
      const res = await handleBulkTakedown(req("POST", { alert_ids: ["a_org7", "a_plain"] }), env, "u_staff", null);
      expect(res.status).toBe(200);
      const rows = raw.prepare("SELECT source_id, org_id FROM takedown_requests ORDER BY source_id").all();
      expect(rows).toEqual([
        { source_id: "a_org7", org_id: 7 },
        { source_id: "a_plain", org_id: null },
      ]);
    });

    function seedTakedown(id: string, orgId: number | null): void {
      raw.prepare(
        `INSERT INTO takedown_requests (id, org_id, brand_id, target_type, target_value, evidence_summary, status)
         VALUES (?, ?, 'b1', 'domain', 'evil.example', 'evidence', 'draft')`,
      ).run(id, orgId);
    }
    const ORG8: AuthContext = {
      userId: "t_carol", email: "carol@other.example", role: "client",
      orgId: "8", orgRole: "admin", embeddedScope: undefined,
    } as AuthContext;

    it("org 8 (co-monitors b1) can't PATCH org 7's takedown", async () => {
      seedTakedown("td7", 7);
      const res = await handleUpdateTakedown(req("PATCH", { notes: "hijack" }), env, "8", "td7", ORG8);
      expect(res.status).toBe(404);
      const row = raw.prepare("SELECT notes FROM takedown_requests WHERE id = 'td7'").all()[0] as { notes: string | null };
      expect(row.notes).toBeNull();
    });

    it("the owning org can edit; brand-wide (org_id NULL) takedowns are refused, not claimed", async () => {
      seedTakedown("td7", 7);
      seedTakedown("tdnull", null);
      expect((await handleUpdateTakedown(req("PATCH", { notes: "ours" }), env, "7", "td7", CLIENT)).status).toBe(200);
      expect((await handleUpdateTakedown(req("PATCH", { notes: "shared" }), env, "8", "tdnull", ORG8)).status).toBe(404);
      const row = raw.prepare("SELECT org_id, notes FROM takedown_requests WHERE id = 'tdnull'").all()[0];
      expect(row).toEqual({ org_id: null, notes: null });
    });
  });
});
