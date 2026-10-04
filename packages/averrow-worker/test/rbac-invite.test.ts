// Appsec + code review of #1766 — invite-acceptance role overwrite and
// owner-seat / concurrency follow-ups.
//
//  F1. Invite acceptance overwrote an EXISTING account's users.role with
//      invite.role: an `admin` (manage_invites) could mint a non-org invite
//      for a super_admin's email and demote them on acceptance, skipping the
//      super_admin-only rule, the placeholder cleanup and forced_logout. Now
//      refused for any staff account whose role differs; a client → staff
//      change through an invite stamps forced_logout.
//   2. PATCH → owner of a real member deactivates the org's lead-conversion
//      placeholder (same batch, audited).
//   3. transfer-ownership uses the caller's own owner row (orgs can have
//      several owners) and its writes are state-guarded: a concurrently
//      removed target → 409, no owner lost.
//   4. Optimistic concurrency on role writes: a role changed between the
//      handler's read and its UPDATE → 409.
//   6. Resending / revoking an OWNER invite needs the owner-seat rule.
//
// Real handlers against migration-derived SQLite (test/sqlite-d1-harness.ts).
// Imports nothing added by the fix, so it runs (and fails) on 910d6314.

import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { handleAdminUpdateUser } from "../src/handlers/admin/users";
import { handleInviteAcceptance } from "../src/handlers/auth";
import {
  handleRemoveOrgMember, handleResendOrgInvite, handleRevokeOrgInvite,
  handleTransferOwnership, handleUpdateOrgMember,
} from "../src/handlers/organizations";
import { hashToken } from "../src/lib/hash";
import type { AuthContext } from "../src/middleware/auth";
import type { Env, UserRole } from "../src/types";

const TABLES = ["users", "org_members", "org_brands", "organizations", "invitations", "sessions"];

/** A one-shot write injected just before the handler's next matching
 *  statement is prepared (or its next batch runs) — simulates a concurrent
 *  request landing between the handler's read and its write. */
interface RaceHook { onPrepare?: RegExp; onBatch?: boolean; sql: string; fired?: boolean }

interface Rig {
  raw: SqliteDb;
  env: Env;
  audits: Array<{ action: string; outcome: string }>;
  kv: ReturnType<typeof fakeKv>;
  race: (hook: RaceHook) => void;
}

function makeRig(): Rig {
  const raw = openDerivedDb(TABLES);
  raw.exec(`
    INSERT INTO users (id, email, name, role) VALUES
      ('root',    'root@averrow.com',   'Root',   'super_admin'),
      ('root2',   'root2@averrow.com',  'Root2',  'super_admin'),
      ('admin1',  'admin1@averrow.com', 'Admin1', 'admin'),
      ('staff1',  'staff1@averrow.com', 'Staff1', 'analyst'),
      ('custOwn', 'owner@initech.co',   'Owner',  'client'),
      ('own2',    'own2@initech.co',    'Own2',   'client'),
      ('adm3',    'adm3@initech.co',    'Adm3',   'client'),
      ('mem3',    'mem3@initech.co',    'Mem3',   'client'),
      ('custAdm', 'admin@acme.co',      'OrgAdm', 'client'),
      ('custView','viewer@acme.co',     'Viewer', 'client'),
      ('loner',   'loner@example.com',  'Loner',  'client'),
      ('zed',     'zed@acme.co',        'Zed',    'client');
    INSERT INTO organizations (id, name, slug, max_members) VALUES
      (1, 'Acme', 'acme', 50), (2, 'Globex', 'globex', 50), (3, 'Initech', 'initech', 50);
    INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES
      -- Acme: placeholder super_admin owner + customer members
      (1, 'root2',    'owner',  'active', 'lead_conversion'),
      (1, 'custAdm',  'admin',  'active', 'invite'),
      (1, 'custView', 'viewer', 'active', 'invite'),
      (2, 'root2',    'owner',  'active', 'lead_conversion'),
      -- Initech: TWO real owners (custOwn first), an org admin, a viewer
      (3, 'custOwn',  'owner',  'active', 'invite'),
      (3, 'own2',     'owner',  'active', 'invite'),
      (3, 'adm3',     'admin',  'active', 'invite'),
      (3, 'mem3',     'viewer', 'active', 'invite');
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
  const hooks: RaceHook[] = [];
  const fire = (match: (h: RaceHook) => boolean): void => {
    for (const h of hooks) {
      if (!h.fired && match(h)) { h.fired = true; raw.exec(h.sql); }
    }
  };
  const base = d1FromSqlite(raw);
  const db = {
    prepare: (sql: string) => { fire((h) => !!h.onPrepare?.test(sql)); return base.prepare(sql); },
    batch: async (stmts: D1PreparedStatement[]) => { fire((h) => !!h.onBatch); return base.batch(stmts); },
  } as unknown as D1Database;
  const kv = fakeKv();
  const env = {
    DB: db,
    AUDIT_DB: auditDb,
    CACHE: kv,
    JWT_SECRET: "test-secret-rbac-invite",
  } as unknown as Env;
  return { raw, env, audits, kv, race: (h) => hooks.push(h) };
}

const actions = (rig: Rig): string[] => rig.audits.map((a) => a.action);

function roleOf(raw: SqliteDb, id: string): string {
  return (raw.prepare("SELECT role FROM users WHERE id = ?").all(id) as Array<{ role: string }>)[0]!.role;
}

function member(raw: SqliteDb, orgId: number, userId: string): { role: string; status: string } | undefined {
  return (raw.prepare("SELECT role, status FROM org_members WHERE org_id = ? AND user_id = ?")
    .all(orgId, userId) as Array<{ role: string; status: string }>)[0];
}

function inviteStatus(raw: SqliteDb, id: string): string {
  return (raw.prepare("SELECT status FROM invitations WHERE id = ?").all(id) as Array<{ status: string }>)[0]!.status;
}

async function seedInvite(
  raw: SqliteDb, id: string, email: string, role: string, orgId: number | null = null, orgRole: string | null = null,
): Promise<string> {
  const token = `tok-${id}`;
  raw.prepare(
    `INSERT INTO invitations (id, email, role, token_hash, invited_by, expires_at, org_id, org_role)
     VALUES (?, ?, ?, ?, 'admin1', ?, ?, ?)`,
  ).run(id, email, role, await hashToken(token), new Date(Date.now() + 3_600_000).toISOString(), orgId, orgRole);
  return token;
}

function accept(rig: Rig, token: string, email: string, sub: string): Promise<Response> {
  return handleInviteAcceptance(new Request("https://averrow.com/api/auth/callback"), rig.env,
    { sub, email, name: "Accepter" }, token, "https://averrow.com");
}

const location = (res: Response): string => res.headers.get("Location") ?? "";

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

// ─── F1. invite acceptance must not change an existing staff role ──────

describe.skipIf(!hasSqlite())("F1: invite acceptance never changes an existing staff account's role", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  for (const inviteRole of ["analyst", "client"] as const) {
    it(`admin-minted ${inviteRole} invite (no org) to a super_admin's email → refused, role + placeholders intact, audited`, async () => {
      const token = await seedInvite(rig.raw, "inv-demote", "root2@averrow.com", inviteRole);
      const res = await accept(rig, token, "root2@averrow.com", "g-root2");
      expect(location(res)).toContain("/auth/error");
      expect(roleOf(rig.raw, "root2")).toBe("super_admin");
      expect(member(rig.raw, 1, "root2")!.status).toBe("active");
      expect(member(rig.raw, 2, "root2")!.status).toBe("active");
      expect(inviteStatus(rig.raw, "inv-demote")).toBe("pending");
      expect(rig.audits).toContainEqual({ action: "invite_accept_refused_staff_role_change", outcome: "denied" });
    });
  }

  it("a staff → staff role change (analyst invite to an admin) is refused too", async () => {
    const token = await seedInvite(rig.raw, "inv-a", "admin1@averrow.com", "analyst");
    const res = await accept(rig, token, "admin1@averrow.com", "g-admin1");
    expect(location(res)).toContain("/auth/error");
    expect(roleOf(rig.raw, "admin1")).toBe("admin");
  });

  it("same-role invite to a staff account still works (no revocation stamp)", async () => {
    const token = await seedInvite(rig.raw, "inv-same", "staff1@averrow.com", "analyst");
    const res = await accept(rig, token, "staff1@averrow.com", "g-staff1");
    expect(location(res)).toContain("#token=");
    expect(roleOf(rig.raw, "staff1")).toBe("analyst");
    expect(inviteStatus(rig.raw, "inv-same")).toBe("accepted");
    expect(rig.kv.store.has("forced_logout:staff1")).toBe(false);
  });

  it("brand-new user accepting a staff invite still works", async () => {
    const token = await seedInvite(rig.raw, "inv-new", "fresh@averrow.com", "analyst");
    const res = await accept(rig, token, "fresh@averrow.com", "g-fresh");
    expect(location(res)).toContain("#token=");
    const rows = rig.raw.prepare("SELECT role FROM users WHERE email = ?").all("fresh@averrow.com") as Array<{ role: string }>;
    expect(rows).toEqual([{ role: "analyst" }]);
  });

  it("existing org-less client accepting a staff invite: role changes AND forced_logout is stamped (before the new session)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await seedInvite(rig.raw, "inv-up", "loner@example.com", "analyst");
    const res = await accept(rig, token, "loner@example.com", "g-loner");
    expect(location(res)).toContain("#token=");
    expect(roleOf(rig.raw, "loner")).toBe("analyst");
    const stamp = rig.kv.store.get("forced_logout:loner");
    expect(stamp).toBeDefined();
    // Revokes tokens minted before the acceptance, but not the session the
    // acceptance itself just issued (iat = now; gate is iat <= stamp).
    const s = Number(stamp);
    expect(s).toBeGreaterThanOrEqual(before - 1);
    expect(s).toBeLessThan(Math.floor(Date.now() / 1000));
  });

  it("role changed by an admin between the lookup and the write → refused, the concurrent role stands", async () => {
    const token = await seedInvite(rig.raw, "inv-race", "loner@example.com", "analyst");
    rig.race({ onPrepare: /^UPDATE users SET google_sub/, sql: "UPDATE users SET role = 'super_admin' WHERE id = 'loner'" });
    const res = await accept(rig, token, "loner@example.com", "g-loner");
    expect(location(res)).toContain("/auth/error");
    expect(roleOf(rig.raw, "loner")).toBe("super_admin");
    expect(inviteStatus(rig.raw, "inv-race")).toBe("pending");
  });
});

// ─── 2. PATCH → owner deactivates the placeholder ───────────────

describe.skipIf(!hasSqlite())("PATCH a real member to owner ends the lead-conversion placeholder", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("placeholder removed in this org only, audited; the new owner can then transfer (stale admin JWT claim)", async () => {
    const res = await handleUpdateOrgMember(req("PATCH", { role: "owner" }), rig.env, "1", "custAdm", ctx("root", "super_admin"));
    expect(res.status).toBe(200);
    expect(member(rig.raw, 1, "custAdm")!.role).toBe("owner");
    expect(member(rig.raw, 1, "root2")!.status).toBe("removed");
    expect(member(rig.raw, 2, "root2")!.status).toBe("active");
    expect(actions(rig)).toContain("lead_conversion_placeholder_removed");

    // custAdm's JWT still says org_role=admin until refresh — D1 is authoritative.
    const t = await handleTransferOwnership(req("POST", { new_owner_user_id: "custView" }), rig.env, "1", ctx("custAdm", "client", "1", "admin"));
    expect(t.status).toBe(200);
    expect(member(rig.raw, 1, "custView")!.role).toBe("owner");
    expect(member(rig.raw, 1, "custAdm")!.role).toBe("admin");
  });

  it("PATCH to a non-owner role leaves the placeholder alone", async () => {
    const res = await handleUpdateOrgMember(req("PATCH", { role: "analyst" }), rig.env, "1", "custView", ctx("root", "super_admin"));
    expect(res.status).toBe(200);
    expect(member(rig.raw, 1, "root2")!.status).toBe("active");
  });
});

// ─── 3. ownership transfer ──────────────────────────────────────

describe.skipIf(!hasSqlite())("transfer-ownership: caller's own row, state-guarded writes", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("with two owners, the CALLER's owner row is the one demoted", async () => {
    const res = await handleTransferOwnership(req("POST", { new_owner_user_id: "mem3" }), rig.env, "3", ctx("own2", "client", "3", "owner"));
    expect(res.status).toBe(200);
    expect(member(rig.raw, 3, "mem3")!.role).toBe("owner");
    expect(member(rig.raw, 3, "own2")!.role).toBe("admin");
    expect(member(rig.raw, 3, "custOwn")!.role).toBe("owner");
  });

  it("an org admin with a stale owner claim is refused", async () => {
    const res = await handleTransferOwnership(req("POST", { new_owner_user_id: "mem3" }), rig.env, "3", ctx("adm3", "client", "3", "owner"));
    expect(res.status).toBe(403);
    expect(member(rig.raw, 3, "mem3")!.role).toBe("viewer");
  });

  it("target removed concurrently → 409, the transferring owner keeps the seat", async () => {
    // Single-owner org so a lost demote would leave it owner-less.
    rig.raw.exec(`UPDATE org_members SET status = 'removed' WHERE org_id = 3 AND user_id = 'own2'`);
    rig.race({ onBatch: true, sql: "UPDATE org_members SET status = 'removed' WHERE org_id = 3 AND user_id = 'mem3'" });
    const res = await handleTransferOwnership(req("POST", { new_owner_user_id: "mem3" }), rig.env, "3", ctx("custOwn", "client", "3", "owner"));
    expect(res.status).toBe(409);
    expect(member(rig.raw, 3, "custOwn")).toEqual({ role: "owner", status: "active" });
    const owners = (rig.raw.prepare(
      "SELECT COUNT(*) AS n FROM org_members WHERE org_id = 3 AND role = 'owner' AND status = 'active'").all() as Array<{ n: number }>)[0]!.n;
    expect(owners).toBe(1);
  });

  it("transferring owner demoted concurrently → 409, target not promoted", async () => {
    rig.race({ onBatch: true, sql: "UPDATE org_members SET role = 'admin' WHERE org_id = 3 AND user_id = 'own2'" });
    const res = await handleTransferOwnership(req("POST", { new_owner_user_id: "mem3" }), rig.env, "3", ctx("own2", "client", "3", "owner"));
    expect(res.status).toBe(409);
    expect(member(rig.raw, 3, "mem3")!.role).toBe("viewer");
  });

  it("super_admin with no row of its own prefers a real owner over the placeholder", async () => {
    // 'zed' sorts after 'root2' on both rowid and the (org_id, user_id)
    // index, so an unordered LIMIT 1 would pick the placeholder.
    rig.raw.exec(`INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES (1, 'zed', 'owner', 'active', 'invite')`);
    const res = await handleTransferOwnership(req("POST", { new_owner_user_id: "custView" }), rig.env, "1", ctx("root", "super_admin"));
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { previous_owner_user_id: string } }>();
    expect(body.data.previous_owner_user_id).toBe("zed");
    expect(member(rig.raw, 1, "zed")!.role).toBe("admin");
  });
});

// ─── 4. optimistic concurrency on role writes ───────────────────

describe.skipIf(!hasSqlite())("stale-role race → 409, concurrent change stands", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("admin role PATCH: target promoted to super_admin after the read → 409, not demoted", async () => {
    rig.race({ onPrepare: /^UPDATE users SET/, sql: "UPDATE users SET role = 'super_admin' WHERE id = 'staff1'" });
    const res = await handleAdminUpdateUser(req("PATCH", { role: "client" }), rig.env, "staff1", "admin1", "admin");
    expect(res.status).toBe(409);
    expect(roleOf(rig.raw, "staff1")).toBe("super_admin");
    expect(rig.kv.store.has("forced_logout:staff1")).toBe(false);
  });

  it("admin role PATCH demotion to client: a stale write leaves the placeholders alone", async () => {
    // root2 becomes admin (still staff) concurrently; the guarded write and
    // the placeholder deactivation both no-op.
    rig.race({ onPrepare: /^UPDATE users SET/, sql: "UPDATE users SET role = 'admin' WHERE id = 'root2'" });
    const res = await handleAdminUpdateUser(req("PATCH", { role: "client" }), rig.env, "root2", "root", "super_admin");
    expect(res.status).toBe(409);
    expect(roleOf(rig.raw, "root2")).toBe("admin");
    expect(member(rig.raw, 1, "root2")!.status).toBe("active");
  });

  it("org member PATCH: target promoted to owner after the read → 409 (org admin may not touch owners)", async () => {
    rig.race({ onPrepare: /^UPDATE org_members SET role = \?/, sql: "UPDATE org_members SET role = 'owner' WHERE org_id = 1 AND user_id = 'custView'" });
    const res = await handleUpdateOrgMember(req("PATCH", { role: "analyst" }), rig.env, "1", "custView", ctx("custAdm", "client", "1", "admin"));
    expect(res.status).toBe(409);
    expect(member(rig.raw, 1, "custView")!.role).toBe("owner");
  });

  it("org member remove: target promoted to owner after the read → 409, still active", async () => {
    rig.race({ onPrepare: /^UPDATE org_members SET status = 'removed'/, sql: "UPDATE org_members SET role = 'owner' WHERE org_id = 1 AND user_id = 'custView'" });
    const res = await handleRemoveOrgMember(req("DELETE"), rig.env, "1", "custView", ctx("custAdm", "client", "1", "admin"));
    expect(res.status).toBe(409);
    expect(member(rig.raw, 1, "custView")).toEqual({ role: "owner", status: "active" });
  });
});

// ─── 6. owner invites: resend / revoke ──────────────────────────

describe.skipIf(!hasSqlite())("resend / revoke an owner invite requires the owner-seat rule", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = makeRig();
    await seedInvite(rig.raw, "own-inv", "next@initech.co", "client", 3, "owner");
    await seedInvite(rig.raw, "view-inv", "v@initech.co", "client", 3, "viewer");
  });

  it("org admin cannot resend an owner invite (403, token not rotated)", async () => {
    const before = rig.raw.prepare("SELECT token_hash FROM invitations WHERE id = 'own-inv'").all();
    const res = await handleResendOrgInvite(req("POST"), rig.env, "3", "own-inv", ctx("adm3", "client", "3", "admin"));
    expect(res.status).toBe(403);
    expect(rig.raw.prepare("SELECT token_hash FROM invitations WHERE id = 'own-inv'").all()).toEqual(before);
  });

  it("org admin cannot revoke an owner invite (403, still pending)", async () => {
    const res = await handleRevokeOrgInvite(req("DELETE"), rig.env, "3", "own-inv", ctx("adm3", "client", "3", "admin"));
    expect(res.status).toBe(403);
    expect(inviteStatus(rig.raw, "own-inv")).toBe("pending");
  });

  it("org admin can still resend / revoke a non-owner invite", async () => {
    expect((await handleResendOrgInvite(req("POST"), rig.env, "3", "view-inv", ctx("adm3", "client", "3", "admin"))).status).toBe(200);
    expect((await handleRevokeOrgInvite(req("DELETE"), rig.env, "3", "view-inv", ctx("adm3", "client", "3", "admin"))).status).toBe(200);
  });

  it("org owner can resend and revoke an owner invite", async () => {
    expect((await handleResendOrgInvite(req("POST"), rig.env, "3", "own-inv", ctx("custOwn", "client", "3", "owner"))).status).toBe(200);
    expect((await handleRevokeOrgInvite(req("DELETE"), rig.env, "3", "own-inv", ctx("custOwn", "client", "3", "owner"))).status).toBe(200);
    expect(inviteStatus(rig.raw, "own-inv")).toBe("revoked");
  });
});
