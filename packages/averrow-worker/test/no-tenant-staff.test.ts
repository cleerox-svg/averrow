// PR-F (owner decision 2026-10-03): no tenant-affiliated staff.
//
// Staff roles see ALL platform data (getOrgScope → null), so the two
// account-handling paths that could produce a staff user who is also a
// customer-org member are closed:
//
//   1. Admin role PATCH (/api/admin/users/:id) refuses a staff role for a
//      user holding an ACTIVE org_members row (status='active'; removal flips
//      it to 'removed').
//   2. Invite acceptance:
//      - an ORG invite (role 'client') accepted by an existing STAFF account
//        is refused instead of silently overwriting users.role with 'client';
//      - a STAFF invite accepted by an existing active org member is refused.
//      Normal client acceptance (existing client / new user) is unchanged.
//
// Real handlers against migration-derived SQLite (test/sqlite-d1-harness.ts).

import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { handleAdminUpdateUser } from "../src/handlers/admin/users";
import { handleInviteAcceptance } from "../src/handlers/auth";
import { hashToken } from "../src/lib/hash";
import type { Env } from "../src/types";

const TABLES = ["users", "org_members", "org_brands", "organizations", "invitations", "sessions"];

interface Rig { raw: SqliteDb; env: Env; audits: string[] }

function makeRig(): Rig {
  const raw = openDerivedDb(TABLES);
  raw.exec(`
    INSERT INTO users (id, email, name, role) VALUES
      ('root',   'root@averrow.com',   'Root',   'super_admin'),
      ('staff1', 'staff1@averrow.com', 'Staff',  'analyst'),
      ('admin1', 'admin1@averrow.com', 'Admin',  'admin'),
      ('cust1',  'cust1@acme.co',      'Cust',   'client'),
      ('cust2',  'cust2@acme.co',      'Former', 'client'),
      ('cust3',  'cust3@other.co',     'Fresh',  'client');
    INSERT INTO organizations (id, name, slug) VALUES (1, 'Acme', 'acme');
    INSERT INTO org_members (org_id, user_id, role, status) VALUES
      (1, 'cust1', 'viewer', 'active'),
      (1, 'cust2', 'viewer', 'removed');
  `);
  const audits: string[] = [];
  const auditDb = {
    prepare() {
      return {
        bind(...args: unknown[]) {
          return { async run() { audits.push(String(args[2])); return { success: true }; } };
        },
      };
    },
  };
  const env = {
    DB: d1FromSqlite(raw),
    AUDIT_DB: auditDb,
    CACHE: fakeKv(),
    JWT_SECRET: "test-secret-no-tenant-staff",
  } as unknown as Env;
  return { raw, env, audits };
}

function roleOf(raw: SqliteDb, id: string): string {
  const rows = raw.prepare("SELECT role FROM users WHERE id = ?").all(id) as Array<{ role: string }>;
  return rows[0]!.role;
}

function patch(body: unknown): Request {
  return new Request("https://averrow.com/api/admin/users/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!hasSqlite())("PR-F: admin role PATCH refuses staff roles for active org members", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  for (const role of ["analyst", "admin", "super_admin"] as const) {
    it(`refuses ${role} for an active org member (400, role unchanged)`, async () => {
      const res = await handleAdminUpdateUser(patch({ role }), rig.env, "cust1", "root", "super_admin");
      expect(res.status).toBe(400);
      const body = await res.json<{ success: boolean; error: string }>();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/active member of a customer organization/);
      expect(roleOf(rig.raw, "cust1")).toBe("client");
    });
  }

  it("allows promoting a user whose membership was removed (status='removed')", async () => {
    const res = await handleAdminUpdateUser(patch({ role: "analyst" }), rig.env, "cust2", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(roleOf(rig.raw, "cust2")).toBe("analyst");
  });

  it("still allows setting client on an org member, and status-only edits", async () => {
    expect((await handleAdminUpdateUser(patch({ role: "client" }), rig.env, "cust1", "root", "super_admin")).status).toBe(200);
    expect((await handleAdminUpdateUser(patch({ status: "suspended" }), rig.env, "cust1", "root", "super_admin")).status).toBe(200);
  });

  it("still allows staff-to-staff changes for an org-less user", async () => {
    const res = await handleAdminUpdateUser(patch({ role: "analyst" }), rig.env, "admin1", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(roleOf(rig.raw, "admin1")).toBe("analyst");
  });
});

describe.skipIf(!hasSqlite())("PR-F: invite acceptance never produces tenant staff", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  async function invite(id: string, email: string, role: string, orgId: number | null): Promise<string> {
    const token = `tok-${id}`;
    rig.raw.prepare(
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, expires_at, org_id, org_role)
       VALUES (?, ?, ?, ?, 'root', ?, ?, ?)`,
    ).run(id, email, role, await hashToken(token), new Date(Date.now() + 3_600_000).toISOString(),
      orgId, orgId ? "viewer" : null);
    return token;
  }

  function invStatus(id: string): string {
    return (rig.raw.prepare("SELECT status FROM invitations WHERE id = ?").all(id) as Array<{ status: string }>)[0]!.status;
  }

  function activeMemberships(userId: string): number {
    return (rig.raw.prepare("SELECT COUNT(*) AS n FROM org_members WHERE user_id = ? AND status = 'active'")
      .all(userId) as Array<{ n: number }>)[0]!.n;
  }

  const accept = (token: string, email: string, sub: string) =>
    handleInviteAcceptance(new Request("https://averrow.com/api/auth/callback"), rig.env,
      { sub, email, name: "Invitee" }, token, "https://averrow.com");

  it("org invite to an existing STAFF account: refused, users.role untouched, no membership", async () => {
    const token = await invite("inv1", "staff1@averrow.com", "client", 1);
    const res = await accept(token, "staff1@averrow.com", "g-staff1");
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("/auth/error");
    expect(decodeURIComponent(loc)).toMatch(/Averrow staff account/);
    expect(roleOf(rig.raw, "staff1")).toBe("analyst");
    expect(activeMemberships("staff1")).toBe(0);
    expect(invStatus("inv1")).toBe("pending");
    expect(rig.audits).toContain("invite_accept_refused_staff_account");
  });

  it("staff invite to an existing active ORG MEMBER: refused, still client", async () => {
    const token = await invite("inv2", "cust1@acme.co", "analyst", null);
    const res = await accept(token, "cust1@acme.co", "g-cust1");
    expect(res.headers.get("Location") ?? "").toContain("/auth/error");
    expect(roleOf(rig.raw, "cust1")).toBe("client");
    expect(invStatus("inv2")).toBe("pending");
    expect(rig.audits).toContain("invite_accept_refused_org_member");
  });

  it("normal client acceptance unchanged: existing client joins the org and gets a session", async () => {
    const token = await invite("inv3", "cust3@other.co", "client", 1);
    const res = await accept(token, "cust3@other.co", "g-cust3");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location") ?? "").toContain("#token=");
    expect(roleOf(rig.raw, "cust3")).toBe("client");
    expect(activeMemberships("cust3")).toBe(1);
    expect(invStatus("inv3")).toBe("accepted");
  });

  it("normal client acceptance unchanged: brand-new user is created as client member", async () => {
    const token = await invite("inv4", "new@acme.co", "client", 1);
    const res = await accept(token, "new@acme.co", "g-new");
    expect(res.headers.get("Location") ?? "").toContain("#token=");
    const rows = rig.raw.prepare("SELECT id, role FROM users WHERE email = ?").all("new@acme.co") as Array<{ id: string; role: string }>;
    expect(rows[0]!.role).toBe("client");
    expect(activeMemberships(rows[0]!.id)).toBe(1);
  });

  it("staff invite to an existing org-less account still works", async () => {
    const token = await invite("inv5", "admin1@averrow.com", "analyst", null);
    const res = await accept(token, "admin1@averrow.com", "g-admin1");
    expect(res.headers.get("Location") ?? "").not.toContain("/auth/error");
    expect(roleOf(rig.raw, "admin1")).toBe("analyst");
  });
});
