// Takedown notes split (migration 0276, owner decision 2026-10-04).
//
// takedown_requests.notes used to be shared: the tenant PATCH wrote the
// customer's note and the ops admin PATCH overwrote the same column with the
// staff note, so #1778 had to drop `notes` from the tenant detail. Now:
//
//   S — the migration-derived schema carries takedown_requests.staff_notes,
//       added exactly once (0276).
//   O — ops PATCH /api/admin/takedowns/:id writes staff_notes (via
//       `staff_notes` or the legacy `notes` alias) and never touches the
//       customer's `notes`; null / "" clears; oversize / non-string → 400.
//   T — tenant PATCH /api/orgs/:orgId/takedowns/:id writes the customer
//       `notes` and never staff_notes; tenant POST/PATCH `notes` must be a
//       string ≤4000 chars (null / "" clears on PATCH), else 400.
//   R — tenant detail returns the customer `notes` and no `staff_*` key
//       (full JSON scanned); ops list returns both.
//   D — the unrouted tenant reads handleListTakedowns / handleGetTakedown
//       in handlers/takedowns.ts stay deleted.
//
// Real itty router (registerTenantRoutes + registerAdminRoutes) + signed
// JWTs, against in-memory SQLite derived from migrations/.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/lib/org-events", () => ({
  emitOrgEvent: vi.fn(async () => {}),
}));

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "itty-router";
import { registerTenantRoutes } from "../src/routes/tenant";
import { registerAdminRoutes } from "../src/routes/admin";
import * as takedownHandlers from "../src/handlers/takedowns";
import { MAX_TAKEDOWN_STAFF_NOTES_LENGTH, MAX_TAKEDOWN_NOTES_LENGTH } from "../src/handlers/takedowns";
import { signJWT } from "../src/lib/jwt";
import { deriveSchema, splitStatements } from "./migration-schema";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env, JWTPayload } from "../src/types";

const ROOT = resolve(__dirname, "..");
const SECRET = "test-secret-takedown-staff-notes";

const TABLES = [
  "users", "organizations", "brands", "org_brands", "org_members",
  "takedown_requests", "takedown_submissions", "takedown_evidence",
];

const CUSTOMER_NOTE = "customer wrote this note";
const STAFF_NOTE = "INTERNAL-SOC-NOTE do not show";

type Who = "analyst" | "client_analyst";

const PAYLOADS: Record<Who, Omit<JWTPayload, "iat" | "exp">> = {
  analyst:        { sub: "u_soc", email: "soc@averrow.local", role: "analyst" },
  client_analyst: { sub: "t_bob", email: "bob@cust.example", role: "client", org_id: "7", org_role: "analyst" },
};

let raw: SqliteDb;
let env: Env;
let router: ReturnType<typeof Router>;
let auditRows: Array<{ action: string; details: Record<string, unknown> | null }>;

/** Captures audit_log INSERTs (bind order per lib/audit.ts: id, user_id,
 *  action, resource_type, resource_id, details, …). */
function auditDb(): D1Database {
  return {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        auditRows.push({
          action: String(args[2]),
          details: typeof args[5] === "string" ? (JSON.parse(args[5]) as Record<string, unknown>) : null,
        });
        return { run: async () => ({ success: true, meta: {} }) };
      },
    }),
  } as unknown as D1Database;
}

function seed(db: SqliteDb): void {
  db.exec(`
    INSERT INTO organizations (id, name, slug) VALUES (7, 'Cust Seven', 'cust-seven');
    INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Brand One', 'one.example');
    INSERT INTO org_brands (org_id, brand_id) VALUES (7, 'b1');
    INSERT INTO users (id, email, name, role, status) VALUES
      ('u_soc', 'soc@averrow.local', 'Sam Soc', 'analyst', 'active'),
      ('t_bob', 'bob@cust.example', 'Bob Customer', 'client', 'active');
    INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES (7, 't_bob', 'analyst', 'active', 'manual');
    INSERT INTO takedown_requests (id, org_id, brand_id, target_type, target_value, evidence_summary, status, notes, staff_notes)
      VALUES ('td7', 7, 'b1', 'url', 'https://evil.example', 'evidence', 'draft', '${CUSTOMER_NOTE}', '${STAFF_NOTE}');
  `);
}

async function call(who: Who, method: string, path: string, body?: unknown): Promise<Response> {
  const token = await signJWT(PAYLOADS[who], SECRET, 300);
  const req = new Request(`https://averrow.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await router.fetch(req, env)) as Response;
}

function row(): { notes: string | null; staff_notes: string | null } {
  return raw.prepare("SELECT notes, staff_notes FROM takedown_requests WHERE id = 'td7'").all()[0] as {
    notes: string | null; staff_notes: string | null;
  };
}

describe("S: takedown_requests.staff_notes (migration-derived schema)", () => {
  it("derived schema includes staff_notes, contributed by 0276", () => {
    const schema = deriveSchema(["takedown_requests"]);
    expect(schema.columns.takedown_requests).toContain("staff_notes");
    expect(schema.columns.takedown_requests).toContain("notes");
    expect(schema.sources.takedown_requests).toContain("0276_takedown_staff_notes.sql");
  });

  it("is added by exactly one migration statement, in 0276", () => {
    const dir = resolve(ROOT, "migrations");
    const adders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      for (const stmt of splitStatements(readFileSync(resolve(dir, file), "utf8"))) {
        if (/^ALTER\s+TABLE\s+takedown_requests\s+ADD\s+COLUMN\s+staff_notes\b/i.test(stmt)) adders.push(file);
      }
    }
    expect(adders).toEqual(["0276_takedown_staff_notes.sql"]);
  });
});

describe.skipIf(!hasSqlite())("takedown notes split — real routers", () => {
  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    seed(raw);
    auditRows = [];
    env = {
      JWT_SECRET: SECRET,
      DB: d1FromSqlite(raw),
      CACHE: fakeKv(),
      AUDIT_DB: auditDb(),
    } as unknown as Env;
    router = Router();
    registerTenantRoutes(router);
    registerAdminRoutes(router);
  });

  describe("O: ops admin PATCH writes staff_notes only", () => {
    it("staff_notes sets staff_notes and leaves the customer's notes", async () => {
      const res = await call("analyst", "PATCH", "/api/admin/takedowns/td7", { staff_notes: "new soc note" });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(row()).toEqual({ notes: CUSTOMER_NOTE, staff_notes: "new soc note" });
    });

    it("legacy `notes` on the ops route is an alias for staff_notes, never the customer column", async () => {
      const res = await call("analyst", "PATCH", "/api/admin/takedowns/td7", { notes: "alias note" });
      expect(res.status).toBe(200);
      expect(row()).toEqual({ notes: CUSTOMER_NOTE, staff_notes: "alias note" });
    });

    it("null and empty string clear staff_notes", async () => {
      expect((await call("analyst", "PATCH", "/api/admin/takedowns/td7", { staff_notes: null })).status).toBe(200);
      expect(row()).toEqual({ notes: CUSTOMER_NOTE, staff_notes: null });
      raw.exec(`UPDATE takedown_requests SET staff_notes = 'x' WHERE id = 'td7'`);
      expect((await call("analyst", "PATCH", "/api/admin/takedowns/td7", { staff_notes: "" })).status).toBe(200);
      expect(row().staff_notes).toBeNull();
    });

    it("both `staff_notes` and `notes` in one ops body: staff_notes wins, customer notes untouched", async () => {
      const res = await call("analyst", "PATCH", "/api/admin/takedowns/td7", {
        staff_notes: "the staff note", notes: "should not land anywhere",
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(row()).toEqual({ notes: CUSTOMER_NOTE, staff_notes: "the staff note" });
    });

    it("audit details flag staff_notes_changed (set and clear), never the note text", async () => {
      expect((await call("analyst", "PATCH", "/api/admin/takedowns/td7", { staff_notes: "audited note" })).status).toBe(200);
      expect((await call("analyst", "PATCH", "/api/admin/takedowns/td7", { staff_notes: null })).status).toBe(200);
      const updates = auditRows.filter((r) => r.action === "admin_takedown_update");
      expect(updates).toHaveLength(2);
      for (const u of updates) {
        expect(u.details).toMatchObject({ staff_notes_changed: true });
        expect(JSON.stringify(u.details)).not.toContain("audited note");
      }
    });

    it("a status-only ops PATCH does not flag staff_notes_changed", async () => {
      // draft → withdrawn: staff can no longer move a row INTO 'requested' (G21).
      expect((await call("analyst", "PATCH", "/api/admin/takedowns/td7", { status: "withdrawn" })).status).toBe(200);
      const u = auditRows.find((r) => r.action === "admin_takedown_update");
      expect(u?.details).not.toHaveProperty("staff_notes_changed");
    });

    it("rejects non-string and oversize staff_notes with 400, nothing written", async () => {
      expect((await call("analyst", "PATCH", "/api/admin/takedowns/td7", { staff_notes: 42 })).status).toBe(400);
      const big = "a".repeat(MAX_TAKEDOWN_STAFF_NOTES_LENGTH + 1);
      expect((await call("analyst", "PATCH", "/api/admin/takedowns/td7", { staff_notes: big })).status).toBe(400);
      expect(row()).toEqual({ notes: CUSTOMER_NOTE, staff_notes: STAFF_NOTE });
    });
  });

  describe("T: tenant PATCH writes the customer's notes only", () => {
    it("sets notes and leaves staff_notes", async () => {
      const res = await call("client_analyst", "PATCH", "/api/orgs/7/takedowns/td7", { notes: "updated by customer" });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(row()).toEqual({ notes: "updated by customer", staff_notes: STAFF_NOTE });
    });

    it("both `notes` and `staff_notes` in one tenant body: writes only notes", async () => {
      const res = await call("client_analyst", "PATCH", "/api/orgs/7/takedowns/td7", {
        notes: "customer edit", staff_notes: "spoof",
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(row()).toEqual({ notes: "customer edit", staff_notes: STAFF_NOTE });
    });

    it("null and empty string clear the customer's notes", async () => {
      expect((await call("client_analyst", "PATCH", "/api/orgs/7/takedowns/td7", { notes: null })).status).toBe(200);
      expect(row()).toEqual({ notes: null, staff_notes: STAFF_NOTE });
      raw.exec(`UPDATE takedown_requests SET notes = 'x' WHERE id = 'td7'`);
      expect((await call("client_analyst", "PATCH", "/api/orgs/7/takedowns/td7", { notes: "" })).status).toBe(200);
      expect(row().notes).toBeNull();
    });

    it("rejects number / object / oversize notes with 400, nothing written", async () => {
      const big = "a".repeat(MAX_TAKEDOWN_NOTES_LENGTH + 1);
      for (const notes of [42, { x: 1 }, big]) {
        const res = await call("client_analyst", "PATCH", "/api/orgs/7/takedowns/td7", { notes });
        expect(res.status, JSON.stringify(notes).slice(0, 20)).toBe(400);
      }
      expect(row()).toEqual({ notes: CUSTOMER_NOTE, staff_notes: STAFF_NOTE });
    });

    it("tenant POST rejects number / object / oversize notes with 400, nothing inserted", async () => {
      const big = "a".repeat(MAX_TAKEDOWN_NOTES_LENGTH + 1);
      for (const notes of [42, { x: 1 }, big]) {
        const res = await call("client_analyst", "POST", "/api/orgs/7/takedowns", {
          brand_id: "b1", target_type: "url", target_value: "https://bad.example", evidence_summary: "e", notes,
        });
        expect(res.status, JSON.stringify(notes).slice(0, 20)).toBe(400);
      }
      const n = raw.prepare("SELECT COUNT(*) AS n FROM takedown_requests").all()[0] as { n: number };
      expect(n.n).toBe(1);
    });

    it("tenant POST with a valid string note stores it as the customer's notes (201)", async () => {
      const res = await call("client_analyst", "POST", "/api/orgs/7/takedowns", {
        brand_id: "b1", target_type: "url", target_value: "https://bad.example", evidence_summary: "e", notes: "hello",
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const { data } = await res.json<{ data: { id: string } }>();
      const r = raw.prepare("SELECT notes, staff_notes FROM takedown_requests WHERE id = ?").all(data.id)[0];
      expect(r).toEqual({ notes: "hello", staff_notes: null });
    });

    it("a staff_notes key in the tenant body is ignored", async () => {
      const res = await call("client_analyst", "PATCH", "/api/orgs/7/takedowns/td7", { staff_notes: "spoof" });
      expect(res.status).toBe(400); // no valid tenant fields
      expect(row()).toEqual({ notes: CUSTOMER_NOTE, staff_notes: STAFF_NOTE });
    });
  });

  describe("R: reads", () => {
    it("tenant detail returns the customer's notes and never staff_notes (full JSON)", async () => {
      const res = await call("client_analyst", "GET", "/api/orgs/7/takedowns/td7");
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain(STAFF_NOTE);
      expect(text).not.toContain("staff_notes");
      expect(text).not.toMatch(/"staff_/);
      const { data } = JSON.parse(text) as { data: { takedown: Record<string, unknown> } };
      expect(data.takedown.notes).toBe(CUSTOMER_NOTE);
    });

    it("tenant list never carries either note column", async () => {
      const res = await call("client_analyst", "GET", "/api/orgs/7/takedowns");
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain(STAFF_NOTE);
      expect(text).not.toMatch(/"staff_/);
    });

    it("ops list returns both the customer notes and staff_notes", async () => {
      const res = await call("analyst", "GET", "/api/admin/takedowns?scope=all");
      expect(res.status, await res.clone().text()).toBe(200);
      const body = await res.json<{ data: Array<Record<string, unknown>> }>();
      const td = body.data.find((t) => t.id === "td7");
      expect(td).toMatchObject({ notes: CUSTOMER_NOTE, staff_notes: STAFF_NOTE });
    });
  });
});

describe("D: unrouted tenant reads stay deleted from handlers/takedowns.ts", () => {
  it("handleListTakedowns / handleGetTakedown are no longer exported or defined", () => {
    const mod = takedownHandlers as Record<string, unknown>;
    expect(mod.handleListTakedowns).toBeUndefined();
    expect(mod.handleGetTakedown).toBeUndefined();
    const src = readFileSync(resolve(ROOT, "src/handlers/takedowns.ts"), "utf8");
    expect(src).not.toMatch(/(?:function|const)\s+handleListTakedowns\b/);
    expect(src).not.toMatch(/(?:function|const)\s+handleGetTakedown\b/);
  });
});
