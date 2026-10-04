// Appsec review of #1765 — RBAC demotion / placeholder-owner fixes.
//
//  1. Role PATCH: only super_admin may change a role when EITHER the requested
//     role OR the target's current role is admin/super_admin (an admin could
//     previously demote a super_admin).
//  2. staff → client demotion deactivates the user's lead_conversion
//     placeholder owner rows in the same batch (audited), so the next refresh
//     can't embed them as org_id/org_role=owner. The placeholder exemption in
//     the no-tenant-staff guards applies only while the user is staff.
//  3. Ownership transfer to a real member deactivates the org's placeholder.
//  4. forced_logout KV failure after a committed role change → 200 with
//     revocation_pending + warning, audited.
//  5. Org-level admins (customers) can't invite / promote an owner.
//  6. Removing / demoting the last active owner is refused (409).
//
// Real handlers against migration-derived SQLite (test/sqlite-d1-harness.ts).
// Deliberately imports nothing added by the fix, so it runs (and fails) on
// the pre-fix tree too.

import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { handleAdminUpdateUser } from "../src/handlers/admin/users";
import { handleInviteAcceptance } from "../src/handlers/auth";
import {
  handleOrgInvite, handleRemoveOrgMember, handleTransferOwnership, handleUpdateOrgMember,
} from "../src/handlers/organizations";
import { loadOrgScopeForToken, type AuthContext } from "../src/middleware/auth";
import { hashToken } from "../src/lib/hash";
import type { Env, UserRole } from "../src/types";

const TABLES = ["users", "org_members", "org_brands", "organizations", "invitations", "sessions"];

interface Rig { raw: SqliteDb; env: Env; audits: Array<{ action: string; outcome: string }>; kv: ReturnType<typeof fakeKv> }

function makeRig(): Rig {
  const raw = openDerivedDb(TABLES);
  raw.exec(`
    INSERT INTO users (id, email, name, role) VALUES
      ('root',    'root@averrow.com',    'Root',    'super_admin'),
      ('root2',   'root2@averrow.com',   'Root2',   'super_admin'),
      ('admin1',  'admin1@averrow.com',  'Admin1',  'admin'),
      ('admin2',  'admin2@averrow.com',  'Admin2',  'admin'),
      ('staff1',  'staff1@averrow.com',  'Staff1',  'analyst'),
      ('custOwn', 'owner@acme.co',       'Owner',   'client'),
      ('custAdm', 'admin@acme.co',       'OrgAdm',  'client'),
      ('custView','viewer@acme.co',      'Viewer',  'client'),
      ('exStaff', 'ex@averrow.com',      'Ex',      'client');
    INSERT INTO organizations (id, name, slug, max_members) VALUES
      (1, 'Acme', 'acme', 50), (2, 'Globex', 'globex', 50), (3, 'Initech', 'initech', 50);
    INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES
      -- Acme: placeholder super_admin owner + customer members (no customer owner yet)
      (1, 'root2',    'owner',  'active', 'lead_conversion'),
      (1, 'custAdm',  'admin',  'active', 'invite'),
      (1, 'custView', 'viewer', 'active', 'invite'),
      -- Globex: placeholder for root2 too
      (2, 'root2',    'owner',  'active', 'lead_conversion'),
      -- Initech: single real customer owner + viewer
      (3, 'custOwn',  'owner',  'active', 'invite'),
      -- legacy: a client still holding an active placeholder (pre-fix demotion)
      (2, 'exStaff',  'admin',  'active', 'lead_conversion');
  `);
  const audits: Array<{ action: string; outcome: string }> = [];
  const auditDb = {
    prepare() {
      return {
        bind(...args: unknown[]) {
          return { async run() { audits.push({ action: String(args[2]), outcome: String(args[8]) }); return { success: true }; } };
        },
      };
    },
  };
  const kv = fakeKv();
  const env = {
    DB: d1FromSqlite(raw),
    AUDIT_DB: auditDb,
    CACHE: kv,
    JWT_SECRET: "test-secret-rbac-demotion",
  } as unknown as Env;
  return { raw, env, audits, kv };
}

const actions = (rig: Rig): string[] => rig.audits.map((a) => a.action);

function roleOf(raw: SqliteDb, id: string): string {
  return (raw.prepare("SELECT role FROM users WHERE id = ?").all(id) as Array<{ role: string }>)[0]!.role;
}

function member(raw: SqliteDb, orgId: number, userId: string): { role: string; status: string; deprovisioned_at: string | null } | undefined {
  return (raw.prepare("SELECT role, status, deprovisioned_at FROM org_members WHERE org_id = ? AND user_id = ?")
    .all(orgId, userId) as Array<{ role: string; status: string; deprovisioned_at: string | null }>)[0];
}

function req(method: string, body?: unknown): Request {
  return new Request("https://averrow.com/api/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ctx(userId: string, role: UserRole, orgId: string | null = null, orgRole: string | null = null): AuthContext {
  return { userId, email: `${userId}@x`, role, orgId, orgRole, embeddedScope: undefined } as AuthContext;
}

// ─── 1. privileged-target role changes ──────────────────────────

describe.skipIf(!hasSqlite())("role PATCH: only super_admin may change an admin/super_admin account", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  for (const [target, to] of [["root", "analyst"], ["root", "client"], ["admin2", "analyst"], ["admin2", "client"]] as const) {
    it(`admin cannot change ${target} → ${to}: 403, unchanged`, async () => {
      const before = roleOf(rig.raw, target);
      const res = await handleAdminUpdateUser(req("PATCH", { role: to }), rig.env, target, "admin1", "admin");
      expect(res.status).toBe(403);
      expect(roleOf(rig.raw, target)).toBe(before);
    });
  }

  it("admin cannot suspend a super_admin either", async () => {
    const res = await handleAdminUpdateUser(req("PATCH", { status: "suspended" }), rig.env, "root", "admin1", "admin");
    expect(res.status).toBe(403);
  });

  it("super_admin can demote an admin; admin can still manage non-privileged staff", async () => {
    expect((await handleAdminUpdateUser(req("PATCH", { role: "analyst" }), rig.env, "admin2", "root", "super_admin")).status).toBe(200);
    expect(roleOf(rig.raw, "admin2")).toBe("analyst");
    expect((await handleAdminUpdateUser(req("PATCH", { role: "client" }), rig.env, "staff1", "admin1", "admin")).status).toBe(200);
    expect(roleOf(rig.raw, "staff1")).toBe("client");
  });
});

// ─── 2. staff → client clears placeholders ──────────────────────

describe.skipIf(!hasSqlite())("staff → client demotion deactivates lead_conversion placeholders", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("super_admin with placeholders demoted to client: rows removed in the same request, audited, no org on next token", async () => {
    const res = await handleAdminUpdateUser(req("PATCH", { role: "client" }), rig.env, "root2", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(roleOf(rig.raw, "root2")).toBe("client");
    for (const org of [1, 2]) {
      const row = member(rig.raw, org, "root2")!;
      expect(row.status).toBe("removed");
      expect(row.deprovisioned_at).not.toBeNull();
    }
    expect(actions(rig)).toContain("lead_conversion_placeholder_removed");

    // The refresh/issueSession membership lookups read active org_members rows.
    const active = (rig.raw.prepare(
      `SELECT om.org_id FROM org_members om JOIN organizations o ON o.id = om.org_id
       WHERE om.user_id = ? AND om.status = 'active'`).all("root2") as unknown[]).length;
    expect(active).toBe(0);
    expect(await loadOrgScopeForToken(rig.env.DB, "root2", "client")).toEqual({ org_id: 0, brand_ids: [] });
    // Other members of those orgs are untouched.
    expect(member(rig.raw, 1, "custAdm")!.status).toBe("active");
  });

  it("staff → staff change leaves placeholders alone", async () => {
    expect((await handleAdminUpdateUser(req("PATCH", { role: "admin" }), rig.env, "root2", "root", "super_admin")).status).toBe(200);
    expect(member(rig.raw, 1, "root2")!.status).toBe("active");
  });
});

describe.skipIf(!hasSqlite())("placeholder exemption applies only while the user is staff", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("client holding a leftover placeholder cannot be promoted to staff (400)", async () => {
    const res = await handleAdminUpdateUser(req("PATCH", { role: "analyst" }), rig.env, "exStaff", "root", "super_admin");
    expect(res.status).toBe(400);
    expect(roleOf(rig.raw, "exStaff")).toBe("client");
  });

  it("staff invite accepted by a client holding a leftover placeholder is refused", async () => {
    const token = "tok-stf";
    rig.raw.prepare(
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, expires_at)
       VALUES ('stf', 'ex@averrow.com', 'analyst', ?, 'root', ?)`,
    ).run(await hashToken(token), new Date(Date.now() + 3_600_000).toISOString());
    const res = await handleInviteAcceptance(new Request("https://averrow.com/api/auth/callback"), rig.env,
      { sub: "g-ex", email: "ex@averrow.com", name: "Ex" }, token, "https://averrow.com");
    expect(res.headers.get("Location") ?? "").toContain("/auth/error");
    expect(roleOf(rig.raw, "exStaff")).toBe("client");
    expect(actions(rig)).toContain("invite_accept_refused_org_member");
  });
});

// ─── 3. ownership transfer ──────────────────────────────────────

describe.skipIf(!hasSqlite())("ownership transfer away from the placeholder", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("transfer to a customer member deactivates the org's placeholder (this org only), audited", async () => {
    const res = await handleTransferOwnership(req("POST", { new_owner_user_id: "custAdm" }), rig.env, "1", ctx("root", "super_admin"));
    expect(res.status).toBe(200);
    expect(member(rig.raw, 1, "custAdm")!.role).toBe("owner");
    const placeholder = member(rig.raw, 1, "root2")!;
    expect(placeholder.status).toBe("removed");
    expect(placeholder.deprovisioned_at).not.toBeNull();
    expect(member(rig.raw, 2, "root2")!.status).toBe("active");
    expect(actions(rig)).toContain("lead_conversion_placeholder_removed");
  });
});

// ─── 4. KV revocation failure ───────────────────────────────────

describe.skipIf(!hasSqlite())("forced_logout KV failure after a role change", () => {
  it("role committed, 200 with revocation_pending + warning, failure audited", async () => {
    const rig = makeRig();
    (rig.env as unknown as { CACHE: KVNamespace }).CACHE = {
      ...rig.kv,
      put: async () => { throw new Error("KV unavailable"); },
    } as unknown as KVNamespace;
    const res = await handleAdminUpdateUser(req("PATCH", { role: "analyst" }), rig.env, "admin2", "root", "super_admin");
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; revocation_pending?: boolean; warning?: string }>();
    expect(body.success).toBe(true);
    expect(body.revocation_pending).toBe(true);
    expect(body.warning).toMatch(/sessions/);
    expect(roleOf(rig.raw, "admin2")).toBe("analyst");
    expect(rig.audits).toContainEqual({ action: "user_role_change_revocation_failed", outcome: "failure" });
  });
});

// ─── 5. owner invites / promotions ──────────────────────────────

describe.skipIf(!hasSqlite())("org owner seat: only org owners and platform admins", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("customer org admin cannot invite an owner (403, no invitation row)", async () => {
    const res = await handleOrgInvite(req("POST", { email: "x@acme.co", org_role: "owner" }), rig.env, "1", ctx("custAdm", "client", "1", "admin"));
    expect(res.status).toBe(403);
    expect((rig.raw.prepare("SELECT COUNT(*) AS n FROM invitations").all() as Array<{ n: number }>)[0]!.n).toBe(0);
  });

  it("customer org admin can still invite non-owner roles", async () => {
    const res = await handleOrgInvite(req("POST", { email: "x@acme.co", org_role: "admin" }), rig.env, "1", ctx("custAdm", "client", "1", "admin"));
    expect(res.status).toBe(201);
  });

  it("org owner and super_admin can invite an owner", async () => {
    expect((await handleOrgInvite(req("POST", { email: "a@initech.co", org_role: "owner" }), rig.env, "3", ctx("custOwn", "client", "3", "owner"))).status).toBe(201);
    expect((await handleOrgInvite(req("POST", { email: "b@acme.co", org_role: "owner" }), rig.env, "1", ctx("root", "super_admin"))).status).toBe(201);
  });

  it("a stale org_role=owner JWT claim does not satisfy the owner check", async () => {
    const res = await handleOrgInvite(req("POST", { email: "x@acme.co", org_role: "owner" }), rig.env, "1", ctx("custAdm", "client", "1", "owner"));
    expect(res.status).toBe(403);
  });

  it("customer org admin cannot PATCH themselves to owner", async () => {
    const res = await handleUpdateOrgMember(req("PATCH", { role: "owner" }), rig.env, "1", "custAdm", ctx("custAdm", "client", "1", "admin"));
    expect(res.status).toBe(403);
    expect(member(rig.raw, 1, "custAdm")!.role).toBe("admin");
  });
});

// ─── 6. last-owner guard ────────────────────────────────────────

describe.skipIf(!hasSqlite())("never leave an org with zero active owners", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("removing the last active owner → 409, row stays active", async () => {
    const res = await handleRemoveOrgMember(req("DELETE"), rig.env, "3", "custOwn", ctx("root", "super_admin"));
    expect(res.status).toBe(409);
    expect(member(rig.raw, 3, "custOwn")!.status).toBe("active");
  });

  it("demoting the last active owner via PATCH → 409", async () => {
    const res = await handleUpdateOrgMember(req("PATCH", { role: "viewer" }), rig.env, "3", "custOwn", ctx("root", "super_admin"));
    expect(res.status).toBe(409);
    expect(member(rig.raw, 3, "custOwn")!.role).toBe("owner");
  });

  it("removing the placeholder while a customer owner exists still works", async () => {
    rig.raw.exec(`INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES (1, 'custOwn', 'owner', 'active', 'invite')`);
    const res = await handleRemoveOrgMember(req("DELETE"), rig.env, "1", "root2", ctx("root", "super_admin"));
    expect(res.status).toBe(200);
    expect(member(rig.raw, 1, "root2")!.status).toBe("removed");
  });

  it("customer org admin cannot remove an owner (403)", async () => {
    rig.raw.exec(`INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES (1, 'custOwn', 'owner', 'active', 'invite')`);
    const res = await handleRemoveOrgMember(req("DELETE"), rig.env, "1", "custOwn", ctx("custAdm", "client", "1", "admin"));
    expect(res.status).toBe(403);
    expect(member(rig.raw, 1, "custOwn")!.status).toBe("active");
  });

  it("non-owner removal unchanged", async () => {
    const res = await handleRemoveOrgMember(req("DELETE"), rig.env, "1", "custView", ctx("custAdm", "client", "1", "admin"));
    expect(res.status).toBe(200);
  });
});
