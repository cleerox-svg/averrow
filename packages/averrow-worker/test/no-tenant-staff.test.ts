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

  // A same-role staff invite to an existing org-less staff account still
  // works. (A DIFFERENT-role one is refused since #1766's follow-up — an
  // invite must never change an existing staff role; see rbac-invite.test.ts.)
  it("same-role staff invite to an existing org-less account still works", async () => {
    const token = await invite("inv5", "admin1@averrow.com", "admin", null);
    const res = await accept(token, "admin1@averrow.com", "g-admin1");
    expect(res.headers.get("Location") ?? "").not.toContain("/auth/error");
    expect(roleOf(rig.raw, "admin1")).toBe("admin");
  });
});

// ─── PR-F follow-ups ─────────────────────────────────────────────
//
// 1. Lead conversion seats the converting super_admin as a TEMPORARY org
//    owner (org_members.provisioned_by='lead_conversion'). The first customer
//    owner to accept an org invite deactivates it (this org only, audited),
//    and both staff guards ignore that placeholder row.
// 2. Invite acceptance matches existing accounts case-insensitively and
//    refuses if ANY matching row is staff.
// 3. Role PATCH refuses only an actual non-staff → staff change, and every
//    actual role change sets the forced_logout KV stamp.

interface FollowRig extends Rig { kv: ReturnType<typeof fakeKv> }

function makeFollowRig(): FollowRig {
  const rig = makeRig();
  const kv = fakeKv();
  (rig.env as unknown as { CACHE: KVNamespace }).CACHE = kv;
  rig.raw.exec(`
    INSERT INTO users (id, email, name, role) VALUES
      ('root2',    'root2@averrow.com', 'Root2',  'super_admin'),
      ('legacy1',  'legacy1@averrow.com', 'Legacy', 'analyst'),
      ('bobStaff', 'Bob@x.com',         'Bob',    'analyst'),
      ('bob2Cli',  'bob2@x.com',        'Bob2',   'client'),
      ('bob2Adm',  'Bob2@X.com',        'Bob2A',  'admin');
    INSERT INTO organizations (id, name, slug) VALUES (2, 'Globex', 'globex');
    INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES
      (1, 'root',    'owner',  'active', 'lead_conversion'),
      (2, 'root',    'owner',  'active', 'lead_conversion'),
      (2, 'root2',   'owner',  'active', 'lead_conversion'),
      (1, 'legacy1', 'viewer', 'active', 'invite');
  `);
  return { ...rig, kv };
}

async function seedInvite(raw: SqliteDb, id: string, email: string, role: string,
  orgId: number | null, orgRole: string | null): Promise<string> {
  const token = `tok-${id}`;
  raw.prepare(
    `INSERT INTO invitations (id, email, role, token_hash, invited_by, expires_at, org_id, org_role)
     VALUES (?, ?, ?, ?, 'root', ?, ?, ?)`,
  ).run(id, email, role, await hashToken(token), new Date(Date.now() + 3_600_000).toISOString(), orgId, orgRole);
  return token;
}

function memberRow(raw: SqliteDb, orgId: number, userId: string): { status: string; deprovisioned_at: string | null } {
  return (raw.prepare("SELECT status, deprovisioned_at FROM org_members WHERE org_id = ? AND user_id = ?")
    .all(orgId, userId) as Array<{ status: string; deprovisioned_at: string | null }>)[0]!;
}

const acceptOn = (rig: Rig, token: string, email: string, sub: string) =>
  handleInviteAcceptance(new Request("https://averrow.com/api/auth/callback"), rig.env,
    { sub, email, name: "Invitee" }, token, "https://averrow.com");

describe.skipIf(!hasSqlite())("PR-F follow-up: lead-conversion placeholder owner", () => {
  let rig: FollowRig;
  beforeEach(() => { rig = makeFollowRig(); });

  it("first customer owner acceptance removes this org's placeholder only, audited", async () => {
    // A non-owner customer joining first leaves the placeholder in place.
    const vTok = await seedInvite(rig.raw, "view1", "viewer@acme.co", "client", 1, "viewer");
    await acceptOn(rig, vTok, "viewer@acme.co", "g-viewer");
    expect(memberRow(rig.raw, 1, "root").status).toBe("active");
    expect(rig.audits).not.toContain("lead_conversion_placeholder_removed");

    const token = await seedInvite(rig.raw, "own1", "owner@acme.co", "client", 1, "owner");
    const res = await acceptOn(rig, token, "owner@acme.co", "g-owner");
    expect(res.headers.get("Location") ?? "").toContain("#token=");

    const placeholder = memberRow(rig.raw, 1, "root");
    expect(placeholder.status).toBe("removed");
    expect(placeholder.deprovisioned_at).not.toBeNull();
    // Other orgs' placeholders are untouched.
    expect(memberRow(rig.raw, 2, "root").status).toBe("active");
    expect(memberRow(rig.raw, 2, "root2").status).toBe("active");
    // The customer is now the active owner.
    const cust = (rig.raw.prepare("SELECT id FROM users WHERE email = ?").all("owner@acme.co") as Array<{ id: string }>)[0]!;
    expect(memberRow(rig.raw, 1, cust.id).status).toBe("active");
    expect(rig.audits).toContain("lead_conversion_placeholder_removed");
  });

  it("role PATCH allowed for a super_admin whose only membership is a lead_conversion placeholder", async () => {
    const res = await handleAdminUpdateUser(patch({ role: "admin" }), rig.env, "root2", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(roleOf(rig.raw, "root2")).toBe("admin");
  });

  it("same-role staff invite accepted by an account whose only membership is the placeholder still works", async () => {
    const token = await seedInvite(rig.raw, "stf1", "root2@averrow.com", "super_admin", null, null);
    const res = await acceptOn(rig, token, "root2@averrow.com", "g-root2");
    expect(res.headers.get("Location") ?? "").not.toContain("/auth/error");
    expect(roleOf(rig.raw, "root2")).toBe("super_admin");
    expect(memberRow(rig.raw, 2, "root2").status).toBe("active");
  });
});

describe.skipIf(!hasSqlite())("PR-F follow-up: invite acceptance staff lookup is case-insensitive and multi-row", () => {
  let rig: FollowRig;
  beforeEach(() => { rig = makeFollowRig(); });

  it("staff row `Bob@x.com` + org invite to `bob@x.com`: refused, no new account", async () => {
    const token = await seedInvite(rig.raw, "ci1", "bob@x.com", "client", 1, "viewer");
    const res = await acceptOn(rig, token, "bob@x.com", "g-bob-new");
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toMatch(/Averrow staff account/);
    expect(roleOf(rig.raw, "bobStaff")).toBe("analyst");
    const n = (rig.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE LOWER(email) = 'bob@x.com'").all() as Array<{ n: number }>)[0]!.n;
    expect(n).toBe(1);
    expect(rig.audits).toContain("invite_accept_refused_staff_account");
  });

  it("refuses when ANY matching row is staff, even if the exact-case row is a client", async () => {
    const token = await seedInvite(rig.raw, "ci2", "bob2@x.com", "client", 1, "viewer");
    const res = await acceptOn(rig, token, "bob2@x.com", "g-bob2");
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toMatch(/Averrow staff account/);
    expect(roleOf(rig.raw, "bob2Adm")).toBe("admin");
    const active = (rig.raw.prepare("SELECT COUNT(*) AS n FROM org_members WHERE user_id IN ('bob2Cli','bob2Adm') AND status = 'active'")
      .all() as Array<{ n: number }>)[0]!.n;
    expect(active).toBe(0);
  });
});

describe.skipIf(!hasSqlite())("PR-F follow-up: role PATCH change detection + token revocation", () => {
  let rig: FollowRig;
  beforeEach(() => { rig = makeFollowRig(); });

  it("a role change sets forced_logout; status-only and same-role PATCHes do not", async () => {
    expect((await handleAdminUpdateUser(patch({ status: "suspended" }), rig.env, "cust1", "root", "super_admin")).status).toBe(200);
    expect((await handleAdminUpdateUser(patch({ role: "client" }), rig.env, "cust1", "root", "super_admin")).status).toBe(200);
    expect(rig.kv.store.has("forced_logout:cust1")).toBe(false);

    const before = Math.floor(Date.now() / 1000);
    expect((await handleAdminUpdateUser(patch({ role: "analyst" }), rig.env, "cust2", "root", "super_admin")).status).toBe(200);
    const stamp = rig.kv.store.get("forced_logout:cust2");
    expect(stamp).toBeDefined();
    expect(Number(stamp)).toBeGreaterThanOrEqual(before);
  });

  it("same-role + status PATCH on an org-affiliated staff user is allowed (no change → no refusal)", async () => {
    const res = await handleAdminUpdateUser(patch({ role: "analyst", status: "suspended" }), rig.env, "legacy1", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(roleOf(rig.raw, "legacy1")).toBe("analyst");
    expect(rig.kv.store.has("forced_logout:legacy1")).toBe(false);
  });
});
