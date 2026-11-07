// PATCH / GET /api/profile appearance fields (facelift P3-5, migration 0317)
// over real SQLite (schema derived from migrations/): accent_preference and
// base_preference are user-writable, so validation must be an exact match
// against the allowlists, and every value must travel as a bind parameter.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  handleGetProfile, handleUpdateProfile, ACCENT_PREFERENCES, BASE_PREFERENCES,
} from "../src/handlers/profile";
import { handleMe } from "../src/handlers/auth";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const USER = "usr_appearance";

function patch(body: unknown): Request {
  return new Request("https://averrow.com/api/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type ProfileBody = { success: boolean; error?: string; data?: { profile: Record<string, unknown> } };

describe("appearance allowlists", () => {
  it("match ACCENTS / BASES in the shared appearance defaults", () => {
    const src = readFileSync(
      resolve(__dirname, "../../shared/src/theme/appearanceDefaults.ts"), "utf8",
    );
    const list = (name: string) => {
      const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(src);
      expect(m, name).not.toBeNull();
      return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    expect([...ACCENT_PREFERENCES]).toEqual(list("ACCENTS"));
    expect([...BASE_PREFERENCES]).toEqual(list("BASES"));
  });
});

describe.skipIf(!hasSqlite())("profile appearance preferences", () => {
  let raw: SqliteDb;
  let env: Env;

  const row = () =>
    (raw.prepare("SELECT accent_preference, base_preference, theme_preference FROM users WHERE id = ?")
      .all(USER) as Array<Record<string, unknown>>)[0]!;

  beforeEach(() => {
    raw = openDerivedDb(["users", "passkeys", "org_members", "organizations"]);
    raw.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, ?, ?)")
      .run(USER, "a@example.com", "Ada", "analyst", "active");
    env = { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;
  });

  it("new columns default to NULL", async () => {
    const res = await handleGetProfile(new Request("https://averrow.com/api/profile"), env, USER);
    const body = (await res.json()) as ProfileBody;
    expect(res.status).toBe(200);
    expect(body.data!.profile.accent_preference).toBeNull();
    expect(body.data!.profile.base_preference).toBeNull();
  });

  it.each(ACCENT_PREFERENCES)("accepts accent %s and round-trips it", async (accent) => {
    const res = await handleUpdateProfile(patch({ accent_preference: accent }), env, USER);
    const body = (await res.json()) as ProfileBody;
    expect(res.status).toBe(200);
    expect(body.data!.profile.accent_preference).toBe(accent);
    expect(row().accent_preference).toBe(accent);
  });

  it.each(BASE_PREFERENCES)("accepts base %s and round-trips it", async (base) => {
    const res = await handleUpdateProfile(patch({ base_preference: base }), env, USER);
    expect(res.status).toBe(200);
    expect(row().base_preference).toBe(base);
  });

  it("sets both at once, and null clears each", async () => {
    await handleUpdateProfile(patch({ accent_preference: "violet", base_preference: "navy" }), env, USER);
    expect(row()).toMatchObject({ accent_preference: "violet", base_preference: "navy" });
    const res = await handleUpdateProfile(patch({ accent_preference: null, base_preference: null }), env, USER);
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ accent_preference: null, base_preference: null });
  });

  it("leaves the other appearance fields alone (partial PATCH)", async () => {
    await handleUpdateProfile(patch({ accent_preference: "lime", base_preference: "navy", theme_preference: "light" }), env, USER);
    await handleUpdateProfile(patch({ accent_preference: "mono" }), env, USER);
    expect(row()).toEqual({ accent_preference: "mono", base_preference: "navy", theme_preference: "light" });
  });

  it.each([
    ["accent_preference", "amber"],
    ["accent_preference", "Indigo"],
    ["accent_preference", " indigo"],
    ["accent_preference", "indigo'); DROP TABLE users;--"],
    ["accent_preference", ""],
    ["accent_preference", 1],
    ["accent_preference", true],
    ["accent_preference", ["indigo"]],
    ["accent_preference", { v: "indigo" }],
    ["base_preference", "navy "],
    ["base_preference", "black"],
    ["base_preference", "indigo"],
    ["base_preference", 0],
  ])("rejects %s = %j with 400 and writes nothing", async (field, value) => {
    await handleUpdateProfile(patch({ accent_preference: "violet", base_preference: "graphite" }), env, USER);
    const res = await handleUpdateProfile(patch({ [field]: value, theme_preference: "light" }), env, USER);
    const body = (await res.json()) as ProfileBody;
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain(field);
    // The whole PATCH is refused: neither the bad field nor its siblings change.
    expect(row()).toEqual({ accent_preference: "violet", base_preference: "graphite", theme_preference: null });
  });

  it("rejects a non-object body with 400", async () => {
    for (const b of ["null", "[]", "\"indigo\"", "3"]) {
      const res = await handleUpdateProfile(patch(b), env, USER);
      expect(res.status, b).toBe(400);
    }
  });

  it("/api/auth/me returns the appearance fields", async () => {
    await handleUpdateProfile(patch({ accent_preference: "indigo", base_preference: "navy" }), env, USER);
    const res = await handleMe(new Request("https://averrow.com/api/auth/me"), env, USER);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.data.accent_preference).toBe("indigo");
    expect(body.data.base_preference).toBe("navy");
  });
});
