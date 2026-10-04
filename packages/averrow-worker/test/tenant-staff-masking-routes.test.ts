// Staff never write as — and are never named to — a customer on the tenant
// routes (owner decision 2026-10-04; extends the tenant-alert rule of
// test/tenant-alert-staff-masking.test.ts to every /api/orgs/:orgId/* write).
//
//   W — every customer-data write refuses platform staff with 403
//       "Staff must work from the Averrow console" and changes nothing:
//       investigations (create/update/items/notes), takedowns (create/
//       update), abuse-mailbox status, trademark assets (upload/delete),
//       takedown authorization (sign/revoke), executives, monitoring config.
//       Covers super_admin (global), the lead-conversion placeholder
//       super_admin (org owner), an `admin` holding a legacy org JWT, and
//       the auditor seat. A client analyst/admin is unchanged.
//   R — tenant reads mask staff (null id + "Averrow SOC") and deleted users
//       (null id + "Former user"): investigations, takedown detail,
//       takedown authorization, members list, api-keys list. No staff id,
//       name or email appears anywhere in a customer response.
//   N — brand-wide (org_id NULL) takedowns are refused (404), never claimed.
//   A — a case can't be assigned to staff (incl. the placeholder).
//   O — allowed staff-on-tenant org admin flows (invite) keep working but the
//       invite email brands the inviter "Averrow SOC"; staff takedown
//       webhooks carry updated_by null + "Averrow SOC".
//
// Real itty router + registerTenantRoutes + signed JWTs through
// requireOrgMember, against in-memory SQLite derived from migrations/.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/lib/org-events", () => ({
  emitOrgEvent: vi.fn(async () => {}),
}));
vi.mock("../src/lib/invite-email", () => ({
  sendInviteEmail: vi.fn(async () => ({ ok: true })),
}));

import { Router } from "itty-router";
import { emitOrgEvent } from "../src/lib/org-events";
import { sendInviteEmail } from "../src/lib/invite-email";
import { registerTenantRoutes } from "../src/routes/tenant";
import { handleAdminUpdateTakedown } from "../src/handlers/takedowns";
import { STAFF_TENANT_WRITE_ERROR } from "../src/lib/tenant-staff-guard";
import { AVERROW_SOC_LABEL, FORMER_USER_LABEL } from "../src/handlers/tenantData";
import { signJWT } from "../src/lib/jwt";
import type { AuthContext } from "../src/middleware/auth";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env, JWTPayload } from "../src/types";

const SECRET = "test-secret-tenant-staff-masking";

const TABLES = [
  "users", "organizations", "brands", "org_brands", "org_members", "org_modules",
  "investigations", "investigation_items", "investigation_notes",
  "takedown_requests", "takedown_submissions", "takedown_authorizations",
  "abuse_inbox_messages", "trademark_assets", "org_executives",
  "org_api_keys", "invitations",
];

// Every identifier of a staff user that must never reach a customer.
const STAFF_MARKERS = [
  "u_staff", "Sam Staffer", "sam@averrow.local",
  "u_placeholder", "Lead Converter", "lead@averrow.local",
  // Staff signer's IP / user agent on the seeded takedown authorization.
  "203.0.113.77", "StaffBrowser/9.9",
];

interface AuditCall { bound: unknown[] }

let raw: SqliteDb;
let env: Env;
let audits: AuditCall[];
let router: ReturnType<typeof Router>;

function auditDb(calls: AuditCall[]): D1Database {
  return {
    prepare: () => ({
      bind: (...bound: unknown[]) => ({
        run: async () => {
          calls.push({ bound });
          return { success: true, meta: {} };
        },
      }),
    }),
  } as unknown as D1Database;
}

function seed(db: SqliteDb): void {
  db.exec(`
    INSERT INTO organizations (id, name, slug) VALUES (7, 'Cust Seven', 'cust-seven'), (8, 'Cust Eight', 'cust-eight');
    INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Brand One', 'one.example');
    INSERT INTO org_brands (org_id, brand_id) VALUES (7, 'b1'), (8, 'b1');
    INSERT INTO org_modules (org_id, module_key, status) VALUES (7, 'abuse_mailbox', 'active'), (7, 'trademark', 'active');
  `);
  const user = db.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, ?, 'active')");
  user.run("u_staff", "sam@averrow.local", "Sam Staffer", "super_admin");
  user.run("u_placeholder", "lead@averrow.local", "Lead Converter", "super_admin");
  user.run("u_admin", "ada@averrow.local", "Ada Admin", "admin");
  user.run("u_aud", "aud@averrow.local", "Audrey Auditor", "analyst");
  user.run("t_alice", "alice@cust.example", "Alice Customer", "client");
  user.run("t_bob", "bob@cust.example", "Bob Customer", "client");
  const member = db.prepare("INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES (?, ?, ?, 'active', ?)");
  member.run(7, "t_alice", "admin", "manual");
  member.run(7, "t_bob", "analyst", "manual");
  member.run(7, "u_placeholder", "owner", "lead_conversion");

  db.exec(`
    INSERT INTO investigations (id, org_id, title, status, severity, created_by, assigned_to)
      VALUES ('inv_staff', 7, 'Legacy staff case', 'open', 'high', 'u_staff', 'u_placeholder'),
             ('inv_cust', 7, 'Customer case', 'open', 'medium', 't_alice', 't_bob');
    INSERT INTO investigation_items (id, investigation_id, item_type, item_id, added_by)
      VALUES ('it1', 'inv_cust', 'takedown', 'td7', 't_alice');
    INSERT INTO investigation_notes (id, investigation_id, author_id, body)
      VALUES ('n_staff', 'inv_staff', 'u_staff', 'staff wrote this'),
             ('n_cust', 'inv_staff', 't_bob', 'customer note'),
             ('n_gone', 'inv_staff', 'u_gone', 'deleted user note');
    INSERT INTO takedown_requests (id, org_id, brand_id, target_type, target_value, evidence_summary, status, requested_by, submitted_by, notes, response_notes)
      VALUES ('td7', 7, 'b1', 'url', 'https://evil.example', 'evidence', 'draft', 'u_staff', 'u_staff', 'internal staff note', 'provider said ok'),
             ('tdnull', NULL, 'b1', 'url', 'https://shared.example', 'evidence', 'draft', NULL, NULL, NULL, NULL);
    INSERT INTO takedown_authorizations (id, org_id, agreement_version, status, signed_at, signed_by_user_id, signed_ip, signed_user_agent, scope_json)
      VALUES ('auth1', 7, 'v1', 'active', datetime('now'), 'u_placeholder', '203.0.113.77', 'StaffBrowser/9.9',
              '{"modules":["domain"],"max_takedowns_per_month":null,"escalation":"manual_only","auto_followup_breached_sla_hours":null,"high_risk_requires_per_takedown_approval":true}');
    INSERT INTO abuse_inbox_messages (id, org_id, status) VALUES ('m1', 7, 'new');
    INSERT INTO trademark_assets (id, brand_id, asset_type, asset_name, status, created_by)
      VALUES ('ta1', 'b1', 'logo', 'Logo', 'active', 't_alice');
    INSERT INTO org_executives (id, org_id, brand_id, full_name, status)
      VALUES ('ex1', 7, 'b1', 'Jane Exec', 'active');
    INSERT INTO org_api_keys (id, org_id, name, key_prefix, key_hash, created_by)
      VALUES ('k_staff', 7, 'Staff key', 'avr_s', 'h1', 'u_staff'),
             ('k_cust', 7, 'Cust key', 'avr_c', 'h2', 't_alice');
  `);
}

type Who = "super_admin" | "placeholder" | "admin_legacy" | "auditor" | "client_admin" | "client_analyst";

const PAYLOADS: Record<Who, Omit<JWTPayload, "iat" | "exp">> = {
  super_admin:    { sub: "u_staff", email: "sam@averrow.local", role: "super_admin" },
  placeholder:    { sub: "u_placeholder", email: "lead@averrow.local", role: "super_admin", org_id: "7", org_role: "owner" },
  admin_legacy:   { sub: "u_admin", email: "ada@averrow.local", role: "admin", org_id: "7", org_role: "owner" },
  auditor:        { sub: "u_aud", email: "aud@averrow.local", role: "auditor" },
  client_admin:   { sub: "t_alice", email: "alice@cust.example", role: "client", org_id: "7", org_role: "admin" },
  client_analyst: { sub: "t_bob", email: "bob@cust.example", role: "client", org_id: "7", org_role: "analyst" },
};

async function call(who: Who, method: string, path: string, body?: unknown): Promise<Response> {
  const token = await signJWT(PAYLOADS[who], SECRET, 300);
  const req = new Request(`https://averrow.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await router.fetch(req, env)) as Response;
}

/** Every customer-data table except users (requireAuth stamps last_active). */
function snapshot(): string {
  return JSON.stringify(
    TABLES.filter((t) => t !== "users").map((t) => raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),
  );
}

function expectNoStaffMarkers(text: string): void {
  for (const m of STAFF_MARKERS) expect(text, `leaked ${m}`).not.toContain(m);
}

const AUTH_SCOPE = {
  modules: ["domain"], max_takedowns_per_month: null, escalation: "manual_only",
  auto_followup_breached_sla_hours: null, high_risk_requires_per_takedown_approval: true,
};

interface WriteCase { name: string; method: string; path: string; body?: unknown; client: Who; ok: number }

const WRITES: WriteCase[] = [
  { name: "create investigation", method: "POST", path: "/api/orgs/7/investigations", body: { title: "New case" }, client: "client_analyst", ok: 201 },
  { name: "update investigation", method: "PATCH", path: "/api/orgs/7/investigations/inv_cust", body: { status: "monitoring" }, client: "client_analyst", ok: 200 },
  { name: "add investigation item", method: "POST", path: "/api/orgs/7/investigations/inv_cust/items", body: { item_type: "takedown", item_id: "td7" }, client: "client_analyst", ok: 200 },
  { name: "remove investigation item", method: "DELETE", path: "/api/orgs/7/investigations/inv_cust/items/it1", client: "client_analyst", ok: 200 },
  { name: "add investigation note", method: "POST", path: "/api/orgs/7/investigations/inv_cust/notes", body: { body: "hello" }, client: "client_analyst", ok: 201 },
  { name: "create takedown", method: "POST", path: "/api/orgs/7/takedowns", body: { brand_id: "b1", target_type: "url", target_value: "https://x.example", evidence_summary: "e" }, client: "client_analyst", ok: 201 },
  { name: "update takedown", method: "PATCH", path: "/api/orgs/7/takedowns/td7", body: { status: "requested" }, client: "client_analyst", ok: 200 },
  { name: "abuse-mailbox status", method: "PATCH", path: "/api/orgs/7/modules/abuse-mailbox/messages/m1/status", body: { status: "resolved" }, client: "client_analyst", ok: 200 },
  { name: "trademark asset delete", method: "DELETE", path: "/api/orgs/7/modules/trademark/assets/ta1", client: "client_analyst", ok: 200 },
  { name: "sign takedown authorization", method: "POST", path: "/api/orgs/7/takedown-authorization", body: { agreement_version: "v2", scope: AUTH_SCOPE }, client: "client_admin", ok: 200 },
  { name: "revoke takedown authorization", method: "DELETE", path: "/api/orgs/7/takedown-authorization", body: { reason: "x" }, client: "client_admin", ok: 200 },
  { name: "create executive", method: "POST", path: "/api/orgs/7/executives", body: { brand_id: "b1", full_name: "John Exec" }, client: "client_admin", ok: 201 },
  { name: "patch executive", method: "PATCH", path: "/api/orgs/7/executives/ex1", body: { title: "CFO" }, client: "client_admin", ok: 200 },
  { name: "put executive", method: "PUT", path: "/api/orgs/7/executives/ex1", body: { title: "CEO" }, client: "client_admin", ok: 200 },
  { name: "delete executive", method: "DELETE", path: "/api/orgs/7/executives/ex1", client: "client_admin", ok: 200 },
  { name: "monitoring config", method: "PATCH", path: "/api/orgs/7/brands/b1/monitoring-config", body: { weekly_digest: true }, client: "client_analyst", ok: 200 },
];

// Staff-only refusal (client success needs R2 + image decoding, out of scope).
const STAFF_ONLY_WRITES: WriteCase[] = [
  { name: "trademark asset upload", method: "POST", path: "/api/orgs/7/modules/trademark/brands/b1/assets", body: { asset_type: "logo" }, client: "client_analyst", ok: 0 },
  // Billing: client success needs Stripe; the client pass-through is
  // asserted separately (reaches the STRIPE_API_KEY check → 503).
  { name: "billing checkout session", method: "POST", path: "/api/orgs/7/billing/checkout-session", body: { plan_id: "professional" }, client: "client_admin", ok: 0 },
  { name: "billing portal session", method: "POST", path: "/api/orgs/7/billing/portal-session", client: "client_admin", ok: 0 },
];

describe.skipIf(!hasSqlite())("tenant routes — staff refusal and masking", () => {
  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    seed(raw);
    audits = [];
    env = {
      JWT_SECRET: SECRET,
      DB: d1FromSqlite(raw),
      CACHE: fakeKv(),
      AUDIT_DB: auditDb(audits),
      RESEND_API_KEY: "re_test",
    } as unknown as Env;
    router = Router();
    registerTenantRoutes(router);
    vi.mocked(emitOrgEvent).mockClear();
    vi.mocked(sendInviteEmail).mockClear();
  });

  describe("W: staff are refused on every customer-data write", () => {
    for (const w of [...WRITES, ...STAFF_ONLY_WRITES]) {
      it(`${w.name}: 403 for every staff identity, nothing written/audited/emitted`, async () => {
        const before = snapshot();
        for (const who of ["super_admin", "placeholder", "admin_legacy", "auditor"] as const) {
          const res = await call(who, w.method, w.path, w.body);
          expect(res.status, `${who} ${w.name}`).toBe(403);
          if (who === "super_admin" || who === "placeholder") {
            expect((await res.json<{ error: string }>()).error).toBe(STAFF_TENANT_WRITE_ERROR);
          }
        }
        expect(snapshot()).toBe(before);
        expect(audits).toEqual([]);
        expect(emitOrgEvent).not.toHaveBeenCalled();
      });
    }

    for (const path of ["/api/orgs/7/billing/checkout-session", "/api/orgs/7/billing/portal-session"]) {
      it(`${path}: client org admin is not refused (reaches the Stripe config check)`, async () => {
        const res = await call("client_admin", "POST", path, { plan_id: "professional" });
        expect(res.status, await res.clone().text()).toBe(503);
      });
    }

    for (const w of WRITES) {
      it(`${w.name}: client ${w.client} unchanged (${w.ok})`, async () => {
        const res = await call(w.client, w.method, w.path, w.body);
        expect(res.status, await res.clone().text()).toBe(w.ok);
      });
    }
  });

  describe("R: tenant reads never identify staff", () => {
    it("investigation list masks staff creator/assignee, keeps customers", async () => {
      const res = await call("client_analyst", "GET", "/api/orgs/7/investigations");
      const text = await res.text();
      expect(res.status).toBe(200);
      expectNoStaffMarkers(text);
      const { data } = JSON.parse(text) as { data: Array<Record<string, unknown>> };
      const staffCase = data.find((d) => d.id === "inv_staff")!;
      expect(staffCase).toMatchObject({
        created_by: null, created_by_name: AVERROW_SOC_LABEL,
        assigned_to: null, assigned_to_name: AVERROW_SOC_LABEL,
      });
      const custCase = data.find((d) => d.id === "inv_cust")!;
      expect(custCase).toMatchObject({
        created_by: "t_alice", created_by_name: "Alice Customer",
        assigned_to: "t_bob", assigned_to_name: "Bob Customer",
      });
    });

    it("investigation detail masks staff + deleted note authors", async () => {
      const res = await call("client_analyst", "GET", "/api/orgs/7/investigations/inv_staff");
      const text = await res.text();
      expect(res.status).toBe(200);
      expectNoStaffMarkers(text);
      const { data } = JSON.parse(text) as { data: Record<string, unknown> & { notes: Array<Record<string, unknown>> } };
      expect(data).toMatchObject({ created_by: null, created_by_name: AVERROW_SOC_LABEL, assigned_to_name: AVERROW_SOC_LABEL });
      const byId = Object.fromEntries(data.notes.map((n) => [n.id, n]));
      expect(byId.n_staff).toMatchObject({ author_id: null, author_name: AVERROW_SOC_LABEL });
      expect(byId.n_cust).toMatchObject({ author_id: "t_bob", author_name: "Bob Customer" });
      expect(byId.n_gone).toMatchObject({ author_id: null, author_name: FORMER_USER_LABEL });
    });

    it("takedown detail masks requested_by/submitted_by and drops staff-writable notes", async () => {
      const res = await call("client_analyst", "GET", "/api/orgs/7/takedowns/td7");
      const text = await res.text();
      expect(res.status).toBe(200);
      expectNoStaffMarkers(text);
      expect(text).not.toContain("internal staff note");
      const { data } = JSON.parse(text) as { data: { takedown: Record<string, unknown> } };
      expect(data.takedown).toMatchObject({
        requested_by: null, requested_by_name: AVERROW_SOC_LABEL,
        submitted_by: null, submitted_by_name: AVERROW_SOC_LABEL,
        response_notes: "provider said ok",
      });
      expect("notes" in data.takedown).toBe(false);
    });

    it("takedown authorization GET masks a staff signer", async () => {
      const res = await call("client_admin", "GET", "/api/orgs/7/takedown-authorization");
      const text = await res.text();
      expect(res.status).toBe(200);
      expectNoStaffMarkers(text);
      const { data } = JSON.parse(text) as { data: { authorization: Record<string, unknown> } };
      expect(data.authorization).toMatchObject({
        signed_by_user_id: null, signed_by_name: AVERROW_SOC_LABEL,
        signed_ip: null, signed_user_agent: null,
      });
    });

    it("members list shows the placeholder as Averrow SOC to a customer, real ids to staff", async () => {
      const res = await call("client_admin", "GET", "/api/orgs/7/members");
      const text = await res.text();
      expect(res.status).toBe(200);
      expectNoStaffMarkers(text);
      expect(text).not.toContain("global_role");
      const { data } = JSON.parse(text) as { data: Array<Record<string, unknown>> };
      expect(data.find((m) => m.is_averrow === true)).toMatchObject({
        user_id: null, email: null, user_name: AVERROW_SOC_LABEL, role: "owner",
      });
      expect(data.find((m) => m.user_id === "t_bob")).toMatchObject({ email: "bob@cust.example", is_averrow: false });

      const staffView = await call("super_admin", "GET", "/api/orgs/7/members");
      const staffData = (await staffView.json<{ data: Array<Record<string, unknown>> }>()).data;
      expect(staffData.map((m) => m.user_id)).toContain("u_placeholder");
    });

    it("api-keys list masks a staff creator for a customer", async () => {
      const res = await call("client_admin", "GET", "/api/orgs/7/api-keys");
      const text = await res.text();
      expect(res.status).toBe(200);
      expectNoStaffMarkers(text);
      const { data } = JSON.parse(text) as { data: Array<Record<string, unknown>> };
      expect(data.find((k) => k.id === "k_staff")).toMatchObject({ created_by: null, created_by_name: AVERROW_SOC_LABEL });
      expect(data.find((k) => k.id === "k_cust")).toMatchObject({ created_by: "t_alice", created_by_name: "Alice Customer" });
    });
  });

  describe("N: brand-wide (org_id NULL) takedowns are refused, not claimed", () => {
    it("tenant PATCH on an org_id NULL row is 404 and the row is untouched", async () => {
      const before = raw.prepare("SELECT * FROM takedown_requests WHERE id = 'tdnull'").all();
      for (const body of [{ status: "withdrawn" }, { notes: "mine" }, { evidence_summary: "edited" }]) {
        const res = await call("client_analyst", "PATCH", "/api/orgs/7/takedowns/tdnull", body);
        expect(res.status).toBe(404);
      }
      expect(raw.prepare("SELECT * FROM takedown_requests WHERE id = 'tdnull'").all()).toEqual(before);
      expect(audits).toEqual([]);
    });
  });

  describe("A: case assignee must be a customer member", () => {
    it("rejects staff (incl. the placeholder owner) and non-members; accepts a customer member", async () => {
      const assign = (assigned_to: string) =>
        call("client_analyst", "PATCH", "/api/orgs/7/investigations/inv_cust", { assigned_to });
      const placeholder = await assign("u_placeholder");
      expect(placeholder.status).toBe(400);
      expect((await placeholder.json<{ error: string }>()).error).toBe("Cannot assign to Averrow staff");
      expect((await assign("u_staff")).status).toBe(400);
      expect((await assign("t_alice")).status).toBe(200);
      const row = raw.prepare("SELECT assigned_to FROM investigations WHERE id = 'inv_cust'").all()[0];
      expect(row).toEqual({ assigned_to: "t_alice" });
    });
  });

  describe("O: allowed staff-on-tenant flows mask the staff actor", () => {
    it("staff invite works; the email brands the inviter as Averrow SOC", async () => {
      const res = await call("super_admin", "POST", "/api/orgs/7/invite", { email: "new@cust.example", org_role: "viewer" });
      expect(res.status).toBe(201);
      const arg = vi.mocked(sendInviteEmail).mock.calls[0]![1];
      expect(arg.invitedByName).toBe(AVERROW_SOC_LABEL);
      expectNoStaffMarkers(JSON.stringify(arg));
    });

    it("a customer invite still names the customer inviter", async () => {
      const res = await call("client_admin", "POST", "/api/orgs/7/invite", { email: "new2@cust.example", org_role: "viewer" });
      expect(res.status).toBe(201);
      expect(vi.mocked(sendInviteEmail).mock.calls[0]![1].invitedByName).toBe("Alice Customer");
    });

    it("ops takedown PATCH emits a customer webhook without the staff id", async () => {
      const ctx = { userId: "u_staff", email: "sam@averrow.local", role: "super_admin", orgId: null, orgRole: null } as AuthContext;
      const req = new Request("https://averrow.com/api/admin/takedowns/td7", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "requested" }),
      });
      const res = await handleAdminUpdateTakedown(req, env, "td7", ctx);
      expect(res.status).toBe(200);
      expect(emitOrgEvent).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(emitOrgEvent).mock.calls[0]![3];
      expect(payload).toMatchObject({ updated_by: null, updated_by_name: AVERROW_SOC_LABEL });
      expectNoStaffMarkers(JSON.stringify(payload));
    });

    it("a client's takedown status webhook still carries the customer actor", async () => {
      const res = await call("client_analyst", "PATCH", "/api/orgs/7/takedowns/td7", { status: "requested" });
      expect(res.status).toBe(200);
      expect(vi.mocked(emitOrgEvent).mock.calls[0]![3]).toMatchObject({ updated_by: "t_bob", updated_by_name: "Bob Customer" });
    });
  });
});
