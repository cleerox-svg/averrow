import { describe, it, expect } from "vitest";
import {
  maskIp, handleListOwnSessions, handleRevokeOwnSession,
  handleRevokeOtherSessions, handleLogoutEverywhere,
} from "../src/handlers/account-sessions";
import { hashToken } from "../src/lib/hash";
import { maskIp as sharedMaskIp } from "../../shared/src/account/security/sessions";
import type { Env } from "../src/types";

const U1 = { userId: "u1", role: "analyst" as const };

interface Row {
  id: string; user_id: string; refresh_token_hash: string; previous_token_hash: string | null;
  ip_address: string | null; user_agent: string | null; issued_at: string; rotated_at: string | null;
  auth_method: string | null; revoked_at: string | null;
}

function makeEnv(rows: Row[]) {
  const kv = new Map<string, string>();
  const live = (r: Row, uid: string) => r.user_id === uid && r.revoked_at === null;
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          if (sql.includes("SELECT id FROM sessions")) {
            const [uid, h1, h2] = args as string[];
            const r = rows.find((x) => live(x, uid!) && (x.refresh_token_hash === h1 || x.previous_token_hash === h2));
            return r ? { id: r.id } : null;
          }
          return null;
        },
        async all() {
          if (sql.includes("RETURNING id")) {
            const out: Array<{ id: string }> = [];
            if (sql.includes("id != ?")) {
              const [uid, keep] = args as string[];
              for (const r of rows) if (live(r, uid!) && r.id !== keep) { r.revoked_at = "now"; out.push({ id: r.id }); }
            } else {
              const [uid] = args as string[];
              for (const r of rows) if (live(r, uid!)) { r.revoked_at = "now"; out.push({ id: r.id }); }
            }
            return { results: out };
          }
          const [uid] = args as string[];
          return { results: rows.filter((r) => live(r, uid!)) };
        },
        async run() {
          let changes = 0;
          if (sql.includes("id = ? AND user_id = ?")) {
            const [id, uid] = args as string[];
            for (const r of rows) if (r.id === id && live(r, uid!)) { r.revoked_at = "now"; changes++; }
          } else if (sql.includes("id != ?")) {
            const [uid, keep] = args as string[];
            for (const r of rows) if (live(r, uid!) && r.id !== keep) { r.revoked_at = "now"; changes++; }
          } else if (sql.includes("UPDATE sessions")) {
            const [uid] = args as string[];
            for (const r of rows) if (live(r, uid!)) { r.revoked_at = "now"; changes++; }
          }
          return { meta: { changes } };
        },
      };
      return stmt;
    },
  };
  const env = {
    DB: db,
    AUDIT_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
    CACHE: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, v); },
    },
  } as unknown as Env;
  return { env, kv };
}

async function seed() {
  const cur = "cur-token";
  const rows: Row[] = [
    { id: "s-old", user_id: "u1", refresh_token_hash: "x1", previous_token_hash: null, ip_address: "10.0.0.5", user_agent: "UA-old", issued_at: "2026-10-01 10:00:00", rotated_at: null, auth_method: "google_oauth", revoked_at: null },
    { id: "s-cur", user_id: "u1", refresh_token_hash: await hashToken(cur), previous_token_hash: null, ip_address: "203.0.113.42", user_agent: "UA-cur", issued_at: "2026-10-02 10:00:00", rotated_at: "2026-10-04 09:00:00", auth_method: "passkey", revoked_at: null },
    { id: "s-other-user", user_id: "u2", refresh_token_hash: "x3", previous_token_hash: null, ip_address: "1.1.1.1", user_agent: null, issued_at: "2026-10-02 10:00:00", rotated_at: null, auth_method: null, revoked_at: null },
  ];
  const req = (url = "https://x/api/auth/sessions", method = "GET") =>
    new Request(url, { method, headers: { Cookie: `radar_refresh=${cur}` } });
  return { rows, req };
}

describe("maskIp", () => {
  it("masks the last octet / v6 tail and tolerates junk", () => {
    expect(maskIp("203.0.113.42")).toBe("203.0.113.•••");
    expect(maskIp("2001:db8:1:2::9")).toBe("2001:db8:1:••••");
    expect(maskIp(null)).toBeNull();
    expect(maskIp("nonsense")).toBeNull();
  });

  it("never returns a full address, including short compressed IPv6", () => {
    const cases: Array<[string, string | null]> = [
      ["10.0.0.5", "10.0.0.•••"],
      ["2001:0db8:85a3:0000:0000:8a2e:0370:7334", "2001:db8:85a3:••••"],
      ["2001:db8:85a3::8a2e:370:7334", "2001:db8:85a3:••••"],
      ["2001::1", "2001:0:0:••••"],
      ["::1", "0:0:0:••••"],
      ["::", "0:0:0:••••"],
      ["FE80::1%eth0", "fe80:0:0:••••"],
      ["::ffff:1.2.3.4", "::ffff:1.2.3.•••"],
      ["1.2.3.999", null],
      ["1:2:3", null],
      ["1::2::3", null],
      ["2001:db8::zz", null],
    ];
    for (const [ip, want] of cases) {
      expect(maskIp(ip), ip).toBe(want);
      // The masked form never contains the original address.
      if (want) expect(want.includes(ip)).toBe(false);
      // The shared UI mirror must agree with the worker.
      expect(sharedMaskIp(ip), `shared ${ip}`).toBe(want);
    }
  });
});

describe("own-session handlers", () => {
  it("lists only the caller's sessions, flags the current one, never returns the raw IP", async () => {
    const { rows, req } = await seed();
    const { env } = makeEnv(rows);
    const body = await (await handleListOwnSessions(req(), env, "u1")).json() as {
      data: { total: number; current_known: boolean; sessions: Array<Record<string, unknown>> };
    };
    expect(body.data.total).toBe(2);
    expect(body.data.current_known).toBe(true);
    expect(body.data.sessions.map((s) => s.id).sort()).toEqual(["s-cur", "s-old"]);
    expect(body.data.sessions.find((s) => s.id === "s-cur")?.is_current).toBe(true);
    expect(body.data.sessions.find((s) => s.id === "s-old")?.is_current).toBe(false);
    expect(JSON.stringify(body)).not.toContain("203.0.113.42");
    expect(body.data.sessions.every((s) => !("ip_address" in s))).toBe(true);
  });

  it("revokes another own session, refuses the current one and other users' sessions", async () => {
    const { rows, req } = await seed();
    const { env } = makeEnv(rows);
    expect((await handleRevokeOwnSession(req(), env, U1, "s-cur")).status).toBe(400);
    expect((await handleRevokeOwnSession(req(), env, U1, "s-other-user")).status).toBe(404);
    expect(rows.find((r) => r.id === "s-other-user")?.revoked_at).toBeNull();
    expect((await handleRevokeOwnSession(req(), env, U1, "s-old")).status).toBe(200);
    expect(rows.find((r) => r.id === "s-old")?.revoked_at).not.toBeNull();
  });

  it("revoke-others keeps this device and other users untouched", async () => {
    const { rows, req } = await seed();
    const { env } = makeEnv(rows);
    const res = await handleRevokeOtherSessions(req(), env, U1);
    expect(res.status).toBe(200);
    expect(rows.find((r) => r.id === "s-cur")?.revoked_at).toBeNull();
    expect(rows.find((r) => r.id === "s-old")?.revoked_at).not.toBeNull();
    expect(rows.find((r) => r.id === "s-other-user")?.revoked_at).toBeNull();
  });

  it("revoke-others refuses (409) when the current session cannot be identified", async () => {
    const { rows } = await seed();
    const { env } = makeEnv(rows);
    const res = await handleRevokeOtherSessions(new Request("https://x/api/auth/sessions/revoke-others", { method: "POST" }), env, U1);
    expect(res.status).toBe(409);
    expect(rows.filter((r) => r.user_id === "u1").every((r) => r.revoked_at === null)).toBe(true);
  });

  it("logout-all revokes everything for the caller, stamps forced_logout, clears the cookie", async () => {
    const { rows, req } = await seed();
    const { env, kv } = makeEnv(rows);
    const res = await handleLogoutEverywhere(req("https://x/api/auth/logout-all", "POST"), env, U1);
    expect(res.status).toBe(200);
    expect(rows.filter((r) => r.user_id === "u1").every((r) => r.revoked_at !== null)).toBe(true);
    expect(rows.find((r) => r.id === "s-other-user")?.revoked_at).toBeNull();
    expect(kv.has("forced_logout:u1")).toBe(true);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
