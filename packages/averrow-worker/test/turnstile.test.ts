// Cloudflare Turnstile on the public scan + lead forms (2026-10-05).
//
//   1. verifyTurnstile: siteverify request shape, success, rejection,
//      hostname allowlist, action check, non-2xx / bad body, timeout,
//      network error, missing secret / token, oversize token.
//   2. resolveTurnstileMode: unset/off/unknown → off; monitor/enforce
//      without TURNSTILE_SECRET_KEY → off with a one-time warning.
//   3. Every protected endpoint under off / monitor / enforce: off never
//      calls siteverify; monitor verifies but never blocks; enforce blocks
//      a missing / rejected / wrong-host token and a siteverify outage, and
//      lets a valid token through. POST /assess redirects instead of 403.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerScanRoutes } from "../src/routes/scan";
import { registerPublicRoutes } from "../src/routes/public";
import {
  verifyTurnstile, resolveTurnstileMode, resetTurnstileWarningsForTest,
  TURNSTILE_SITEVERIFY_URL, TURNSTILE_MAX_TOKEN_LENGTH,
} from "../src/lib/turnstile";
import { logger } from "../src/lib/logger";
import type { Env } from "../src/types";

const SECRET = "0x4AAAAAAA-test-secret";
const GOOD_TOKEN = "tok_good";

type Siteverify =
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "throw" }
  | { kind: "hang" };

let siteverify: Siteverify;
let siteverifyCalls: Array<{ body: URLSearchParams }>;

function siteverifyOk(extra: Record<string, unknown> = {}): Siteverify {
  return { kind: "json", body: { success: true, hostname: "averrow.com", action: "", ...extra } };
}

beforeEach(() => {
  resetTurnstileWarningsForTest();
  siteverify = siteverifyOk();
  siteverifyCalls = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== TURNSTILE_SITEVERIFY_URL) {
      // checkDNS (DoH) and anything else the handlers reach: empty answer.
      return new Response(JSON.stringify({}), { status: 200 });
    }
    siteverifyCalls.push({ body: new URLSearchParams(String(init?.body ?? "")) });
    if (siteverify.kind === "throw") throw new TypeError("network down");
    if (siteverify.kind === "hang") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(JSON.stringify(siteverify.body), { status: siteverify.status ?? 200 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── 1. verifyTurnstile ──────────────────────────────────────────

describe("verifyTurnstile", () => {
  const env = { TURNSTILE_SECRET_KEY: SECRET };

  it("POSTs secret, response and remoteip and accepts a valid token", async () => {
    const r = await verifyTurnstile(env, GOOD_TOKEN, "203.0.113.9");
    expect(r).toEqual({ ok: true, reason: "ok", hostname: "averrow.com" });
    expect(siteverifyCalls).toHaveLength(1);
    const b = siteverifyCalls[0]!.body;
    expect(b.get("secret")).toBe(SECRET);
    expect(b.get("response")).toBe(GOOD_TOKEN);
    expect(b.get("remoteip")).toBe("203.0.113.9");
  });

  it("omits remoteip when no IP is known", async () => {
    await verifyTurnstile(env, GOOD_TOKEN);
    expect(siteverifyCalls[0]!.body.has("remoteip")).toBe(false);
  });

  it.each(["averrow.com", "www.averrow.com", "averrow.ca", "WWW.AVERROW.CA"])("accepts hostname %s", async (h) => {
    siteverify = siteverifyOk({ hostname: h });
    expect((await verifyTurnstile(env, GOOD_TOKEN)).ok).toBe(true);
  });

  it.each(["evil.example", "averrow.com.evil.example", "staging.averrow.com", ""])(
    "rejects hostname %j", async (h) => {
      siteverify = siteverifyOk({ hostname: h });
      const r = await verifyTurnstile(env, GOOD_TOKEN);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("hostname-mismatch");
    },
  );

  it("rejects a token siteverify refuses, surfacing its error codes", async () => {
    siteverify = { kind: "json", body: { success: false, "error-codes": ["timeout-or-duplicate"] } };
    const r = await verifyTurnstile(env, GOOD_TOKEN);
    expect(r).toEqual({ ok: false, reason: "siteverify-rejected", errorCodes: ["timeout-or-duplicate"] });
  });

  it("checks the action only when the widget supplied one", async () => {
    siteverify = siteverifyOk({ action: "lead" });
    expect((await verifyTurnstile(env, GOOD_TOKEN, null, { expectedAction: "scan" })).reason).toBe("action-mismatch");
    siteverify = siteverifyOk({ action: "scan" });
    expect((await verifyTurnstile(env, GOOD_TOKEN, null, { expectedAction: "scan" })).ok).toBe(true);
    siteverify = siteverifyOk({ action: "" });
    expect((await verifyTurnstile(env, GOOD_TOKEN, null, { expectedAction: "scan" })).ok).toBe(true);
  });

  it("fails on a non-2xx or unparsable siteverify response", async () => {
    siteverify = { kind: "json", status: 500, body: { success: true, hostname: "averrow.com" } };
    expect((await verifyTurnstile(env, GOOD_TOKEN)).reason).toBe("bad-response");
    siteverify = { kind: "json", body: "not-an-object" };
    expect((await verifyTurnstile(env, GOOD_TOKEN)).reason).toBe("bad-response");
  });

  it("fails closed on network error and on timeout", async () => {
    siteverify = { kind: "throw" };
    expect(await verifyTurnstile(env, GOOD_TOKEN)).toEqual({ ok: false, reason: "network-error" });
    siteverify = { kind: "hang" };
    expect(await verifyTurnstile(env, GOOD_TOKEN, null, { timeoutMs: 10 })).toEqual({ ok: false, reason: "timeout" });
  });

  it("fails without calling siteverify when the secret or token is missing / oversize", async () => {
    expect((await verifyTurnstile({}, GOOD_TOKEN)).reason).toBe("missing-secret");
    expect((await verifyTurnstile(env, null)).reason).toBe("missing-token");
    expect((await verifyTurnstile(env, "")).reason).toBe("missing-token");
    expect((await verifyTurnstile(env, "x".repeat(TURNSTILE_MAX_TOKEN_LENGTH + 1))).reason).toBe("invalid-token-format");
    expect(siteverifyCalls).toHaveLength(0);
  });
});

// ─── 2. resolveTurnstileMode ─────────────────────────────────────

describe("resolveTurnstileMode", () => {
  it("is off when unset, 'off', or unrecognised", () => {
    expect(resolveTurnstileMode({ TURNSTILE_SECRET_KEY: SECRET })).toBe("off");
    expect(resolveTurnstileMode({ TURNSTILE_MODE: "off", TURNSTILE_SECRET_KEY: SECRET })).toBe("off");
    expect(resolveTurnstileMode({ TURNSTILE_MODE: "block", TURNSTILE_SECRET_KEY: SECRET })).toBe("off");
  });

  it("honours monitor / enforce (case-insensitive) when the secret is set", () => {
    expect(resolveTurnstileMode({ TURNSTILE_MODE: "monitor", TURNSTILE_SECRET_KEY: SECRET })).toBe("monitor");
    expect(resolveTurnstileMode({ TURNSTILE_MODE: " Enforce ", TURNSTILE_SECRET_KEY: SECRET })).toBe("enforce");
  });

  it("falls back to off without the secret and warns exactly once", () => {
    const warn = vi.spyOn(logger, "warn");
    expect(resolveTurnstileMode({ TURNSTILE_MODE: "enforce" })).toBe("off");
    expect(resolveTurnstileMode({ TURNSTILE_MODE: "monitor" })).toBe("off");
    const calls = warn.mock.calls.filter(([e]) => e === "turnstile_secret_missing");
    expect(calls).toHaveLength(1);
  });
});

// ─── 3. Endpoints ────────────────────────────────────────────────

interface Stub { env: Env; sqls: string[] }

function makeEnv(vars: Partial<Env>): Stub {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      const stmt = {
        bind: () => stmt,
        async first<T>() { return null as T; },
        async run() { return { success: true, meta: { changes: 1 } }; },
        async all<T>() { return { results: [] as T[] }; },
      };
      return stmt;
    },
  };
  const cache = { async get() { return null; }, async put() {} };
  return { env: { DB: db, CACHE: cache, ENVIRONMENT: "test", ...vars } as unknown as Env, sqls };
}

function router(): RouterType<IRequest> {
  const r = Router();
  registerScanRoutes(r);
  registerPublicRoutes(r);
  return r;
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface Endpoint {
  name: string;
  /** Build the request; `token` null = no token at all. */
  build: (token: string | null) => Request;
  form?: boolean;
}

function jsonPost(path: string, body: Record<string, unknown>, token: string | null, via: "body" | "header"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" };
  const payload = { ...body };
  if (token !== null) {
    if (via === "header") headers["CF-Turnstile-Response"] = token;
    else payload.turnstileToken = token;
  }
  return new Request(`https://averrow.com${path}`, { method: "POST", headers, body: JSON.stringify(payload) });
}

const lead = { name: "Pat", email: "pat@acme.example", company: "Acme" };

const ENDPOINTS: Endpoint[] = [
  {
    name: "POST /assess (form)",
    form: true,
    build: (token) => {
      const form = new URLSearchParams({ domain: "acme.example" });
      if (token !== null) form.set("cf-turnstile-response", token);
      return new Request("https://averrow.com/assess", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.9" },
        body: form.toString(),
      });
    },
  },
  { name: "POST /api/brand-scan/public (body)", build: (t) => jsonPost("/api/brand-scan/public", { domain: "acme.example" }, t, "body") },
  { name: "POST /api/brand-scan/public (header)", build: (t) => jsonPost("/api/brand-scan/public", { domain: "acme.example" }, t, "header") },
  { name: "POST /api/leads", build: (t) => jsonPost("/api/leads", { ...lead, domain: "acme.example" }, t, "body") },
  { name: "POST /api/v1/public/assess", build: (t) => jsonPost("/api/v1/public/assess", { domain: "acme.example" }, t, "body") },
  { name: "POST /api/v1/public/leads", build: (t) => jsonPost("/api/v1/public/leads", lead, t, "body") },
  { name: "POST /api/v1/public/monitor", build: (t) => jsonPost("/api/v1/public/monitor", { domain: "acme.example" }, t, "header") },
];

async function call(ep: Endpoint, vars: Partial<Env>, token: string | null): Promise<{ res: Response; s: Stub }> {
  const s = makeEnv(vars);
  const res = (await router().fetch(ep.build(token), s.env, ctx)) as Response;
  return { res, s };
}

/** Blocked by Turnstile: JSON 403 with the fixed body, or the /assess
 *  redirect carrying the error param — and the handler never touched D1. */
async function expectBlocked(ep: Endpoint, res: Response, s: Stub): Promise<void> {
  if (ep.form) {
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://averrow.com/?error=verification_failed");
  } else {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: "Verification failed" });
  }
  expect(s.sqls).toEqual([]);
}

/** The request reached its handler (it touched D1) and was not a Turnstile block. */
function expectProceeded(ep: Endpoint, res: Response, s: Stub): void {
  expect(res.status).not.toBe(403);
  if (ep.form) expect(res.headers.get("Location") ?? "").not.toContain("verification_failed");
  expect(s.sqls.length).toBeGreaterThan(0);
}

describe.each(ENDPOINTS)("$name", (ep) => {
  it("off (unset): no siteverify call, request proceeds without a token", async () => {
    const { res, s } = await call(ep, { TURNSTILE_SECRET_KEY: SECRET }, null);
    expectProceeded(ep, res, s);
    expect(siteverifyCalls).toHaveLength(0);
  });

  it("enforce without TURNSTILE_SECRET_KEY behaves as off", async () => {
    const { res, s } = await call(ep, { TURNSTILE_MODE: "enforce" }, null);
    expectProceeded(ep, res, s);
    expect(siteverifyCalls).toHaveLength(0);
  });

  it("monitor: verifies, logs, but never blocks a failed token", async () => {
    siteverify = { kind: "json", body: { success: false, "error-codes": ["invalid-input-response"] } };
    const warn = vi.spyOn(logger, "warn");
    const { res, s } = await call(ep, { TURNSTILE_MODE: "monitor", TURNSTILE_SECRET_KEY: SECRET }, "tok_bad");
    expectProceeded(ep, res, s);
    expect(siteverifyCalls).toHaveLength(1);
    const verdict = warn.mock.calls.find(([e]) => e === "turnstile_verdict");
    expect(verdict?.[1]).toMatchObject({ mode: "monitor", ok: false, reason: "siteverify-rejected", blocked: false });
    expect(JSON.stringify(verdict?.[1])).not.toContain("tok_bad");
  });

  it("monitor: a missing token proceeds", async () => {
    const { res, s } = await call(ep, { TURNSTILE_MODE: "monitor", TURNSTILE_SECRET_KEY: SECRET }, null);
    expectProceeded(ep, res, s);
  });

  const enforce = { TURNSTILE_MODE: "enforce", TURNSTILE_SECRET_KEY: SECRET };

  it("enforce: a valid token proceeds", async () => {
    const { res, s } = await call(ep, enforce, GOOD_TOKEN);
    expectProceeded(ep, res, s);
    expect(siteverifyCalls).toHaveLength(1);
    expect(siteverifyCalls[0]!.body.get("response")).toBe(GOOD_TOKEN);
    expect(siteverifyCalls[0]!.body.get("remoteip")).toBe("203.0.113.9");
  });

  it("enforce: a missing token is blocked without calling siteverify", async () => {
    const { res, s } = await call(ep, enforce, null);
    await expectBlocked(ep, res, s);
    expect(siteverifyCalls).toHaveLength(0);
  });

  it("enforce: a rejected token is blocked", async () => {
    siteverify = { kind: "json", body: { success: false, "error-codes": ["timeout-or-duplicate"] } };
    const { res, s } = await call(ep, enforce, "tok_used");
    await expectBlocked(ep, res, s);
  });

  it("enforce: a token solved on another hostname is blocked", async () => {
    siteverify = siteverifyOk({ hostname: "attacker.example" });
    const { res, s } = await call(ep, enforce, GOOD_TOKEN);
    await expectBlocked(ep, res, s);
  });

  it("enforce: a siteverify outage fails closed", async () => {
    siteverify = { kind: "throw" };
    const { res, s } = await call(ep, enforce, GOOD_TOKEN);
    await expectBlocked(ep, res, s);
  });

  it("enforce: siteverify 5xx fails closed", async () => {
    siteverify = { kind: "json", status: 503, body: {} };
    const { res, s } = await call(ep, enforce, GOOD_TOKEN);
    await expectBlocked(ep, res, s);
  });
});

describe("action check per endpoint family", () => {
  const enforce = { TURNSTILE_MODE: "enforce", TURNSTILE_SECRET_KEY: SECRET };
  it("a 'lead' widget token can't be spent on the scan endpoint, but works on /api/leads", async () => {
    siteverify = siteverifyOk({ action: "lead" });
    const scan = ENDPOINTS.find((e) => e.name.startsWith("POST /api/brand-scan/public (body)"))!;
    const leads = ENDPOINTS.find((e) => e.name === "POST /api/leads")!;
    const blocked = await call(scan, enforce, GOOD_TOKEN);
    await expectBlocked(scan, blocked.res, blocked.s);
    const ok = await call(leads, enforce, GOOD_TOKEN);
    expectProceeded(leads, ok.res, ok.s);
  });
});
