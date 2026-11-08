// Sign-in failures land on the login page with a stable code (bug: they
// used to 302 to /auth/error?message=<free text>, a page that never
// existed), and the magic link survives mail-scanner prefetch (bug: the
// single-use token was consumed on GET).
//
// Real handlers against migration-derived SQLite (test/sqlite-d1-harness.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { AUTH_ERROR_CODES, AUTH_ERROR_COPY, isAuthErrorCode } from "@averrow/shared";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import {
  handleOAuthCallback, handleOAuthLogin, handleInviteAcceptance,
  handleMagicLinkLanding, handleMagicLinkVerify,
  redirectToLoginWithError, validateReturnTo, resolveReturnTo, isSameOriginPost,
} from "../src/handlers/auth";
import { maskEmail } from "../src/templates/magic-link-confirm";
import { hashToken } from "../src/lib/hash";
import { hashMagicLinkToken } from "../src/lib/magic-link";
import type { Env } from "../src/types";

const SAFE_ERROR_CODE = /^[a-z0-9_]{1,40}$/;
const ORIGIN = "https://averrow.com";
const LOGIN = `${ORIGIN}/v2/login?error=`;

const loc = (res: Response): string => res.headers.get("Location") ?? "";

/** The error code of a login redirect, asserting the URL carries nothing else. */
function errorCodeOf(res: Response): string {
  expect(res.status).toBe(302);
  const u = new URL(loc(res));
  expect(u.pathname).toBe("/v2/login");
  expect([...u.searchParams.keys()]).toEqual(["error"]);
  const code = u.searchParams.get("error") ?? "";
  expect(code).toMatch(SAFE_ERROR_CODE);
  expect(isAuthErrorCode(code)).toBe(true);
  return code;
}

// ─── Static: every producer uses a known code, no free text ────────────

describe("redirectToLoginWithError call sites", () => {
  const src = readFileSync(resolve(__dirname, "../src/handlers/auth.ts"), "utf8");

  it("no /auth/error producer remains anywhere in the worker", () => {
    const walk = (dir: string): string[] => {
      return readdirSync(dir).flatMap((f) => {
        const p = resolve(dir, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    };
    for (const f of walk(resolve(__dirname, "../src"))) {
      expect(readFileSync(f, "utf8"), f).not.toContain("/auth/error");
    }
    expect(src).not.toMatch(/redirectWithError\(/);
  });

  it("every call passes a string-literal code from AUTH_ERROR_CODES", () => {
    const calls = [...src.matchAll(/redirectToLoginWithError\(\s*\w+,\s*([^)]*)\)/g)].map((m) => m[1]!.trim());
    expect(calls.length).toBeGreaterThanOrEqual(25);
    for (const arg of calls) {
      // The one non-literal call routes a typed inspection state.
      if (arg.startsWith("magicLinkErrorCode(")) continue;
      const lit = /^"([a-z0-9_]+)"$/.exec(arg);
      expect(lit, `non-literal code: ${arg}`).not.toBeNull();
      expect(isAuthErrorCode(lit![1])).toBe(true);
    }
  });

  it("every shared code is URL-safe and has customer copy", () => {
    for (const code of AUTH_ERROR_CODES) {
      expect(code).toMatch(SAFE_ERROR_CODE);
      expect(AUTH_ERROR_COPY[code].length).toBeGreaterThan(0);
      // No internal policy wording leaks to the customer.
      expect(AUTH_ERROR_COPY[code]).not.toMatch(/staff|super_admin|role|organization member/i);
    }
  });

  it("helper builds /v2/login?error=<code> with no-store", () => {
    const res = redirectToLoginWithError(ORIGIN, "oauth_failed");
    expect(loc(res)).toBe(`${LOGIN}oauth_failed`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// ─── Rig ───────────────────────────────────────────────────────────────

interface Rig { raw: SqliteDb; env: Env; audits: string[]; kv: ReturnType<typeof fakeKv> }

function makeRig(): Rig {
  const raw = openDerivedDb(["users", "org_members", "org_brands", "organizations", "invitations", "sessions", "magic_link_tokens"]);
  raw.exec(`
    INSERT INTO users (id, email, name, role, status, google_sub) VALUES
      ('u1', 'alice@acme.co', 'Alice', 'client', 'active', 'g-alice'),
      ('u2', 'gone@acme.co',  'Gone',  'client', 'suspended', 'g-gone'),
      ('u3', 'ops@averrow.com', 'Ops', 'analyst', 'active', NULL);
  `);
  const audits: string[] = [];
  const auditDb = {
    prepare() {
      return { bind(...args: unknown[]) { return { async run() { audits.push(String(args[2])); return { success: true }; } }; } };
    },
  };
  const kv = fakeKv();
  const env = {
    DB: d1FromSqlite(raw),
    AUDIT_DB: auditDb,
    CACHE: kv,
    JWT_SECRET: "test-secret-auth-error-redirect",
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "csecret",
  } as unknown as Env;
  return { raw, env, audits, kv };
}

// ─── OAuth callback ────────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("OAuth callback failures → login codes", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const cb = (qs: string, cookie?: string) =>
    handleOAuthCallback(new Request(`${ORIGIN}/api/auth/callback?${qs}`, {
      headers: cookie ? { Cookie: cookie } : {},
    }), rig.env);

  /** Valid state + browser-binding cookie, so the flow reaches Google. */
  async function validState(stored = "/v2/"): Promise<{ qs: string; cookie: string }> {
    const state = "nonce-1";
    await rig.kv.put(`oauth_state:${state}`, stored);
    return { qs: `code=c&state=${state}`, cookie: `radar_oauth_state=${await hashToken(state)}` };
  }

  function stubGoogle(user: { sub: string; email: string; email_verified: boolean; name?: string } | "fail") {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (user === "fail") return new Response("nope", { status: 400 });
      if (String(url).includes("token")) {
        return Response.json({ access_token: "at", expires_in: 3600, token_type: "Bearer", id_token: "x" });
      }
      return Response.json({ name: "N", picture: "", ...user });
    }));
  }

  it("Google ?error= (free text) → oauth_failed, the text is not echoed", async () => {
    const res = await cb(`error=${encodeURIComponent("access_denied <b>call 555</b>")}`);
    expect(errorCodeOf(res)).toBe("oauth_failed");
    expect(loc(res)).not.toMatch(/access_denied|555/);
  });

  it("missing code/state → oauth_failed", async () => {
    expect(errorCodeOf(await cb("code=only"))).toBe("oauth_failed");
  });

  it("missing state cookie → oauth_failed", async () => {
    const { qs } = await validState();
    expect(errorCodeOf(await cb(qs))).toBe("oauth_failed");
  });

  it("unknown state → oauth_failed", async () => {
    const cookie = `radar_oauth_state=${await hashToken("ghost")}`;
    expect(errorCodeOf(await cb("code=c&state=ghost", cookie))).toBe("oauth_failed");
  });

  it("token exchange failure → oauth_failed", async () => {
    const { qs, cookie } = await validState();
    stubGoogle("fail");
    expect(errorCodeOf(await cb(qs, cookie))).toBe("oauth_failed");
  });

  it("unverified Google email → email_unverified", async () => {
    const { qs, cookie } = await validState();
    stubGoogle({ sub: "g-alice", email: "alice@acme.co", email_verified: false });
    expect(errorCodeOf(await cb(qs, cookie))).toBe("email_unverified");
  });

  it("no account → no_account", async () => {
    const { qs, cookie } = await validState();
    stubGoogle({ sub: "g-nobody", email: "nobody@x.co", email_verified: true });
    expect(errorCodeOf(await cb(qs, cookie))).toBe("no_account");
  });

  it("suspended account → account_deactivated", async () => {
    const { qs, cookie } = await validState();
    stubGoogle({ sub: "g-gone", email: "gone@acme.co", email_verified: true });
    expect(errorCodeOf(await cb(qs, cookie))).toBe("account_deactivated");
  });

  it("login with no return_to stores \"\" and the callback falls back to the role default", async () => {
    const { qs, cookie } = await validState("");
    stubGoogle({ sub: "g-alice", email: "alice@acme.co", email_verified: true });
    const res = await cb(qs, cookie);
    expect(loc(res)).toMatch(/\/tenant\/#token=/);
    expect(loc(res)).not.toContain("error=");
  });

  it("success still issues a session (no error)", async () => {
    const { qs, cookie } = await validState();
    stubGoogle({ sub: "g-alice", email: "alice@acme.co", email_verified: true });
    const res = await cb(qs, cookie);
    expect(loc(res)).toContain("#token=");
    expect(loc(res)).not.toContain("error=");
  });
});

// ─── Invite acceptance ─────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("invite acceptance failures → login codes", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  async function seed(id: string, email: string, expiresInMs: number, role = "client"): Promise<string> {
    const token = `tok-${id}`;
    rig.raw.prepare(
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, 'u3', ?)`,
    ).run(id, email, role, await hashToken(token), new Date(Date.now() + expiresInMs).toISOString());
    return token;
  }
  const accept = (token: string, email: string, sub: string) =>
    handleInviteAcceptance(new Request(`${ORIGIN}/api/auth/callback`), rig.env, { sub, email, name: "I" }, token, ORIGIN);

  it("unknown invite → invite_invalid", async () => {
    expect(errorCodeOf(await accept("nope", "a@b.co", "g-a"))).toBe("invite_invalid");
  });

  it("expired invite → invite_expired", async () => {
    const t = await seed("i1", "new@acme.co", -1000);
    expect(errorCodeOf(await accept(t, "new@acme.co", "g-new"))).toBe("invite_expired");
  });

  it("email mismatch → invite_email_mismatch", async () => {
    const t = await seed("i2", "new@acme.co", 3_600_000);
    expect(errorCodeOf(await accept(t, "other@acme.co", "g-other"))).toBe("invite_email_mismatch");
  });

  // Invite acceptance passes no return_to: the role default decides, and it
  // must be an app path (the old '/observatory' default went to the legacy
  // /auth/callback page, a 404).
  it("staff invite success → /v2/#token=", async () => {
    const t = await seed("i3", "newstaff@averrow.com", 3_600_000, "analyst");
    const res = await accept(t, "newstaff@averrow.com", "g-newstaff");
    expect(loc(res)).toMatch(/^https:\/\/averrow\.com\/v2\/#token=/);
  });

  it("client invite success → /tenant/#token=", async () => {
    const t = await seed("i4", "newclient@acme.co", 3_600_000, "client");
    const res = await accept(t, "newclient@acme.co", "g-newclient");
    expect(loc(res)).toMatch(/^https:\/\/averrow\.com\/tenant\/#token=/);
  });
});

// ─── Magic link: interstitial GET + consuming POST ─────────────────────

describe.skipIf(!hasSqlite())("magic link survives prefetch", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  async function seedLink(token: string, email: string, opts: { expiresInMs?: number; used?: boolean; returnTo?: string | null } = {}): Promise<void> {
    rig.raw.prepare(
      `INSERT INTO magic_link_tokens (id, email, token_hash, expires_at, used_at, return_to) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`ml-${token}`, email, await hashMagicLinkToken(token),
      new Date(Date.now() + (opts.expiresInMs ?? 600_000)).toISOString(),
      opts.used ? new Date().toISOString() : null, opts.returnTo === undefined ? "/v2/" : opts.returnTo);
  }
  const usedAt = (token: string) =>
    (rig.raw.prepare("SELECT used_at FROM magic_link_tokens WHERE id = ?").all(`ml-${token}`) as Array<{ used_at: string | null }>)[0]!.used_at;

  const get = (token: string) =>
    handleMagicLinkLanding(new Request(`${ORIGIN}/api/auth/magic-link/${token}`), rig.env, token);
  const post = (token: string, headers: Record<string, string> = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }) =>
    handleMagicLinkVerify(new Request(`${ORIGIN}/api/auth/magic-link/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ token }).toString(),
    }), rig.env);

  it("GET renders the interstitial and does NOT consume the token", async () => {
    await seedLink("good", "alice@acme.co");
    const res = await get("good");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const html = await res.text();
    expect(html).toContain('method="post" action="/api/auth/magic-link/verify"');
    expect(html).toContain('name="token" value="good"');
    expect(html).toContain("Sign in to Averrow");
    expect(usedAt("good")).toBeNull();
    // A scanner prefetching twice still leaves it usable.
    await get("good");
    expect(usedAt("good")).toBeNull();
    expect(rig.audits).not.toContain("login");
  });

  it("POST consumes once and mints a session; a second POST fails", async () => {
    await seedLink("once", "alice@acme.co");
    await get("once");
    const first = await post("once");
    expect(first.status).toBe(302);
    expect(loc(first)).toContain("#token=");
    expect(first.headers.get("Set-Cookie") ?? "").toContain("radar_refresh=");
    expect(usedAt("once")).not.toBeNull();
    expect(rig.audits).toContain("login");

    const second = await post("once");
    expect(errorCodeOf(second)).toBe("link_used_or_invalid");
    expect(second.headers.get("Set-Cookie")).toBeNull();
    // And the link in the email no longer renders the interstitial.
    expect(errorCodeOf(await get("once"))).toBe("link_used_or_invalid");
  });

  it("client user lands on /tenant/#token= (the legacy /auth/callback page 404s)", async () => {
    await seedLink("cl", "alice@acme.co");
    const res = await post("cl");
    expect(loc(res)).toMatch(/^https:\/\/averrow\.com\/tenant\/#token=/);
  });

  it("staff magic link (no return_to) → /v2/#token=", async () => {
    await seedLink("st", "ops@averrow.com", { returnTo: null });
    expect(loc(await post("st"))).toMatch(/^https:\/\/averrow\.com\/v2\/#token=/);
  });

  it("staff magic link keeps a valid /v2 return_to", async () => {
    await seedLink("st2", "ops@averrow.com", { returnTo: "/v2/brands?tab=threats" });
    expect(loc(await post("st2"))).toMatch(/^https:\/\/averrow\.com\/v2\/brands\?tab=threats#token=/);
  });

  it("a stored return_to carrying its own fragment can't plant a token", async () => {
    await seedLink("inj", "alice@acme.co", { returnTo: "/tenant/%23token=evil%26x=" });
    const l = loc(await post("inj"));
    expect(l).toMatch(/^https:\/\/averrow\.com\/tenant\/#token=/);
    expect(l).not.toContain("evil");
  });

  it("interstitial shows the masked, escaped account email", async () => {
    await seedLink("mask", "jane@acme.com");
    const html = await (await get("mask")).text();
    expect(html).toContain("j***@acme.com");
    expect(html).not.toContain("jane@acme.com");
    expect(html).toContain('<meta name="referrer" content="strict-origin">');
  });

  // Real browser header shapes for the consuming POST.
  it("(a) Origin = site + Sec-Fetch-Site same-origin → signs in", async () => {
    await seedLink("ha", "alice@acme.co");
    expect(loc(await post("ha", { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }))).toContain("#token=");
  });

  it("(b) Origin null + Sec-Fetch-Site same-origin → signs in", async () => {
    await seedLink("hb", "alice@acme.co");
    expect(loc(await post("hb", { Origin: "null", "Sec-Fetch-Site": "same-origin" }))).toContain("#token=");
  });

  it("(c) Origin null without Sec-Fetch-Site → refused, not consumed", async () => {
    await seedLink("hc", "alice@acme.co");
    expect(errorCodeOf(await post("hc", { Origin: "null" }))).toBe("signin_failed");
    expect(usedAt("hc")).toBeNull();
  });

  it("(d) cross-site origin → refused, not consumed", async () => {
    await seedLink("hd", "alice@acme.co");
    expect(errorCodeOf(await post("hd", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }))).toBe("signin_failed");
    expect(errorCodeOf(await post("hd", { Origin: "null", "Sec-Fetch-Site": "cross-site" }))).toBe("signin_failed");
    expect(usedAt("hd")).toBeNull();
  });

  it("invalid token GET → login redirect, nothing written", async () => {
    expect(errorCodeOf(await get("does-not-exist"))).toBe("link_used_or_invalid");
  });

  it("empty token GET → invalid_link", async () => {
    expect(errorCodeOf(await get(""))).toBe("invalid_link");
  });

  it("expired token GET → link_expired", async () => {
    await seedLink("old", "alice@acme.co", { expiresInMs: -1000 });
    expect(errorCodeOf(await get("old"))).toBe("link_expired");
  });

  it("POST without a token → invalid_link", async () => {
    expect(errorCodeOf(await post(""))).toBe("invalid_link");
  });

  it("inactive account → account_deactivated, token burned, audited", async () => {
    await seedLink("sus", "gone@acme.co");
    expect(errorCodeOf(await post("sus"))).toBe("account_deactivated");
    expect(usedAt("sus")).not.toBeNull();
    expect(rig.audits).toContain("magic_link_verify_no_account");
  });

  it("cross-site POST (login CSRF) is refused and does not consume", async () => {
    await seedLink("csrf", "alice@acme.co");
    expect(errorCodeOf(await post("csrf", { Origin: "https://evil.example" }))).toBe("signin_failed");
    expect(errorCodeOf(await post("csrf", { "Sec-Fetch-Site": "cross-site" }))).toBe("signin_failed");
    expect(usedAt("csrf")).toBeNull();
    expect(rig.audits).toContain("magic_link_verify_cross_site");
  });

  it("the interstitial HTML-escapes the token", async () => {
    const weird = `a"><script>x</script>`;
    await seedLink(weird, "alice@acme.co");
    const html = await (await get(weird)).text();
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

// ─── Origin check (unit) ───────────────────────────────────────────────

describe("isSameOriginPost", () => {
  const req = (h: Record<string, string>) =>
    new Request(`${ORIGIN}/api/auth/magic-link/verify`, { method: "POST", headers: h });
  it.each([
    [{ Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }, true],
    [{ Origin: "null", "Sec-Fetch-Site": "same-origin" }, true],
    [{ Origin: "null" }, false],
    [{ Origin: "https://evil.example" }, false],
    [{ "Sec-Fetch-Site": "cross-site" }, false],
    [{ "Sec-Fetch-Site": "same-site" }, false],
    [{ Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" }, false],
    [{}, true],
  ])("%j → %s", (headers, ok) => {
    expect(isSameOriginPost(req(headers))).toBe(ok);
  });
});

// ─── return_to validation ──────────────────────────────────────────────

describe("return_to validation", () => {
  it.each([
    "/v2/", "/v2", "/v2/brands", "/v2/brands?tab=a&b=1", "/tenant/", "/tenant/alerts/123",
  ])("accepts %s", (p) => {
    expect(validateReturnTo(p)).toBe(p);
  });

  it.each([
    "/tenant/#token=evil", "/tenant/%23token=evil%26x=", "/v2/?x=1#token=evil",
    "/v2/../admin", "/tenant/./x", "/v2/..", "/v2\\evil", "/v2/?a=\\b",
    "//evil.example", "https://evil.example/v2/", "javascript:alert(1)",
    "/observatory", "/", "", "/v2x", "/tenantx/", "/v2/" + "a".repeat(200),
  ])("rejects %s", (p) => {
    expect(validateReturnTo(p)).toBeNull();
    expect(resolveReturnTo(p, "analyst")).toBe("/v2/");
    expect(resolveReturnTo(p, "client")).toBe("/tenant/");
  });

  it("role defaults: staff /v2/, client /tenant/ (a client never lands in /v2)", () => {
    expect(resolveReturnTo(undefined, "super_admin")).toBe("/v2/");
    expect(resolveReturnTo(null, "client")).toBe("/tenant/");
    expect(resolveReturnTo("/v2/brands", "client")).toBe("/tenant/");
    expect(resolveReturnTo("/tenant/alerts", "client")).toBe("/tenant/alerts");
  });

  it("OAuth login stores only a validated return_to", async () => {
    const kv = fakeKv();
    const env = { CACHE: kv, GOOGLE_CLIENT_ID: "cid" } as unknown as Env;
    await handleOAuthLogin(new Request(`${ORIGIN}/api/auth/login?return_to=${encodeURIComponent("/tenant/#token=evil")}`), env);
    await handleOAuthLogin(new Request(`${ORIGIN}/api/auth/login?return_to=/v2/brands`), env);
    const stored = [...kv.store.entries()].filter(([k]) => k.startsWith("oauth_state:")).map(([, v]) => v).sort();
    expect(stored).toEqual(["", "/v2/brands"]);
  });

  it("rejects control characters and spaces in the query part", () => {
    expect(validateReturnTo("/v2/?a=\n")).toBeNull();
    expect(validateReturnTo("/v2/?a=\r")).toBeNull();
    expect(validateReturnTo("/v2/?a=b c")).toBeNull();
    expect(validateReturnTo("/v2/brands?tab=threats&x=1")).toBe("/v2/brands?tab=threats&x=1");
  });

  it("maskEmail", () => {
    expect(maskEmail("jane@acme.com")).toBe("j***@acme.com");
    expect(maskEmail("nope")).toBe("***");
  });
});
