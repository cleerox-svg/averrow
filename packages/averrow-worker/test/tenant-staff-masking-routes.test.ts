// Staff never write as — and are never named to — a customer on the tenant
// routes (owner decision 2026-10-04; extends the tenant-alert rule of
// test/tenant-alert-staff-masking.test.ts to every /api/orgs/:orgId/* write).
//
//   W — every customer-data write refuses platform staff with 403
//       "Staff must work from the Averrow console" and changes nothing:
//       investigations (create/update/items/notes), takedowns (create/
//       update), abuse-mailbox status, takedown authorization (sign/revoke).
//       Covers super_admin (global), the lead-conversion placeholder
//       super_admin (org owner), an `admin` holding a legacy org JWT, and
//       the auditor seat. A client analyst/admin is unchanged.
//   X — the staff CROSSOVER allowance (owner decision 2026-10-04):
//       executives, monitoring config, trademark assets and billing succeed
//       for staff that pass the existing org gates (super_admin, the
//       placeholder, and a global `admin` holding a legacy org seat), with no
//       staff id/name/email in the response, the customer's audit-log view,
//       or webhooks. The auditor seat gets an explicit read-only 403. A staff
//       checkout sends the customer owner's email to Stripe, never the staff
//       email; with no Stripe customer and no customer owner it is 409 and
//       Stripe is never called. Billing sessions are audited (masked).
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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

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
  "org_api_keys", "invitations", "pricing_plans", "trademark_findings",
];

// Every identifier of a staff user that must never reach a customer.
const STAFF_MARKERS = [
  "u_staff", "Sam Staffer", "sam@averrow.local",
  "u_placeholder", "Lead Converter", "lead@averrow.local",
  "u_admin", "Ada Admin", "ada@averrow.local",
  // Staff signer's IP / user agent on the seeded takedown authorization.
  "203.0.113.77", "StaffBrowser/9.9",
];

interface AuditCall { bound: unknown[] }

let raw: SqliteDb;
let env: Env;
let audits: AuditCall[];
let router: ReturnType<typeof Router>;

let auditRaw: SqliteDb;

const AUDIT_DDL = readFileSync(new URL("../migrations-audit/0001_audit_log.sql", import.meta.url), "utf8");

/** Real (in-memory SQLite) audit_log, so the tenant audit-log READ path can
 *  be exercised; every write is also recorded in `calls`. */
function auditDb(calls: AuditCall[]): D1Database {
  auditRaw = openDerivedDb([]);
  auditRaw.exec(AUDIT_DDL);
  const real = d1FromSqlite(auditRaw);
  return {
    prepare: (sql: string) => ({
      bind: (...bound: unknown[]) => {
        const stmt = real.prepare(sql).bind(...bound);
        return {
          run: async () => {
            calls.push({ bound });
            return stmt.run();
          },
          all: () => stmt.all(),
          first: (col?: string) => stmt.first(col as string),
        };
      },
    }),
  } as unknown as D1Database;
}

function seed(db: SqliteDb): void {
  db.exec(`
    INSERT INTO organizations (id, name, slug) VALUES (7, 'Cust Seven', 'cust-seven'), (8, 'Cust Eight', 'cust-eight');
    INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Brand One', 'one.example');
    INSERT INTO org_brands (org_id, brand_id) VALUES (7, 'b1'), (8, 'b1');
    INSERT INTO org_modules (org_id, module_key, status) VALUES (7, 'abuse_mailbox', 'active'), (7, 'trademark', 'active');
    INSERT INTO pricing_plans (id, display_name, monthly_price_cents, trial_days, included_modules, stripe_price_id, is_active)
      VALUES ('professional', 'Professional', 149900, 14, '[]', 'price_pro', 1);
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
    INSERT INTO takedown_requests (id, org_id, brand_id, target_type, target_value, evidence_summary, status, requested_by, submitted_by, notes, staff_notes, response_notes)
      VALUES ('td7', 7, 'b1', 'url', 'https://evil.example', 'evidence', 'draft', 'u_staff', 'u_staff', 'customer takedown note', 'internal staff note', 'provider said ok'),
             ('tdnull', NULL, 'b1', 'url', 'https://shared.example', 'evidence', 'draft', NULL, NULL, NULL, NULL, NULL);
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

/** Decoded keys + values of a Stripe form body (`+` → space, %XX decoded),
 *  so a marker can't hide behind form encoding. */
function stripeFormText(body: string): string {
  const params = new URLSearchParams(body);
  return [...params.keys(), ...params.values()].join("\n");
}

const READ_ONLY_ERROR = "Forbidden: read-only role";

/** Staff identities that pass the crossover surfaces' org gates. */
const CROSSOVER_STAFF = ["super_admin", "placeholder", "admin_legacy"] as const;

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
  { name: "sign takedown authorization", method: "POST", path: "/api/orgs/7/takedown-authorization", body: { agreement_version: "v2", scope: AUTH_SCOPE }, client: "client_admin", ok: 200 },
  { name: "revoke takedown authorization", method: "DELETE", path: "/api/orgs/7/takedown-authorization", body: { reason: "x" }, client: "client_admin", ok: 200 },
];

// Staff crossover allowance — these succeed for staff that pass the org gates.
const CROSSOVER_WRITES: WriteCase[] = [
  { name: "create executive", method: "POST", path: "/api/orgs/7/executives", body: { brand_id: "b1", full_name: "John Exec" }, client: "client_admin", ok: 201 },
  { name: "patch executive", method: "PATCH", path: "/api/orgs/7/executives/ex1", body: { title: "CFO" }, client: "client_admin", ok: 200 },
  { name: "put executive", method: "PUT", path: "/api/orgs/7/executives/ex1", body: { title: "CEO" }, client: "client_admin", ok: 200 },
  { name: "delete executive", method: "DELETE", path: "/api/orgs/7/executives/ex1", client: "client_admin", ok: 200 },
  { name: "monitoring config", method: "PATCH", path: "/api/orgs/7/brands/b1/monitoring-config", body: { weekly_digest: true }, client: "client_analyst", ok: 200 },
  { name: "trademark asset delete", method: "DELETE", path: "/api/orgs/7/modules/trademark/assets/ta1", client: "client_analyst", ok: 200 },
];

/** Minimal R2 bucket for the trademark asset upload/delete paths. */
function fakeR2(): R2Bucket {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (key: string, value: Uint8Array) => { store.set(key, value); return null; },
    delete: async (key: string) => { store.delete(key); },
    get: async () => null,
  } as unknown as R2Bucket;
}

// 1x1 transparent PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

interface StripeCall { url: string; body: string }

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
      TRADEMARK_ASSETS: fakeR2(),
    } as unknown as Env;
    router = Router();
    registerTenantRoutes(router);
    vi.mocked(emitOrgEvent).mockClear();
    vi.mocked(sendInviteEmail).mockClear();
  });

  describe("W: staff are refused on every customer-data write", () => {
    for (const w of WRITES) {
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

    for (const w of WRITES) {
      it(`${w.name}: client ${w.client} unchanged (${w.ok})`, async () => {
        const res = await call(w.client, w.method, w.path, w.body);
        expect(res.status, await res.clone().text()).toBe(w.ok);
      });
    }
  });

  describe("X: staff crossover — executives, monitoring rules, trademark assets, billing", () => {
    /** The customer's view of the org audit log. */
    async function customerAuditLog(): Promise<{ text: string; data: Array<Record<string, unknown>> }> {
      const res = await call("client_analyst", "GET", "/api/orgs/7/audit-log");
      expect(res.status).toBe(200);
      const text = await res.text();
      return { text, data: (JSON.parse(text) as { data: Array<Record<string, unknown>> }).data };
    }

    for (const w of CROSSOVER_WRITES) {
      for (const who of CROSSOVER_STAFF) {
        it(`${w.name}: ${who} succeeds (${w.ok}); no staff marker in the response or the customer audit log`, async () => {
          const res = await call(who, w.method, w.path, w.body);
          const text = await res.text();
          expect(res.status, text).toBe(w.ok);
          expectNoStaffMarkers(text);
          expect(emitOrgEvent).not.toHaveBeenCalled();
          // Every one of these writes is audited under the staff id (ops
          // traceability) …
          expect(audits.length).toBeGreaterThan(0);
          // … and the customer sees it only as "Averrow SOC".
          const log = await customerAuditLog();
          expect(log.data.length).toBeGreaterThan(0);
          for (const row of log.data) expect(row.actor).toBe(AVERROW_SOC_LABEL);
          expectNoStaffMarkers(log.text);
        });
      }

      it(`${w.name}: auditor seat gets the explicit read-only 403 and writes nothing`, async () => {
        const before = snapshot();
        const res = await call("auditor", w.method, w.path, w.body);
        expect(res.status).toBe(403);
        expect((await res.json<{ error: string }>()).error).toBe(READ_ONLY_ERROR);
        expect(snapshot()).toBe(before);
        expect(audits).toEqual([]);
      });

      it(`${w.name}: client ${w.client} unchanged (${w.ok})`, async () => {
        const res = await call(w.client, w.method, w.path, w.body);
        expect(res.status, await res.clone().text()).toBe(w.ok);
      });
    }

    it("executive reads after a staff create carry no staff marker", async () => {
      expect((await call("super_admin", "POST", "/api/orgs/7/executives", { brand_id: "b1", full_name: "Staff Added" })).status).toBe(201);
      const res = await call("client_analyst", "GET", "/api/orgs/7/executives");
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain("Staff Added");
      expectNoStaffMarkers(text);
    });

    it("trademark asset upload: auditor gets the explicit read-only 403", async () => {
      const before = snapshot();
      const res = await call("auditor", "POST", "/api/orgs/7/modules/trademark/brands/b1/assets",
        { asset_type: "logo", content_type: "image/png", data_base64: PNG_B64 });
      expect(res.status).toBe(403);
      expect((await res.json<{ error: string }>()).error).toBe(READ_ONLY_ERROR);
      expect(snapshot()).toBe(before);
      expect(audits).toEqual([]);
    });

    it("trademark asset upload by staff succeeds; the customer drill-down never shows the staff creator", async () => {
      const body = { asset_type: "logo", asset_name: "Staff logo", content_type: "image/png", data_base64: PNG_B64 };
      for (const who of CROSSOVER_STAFF) {
        const res = await call(who, "POST", "/api/orgs/7/modules/trademark/brands/b1/assets", body);
        const text = await res.text();
        expect(res.status, text).toBe(201);
        expectNoStaffMarkers(text);
      }
      // Stored for ops traceability …
      const stored = raw.prepare("SELECT created_by FROM trademark_assets WHERE asset_name = 'Staff logo' ORDER BY rowid").all();
      expect(stored).toEqual([{ created_by: "u_staff" }, { created_by: "u_placeholder" }, { created_by: "u_admin" }]);
      // … never surfaced to the customer.
      const view = await call("client_analyst", "GET", "/api/orgs/7/modules/trademark/brands/b1");
      const viewText = await view.text();
      expect(view.status).toBe(200);
      expect(viewText).toContain("Staff logo");
      expect(viewText).not.toContain("created_by");
      expectNoStaffMarkers(viewText);
      const log = await customerAuditLog();
      expect(log.data.map((r) => r.action)).toEqual(["trademark_asset_upload", "trademark_asset_upload", "trademark_asset_upload"]);
      for (const row of log.data) expect(row.actor).toBe(AVERROW_SOC_LABEL);
      expectNoStaffMarkers(log.text);
    });

    it("a customer's crossover-surface audit row still names the customer", async () => {
      expect((await call("client_admin", "PATCH", "/api/orgs/7/executives/ex1", { title: "CFO" })).status).toBe(200);
      const log = await customerAuditLog();
      expect(log.data[0]).toMatchObject({ action: "executive_update", actor: "Alice Customer" });
    });

    describe("billing (Stripe fetch mocked)", () => {
      let stripeCalls: StripeCall[];

      beforeEach(() => {
        stripeCalls = [];
        (env as unknown as { STRIPE_API_KEY: string }).STRIPE_API_KEY = "sk_test_x";
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          stripeCalls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
          return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/s/1" }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        });
      });
      afterEach(() => { vi.restoreAllMocks(); });

      function checkoutParams(): URLSearchParams {
        expect(stripeCalls).toHaveLength(1);
        expect(stripeCalls[0]!.url).toContain("/checkout/sessions");
        return new URLSearchParams(stripeCalls[0]!.body);
      }

      function seatOwner(id: string, email: string, status = "active"): void {
        raw.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, 'client', ?)").run(id, email, `${id} Owner`, status);
        raw.prepare("INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES (7, ?, 'owner', 'active', 'manual')").run(id);
      }
      const seatCustomerOwner = (): void => seatOwner("t_olivia", "olivia@cust.example");

      for (const who of CROSSOVER_STAFF) {
        it(`${who} checkout: Stripe gets the customer owner's email, never the staff email`, async () => {
          seatCustomerOwner();
          const res = await call(who, "POST", "/api/orgs/7/billing/checkout-session", { plan_id: "professional" });
          const text = await res.text();
          expect(res.status, text).toBe(200);
          expectNoStaffMarkers(text);
          const params = checkoutParams();
          expect(params.get("customer_email")).toBe("olivia@cust.example");
          expectNoStaffMarkers(stripeCalls[0]!.body);
          expectNoStaffMarkers(stripeFormText(stripeCalls[0]!.body));
        });

        it(`${who} checkout with no Stripe customer and no customer owner (placeholder only): 409, Stripe never called`, async () => {
          const res = await call(who, "POST", "/api/orgs/7/billing/checkout-session", { plan_id: "professional" });
          expect(res.status).toBe(409);
          expect((await res.json<{ error: string }>()).error).toBe("Invite the customer owner before starting checkout");
          expect(stripeCalls).toEqual([]);
          expect(audits).toEqual([]);
        });

        it(`${who} checkout with an existing Stripe customer: OK without customer_email`, async () => {
          raw.prepare("UPDATE organizations SET stripe_customer_id = 'cus_7' WHERE id = 7").run();
          const res = await call(who, "POST", "/api/orgs/7/billing/checkout-session", { plan_id: "professional" });
          expect(res.status, await res.clone().text()).toBe(200);
          const params = checkoutParams();
          expect(params.get("customer")).toBe("cus_7");
          expect(params.has("customer_email")).toBe(false);
          expectNoStaffMarkers(stripeFormText(stripeCalls[0]!.body));
        });

        it(`${who} portal: only the org's Stripe customer + return URL are sent`, async () => {
          raw.prepare("UPDATE organizations SET stripe_customer_id = 'cus_7' WHERE id = 7").run();
          const res = await call(who, "POST", "/api/orgs/7/billing/portal-session", {});
          const text = await res.text();
          expect(res.status, text).toBe(200);
          expectNoStaffMarkers(text);
          expect(stripeCalls).toHaveLength(1);
          expect(stripeCalls[0]!.url).toContain("/billing_portal/sessions");
          const params = new URLSearchParams(stripeCalls[0]!.body);
          expect([...params.keys()].sort()).toEqual(["customer", "return_url"]);
          expect(params.get("customer")).toBe("cus_7");
          expectNoStaffMarkers(stripeFormText(stripeCalls[0]!.body));
        });
      }

      it("owner pick: the lowest org_members.id customer owner wins (not alphabetical)", async () => {
        seatOwner("t_zoe", "zoe@cust.example");
        seatOwner("t_adam", "adam@cust.example");
        const res = await call("super_admin", "POST", "/api/orgs/7/billing/checkout-session", { plan_id: "professional" });
        expect(res.status, await res.clone().text()).toBe(200);
        expect(checkoutParams().get("customer_email")).toBe("zoe@cust.example");
      });

      it("owner pick: a suspended customer owner is skipped", async () => {
        seatOwner("t_sus", "sus@cust.example", "suspended");
        seatOwner("t_act", "act@cust.example");
        const res = await call("super_admin", "POST", "/api/orgs/7/billing/checkout-session", { plan_id: "professional" });
        expect(res.status, await res.clone().text()).toBe(200);
        expect(checkoutParams().get("customer_email")).toBe("act@cust.example");
      });

      it("owner pick: only a suspended customer owner → 409, Stripe never called", async () => {
        seatOwner("t_sus", "sus@cust.example", "suspended");
        const res = await call("super_admin", "POST", "/api/orgs/7/billing/checkout-session", { plan_id: "professional" });
        expect(res.status).toBe(409);
        expect(stripeCalls).toEqual([]);
      });

      it("staff billing sessions are audited and appear as Averrow SOC in the customer audit log", async () => {
        seatCustomerOwner();
        expect((await call("super_admin", "POST", "/api/orgs/7/billing/checkout-session", { plan_id: "professional" })).status).toBe(200);
        raw.prepare("UPDATE organizations SET stripe_customer_id = 'cus_7' WHERE id = 7").run();
        expect((await call("admin_legacy", "POST", "/api/orgs/7/billing/portal-session", {})).status).toBe(200);
        const res = await call("client_analyst", "GET", "/api/orgs/7/audit-log");
        const text = await res.text();
        expect(res.status).toBe(200);
        const { data } = JSON.parse(text) as { data: Array<Record<string, unknown>> };
        expect(data.map((r) => r.action).sort()).toEqual(["billing_checkout_session", "billing_portal_session"]);
        for (const row of data) expect(row.actor).toBe(AVERROW_SOC_LABEL);
        expectNoStaffMarkers(text);
      });

      it("customer org admin checkout is unchanged: Stripe gets the caller's own email; audit row names the customer", async () => {
        seatCustomerOwner();
        const res = await call("client_admin", "POST", "/api/orgs/7/billing/checkout-session", { plan_id: "professional" });
        expect(res.status, await res.clone().text()).toBe(200);
        expect(checkoutParams().get("customer_email")).toBe("alice@cust.example");
        const log = await call("client_analyst", "GET", "/api/orgs/7/audit-log");
        const { data } = await log.json<{ data: Array<Record<string, unknown>> }>();
        expect(data[0]).toMatchObject({ action: "billing_checkout_session", actor: "Alice Customer" });
      });

      it("auditor seat (explicit read-only 403) and a client analyst are still refused", async () => {
        for (const who of ["auditor", "client_analyst"] as const) {
          for (const path of ["/api/orgs/7/billing/checkout-session", "/api/orgs/7/billing/portal-session"]) {
            const res = await call(who, "POST", path, { plan_id: "professional" });
            expect(res.status, `${who} ${path}`).toBe(403);
            if (who === "auditor") expect((await res.json<{ error: string }>()).error).toBe(READ_ONLY_ERROR);
          }
        }
        expect(stripeCalls).toEqual([]);
        expect(audits).toEqual([]);
      });
    });
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

    // Since migration 0276 staff notes live in staff_notes (stripped), so the
    // customer's own `notes` is returned again (#1778 had dropped it while
    // the column was shared with the ops PATCH).
    it("takedown detail masks requested_by/submitted_by, returns customer notes, strips staff_notes", async () => {
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
        notes: "customer takedown note",
      });
      expect(Object.keys(data.takedown).filter((k) => k.startsWith("staff_"))).toEqual([]);
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
