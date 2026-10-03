/**
 * Security regression: `organizations.webhook_secret` (the HMAC key for a
 * customer's outbound webhooks, lib/webhooks.ts signPayload) and the full
 * `webhook_url` (Slack/Teams URLs embed their own credential) must never
 * reach `read_customers` staff (analyst / sales / support / auditor) via
 * GET /api/admin/organizations[/:orgId].
 *
 * Before the fix those handlers ran `SELECT o.*` / `SELECT *` and spread
 * the raw row into JSON. Now they SELECT an explicit column list and pass
 * the row through the toPublicOrg allowlist (lib/org-public.ts).
 *
 * The fake D1 deliberately returns the FULL row (secret included) no matter
 * what the SQL selects — so the response assertions prove the allowlist
 * strips it, and the SQL assertions prove the query no longer asks for it.
 *
 * Also locks: the write-once first-set / regenerate flows still return the
 * new secret exactly once, and the webhook-config audit entry stores a
 * redacted URL, not the full one.
 */

import { describe, it, expect } from "vitest";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerAdminRoutes } from "../src/routes/admin";
import {
  handleUpdateWebhook,
  handleRegenerateSecret,
  handleGetWebhookConfig,
} from "../src/handlers/organizations";
import {
  toPublicOrg,
  redactWebhookUrl,
  orgPublicSelectSql,
} from "../src/lib/org-public";
import type { AuthContext } from "../src/middleware/auth";
import { signJWT } from "../src/lib/jwt";
import type { Env, JWTPayload, UserRole } from "../src/types";

const SECRET = "test-secret-org-webhook-exposure";
const WEBHOOK_SECRET = "deadbeef".repeat(8);
const WEBHOOK_URL =
  "https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXXXXXXXXXX";

const FULL_ORG_ROW: Record<string, unknown> = {
  id: 42,
  name: "Acme",
  slug: "acme",
  plan: "professional",
  plan_id: "professional",
  status: "active",
  billing_status: "active",
  trial_ends_at: null,
  max_brands: 5,
  max_members: 10,
  sso_provider: null,
  sso_config_json: '{"client_secret":"oidc-shh"}',
  invite_code: "INVITE42",
  webhook_url: WEBHOOK_URL,
  webhook_secret: WEBHOOK_SECRET,
  webhook_events: '["threat.created"]',
  stripe_customer_id: "cus_123",
  stripe_subscription_id: "sub_123",
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-02 00:00:00",
};

interface Captured {
  sql: string;
  binds: unknown[];
}

interface FakeOpts {
  existingSecret?: string | null;
}

function makeEnv(sqls: Captured[], audits: Captured[], opts: FakeOpts = {}): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          sqls.push({ sql, binds });
          return {
            async first<T>(): Promise<T | null> {
              if (/SELECT status FROM users/.test(sql)) return { status: "active" } as T;
              if (/SELECT webhook_secret FROM organizations/.test(sql)) {
                return { webhook_secret: opts.existingSecret ?? null } as T;
              }
              if (/FROM organizations/.test(sql)) return { ...FULL_ORG_ROW } as T;
              return null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              if (/FROM organizations o/.test(sql)) {
                return {
                  results: [{ ...FULL_ORG_ROW, member_count: 3, brand_count: 2 } as T],
                };
              }
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const auditDb = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async run() {
              audits.push({ sql, binds });
              return { success: true };
            },
          };
        },
      };
    },
  };
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  return { JWT_SECRET: SECRET, DB: db, AUDIT_DB: auditDb, CACHE: cache } as unknown as Env;
}

function makeRouter(): RouterType<IRequest> {
  const router = Router();
  registerAdminRoutes(router);
  return router;
}

async function staffRequest(role: UserRole, path: string): Promise<Request> {
  const payload: Omit<JWTPayload, "iat" | "exp"> = {
    sub: `u-${role}`,
    email: `${role}@averrow.com`,
    role,
  };
  const token = await signJWT(payload, SECRET, 300);
  return new Request(`https://averrow.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function assertNoSecrets(obj: Record<string, unknown>): void {
  const serialized = JSON.stringify(obj);
  expect(serialized).not.toContain(WEBHOOK_SECRET);
  expect(serialized).not.toContain("XXXXXXXXXXXXXXXXXXXXXXXX");
  expect(serialized).not.toContain("oidc-shh");
  expect(obj).not.toHaveProperty("webhook_secret");
  expect(obj).not.toHaveProperty("webhook_url");
  expect(obj).not.toHaveProperty("sso_config_json");
  expect(obj).not.toHaveProperty("invite_code");
  expect(obj).not.toHaveProperty("stripe_customer_id");
  expect(obj).not.toHaveProperty("stripe_subscription_id");
}

const READ_CUSTOMERS_ROLES: UserRole[] = ["analyst", "sales", "support", "auditor"];

describe("GET /api/admin/organizations — no webhook secret for read_customers roles", () => {
  for (const role of READ_CUSTOMERS_ROLES) {
    it(`${role}: list rows carry no webhook_secret / full webhook_url`, async () => {
      const sqls: Captured[] = [];
      const env = makeEnv(sqls, []);
      const res = await makeRouter().fetch(
        await staffRequest(role, "/api/admin/organizations"),
        env,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      expect(body.data).toHaveLength(1);
      const row = body.data[0]!;
      assertNoSecrets(row);
      expect(row).toMatchObject({
        id: 42,
        name: "Acme",
        slug: "acme",
        plan: "professional",
        status: "active",
        member_count: 3,
        brand_count: 2,
        has_webhook: true,
        webhook_url_redacted: "https://…slack.com/…",
      });

      const listSql = sqls.find((c) => /FROM organizations o/.test(c.sql))?.sql ?? "";
      expect(listSql).not.toMatch(/o\.\*/);
      expect(listSql).not.toMatch(/webhook_secret/);
    });
  }
});

describe("GET /api/admin/organizations/:orgId — no webhook secret for read_customers roles", () => {
  for (const role of READ_CUSTOMERS_ROLES) {
    it(`${role}: detail carries no webhook_secret / full webhook_url`, async () => {
      const sqls: Captured[] = [];
      const env = makeEnv(sqls, []);
      const res = await makeRouter().fetch(
        await staffRequest(role, "/api/admin/organizations/42"),
        env,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      assertNoSecrets(body.data);
      expect(body.data).toMatchObject({
        id: 42,
        name: "Acme",
        has_webhook: true,
        webhook_url_redacted: "https://…slack.com/…",
        members: [],
        brands: [],
      });

      const orgSql =
        sqls.find((c) => /FROM organizations WHERE id = \?/.test(c.sql))?.sql ?? "";
      expect(orgSql).not.toMatch(/SELECT \*/);
      expect(orgSql).not.toMatch(/webhook_secret/);
    });
  }

  it("billing (no read_customers) is still refused", async () => {
    const env = makeEnv([], []);
    const res = await makeRouter().fetch(
      await staffRequest("billing", "/api/admin/organizations/42"),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });
});

describe("super_admin org write responses are sanitized too", () => {
  it("PATCH /api/admin/organizations/:orgId returns no webhook_secret", async () => {
    const env = makeEnv([], []);
    const token = await signJWT(
      { sub: "root", email: "root@averrow.com", role: "super_admin" },
      SECRET,
      300,
    );
    const req = new Request("https://averrow.com/api/admin/organizations/42", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme 2" }),
    });
    const res = await makeRouter().fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    assertNoSecrets(body.data);
    expect(body.data).toMatchObject({ id: 42, has_webhook: true });
  });
});

// ─── Org-admin webhook flows (handler level) ─────────────────────

const ORG_ADMIN: AuthContext = {
  userId: "u-admin",
  email: "admin@acme.com",
  role: "client",
  orgId: "42",
  orgRole: "admin",
} as AuthContext;

const ORG_OWNER: AuthContext = { ...ORG_ADMIN, userId: "u-owner", orgRole: "owner" } as AuthContext;

function jsonRequest(method: string, body?: unknown): Request {
  return new Request("https://averrow.com/api/orgs/42/webhook", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function auditDetails(audits: Captured[]): Record<string, unknown> {
  // audit_log INSERT bind order: id, user_id, action, resource_type,
  // resource_id, details, ip, ua, outcome
  const raw = audits[0]?.binds[5];
  expect(typeof raw).toBe("string");
  return JSON.parse(raw as string) as Record<string, unknown>;
}

describe("PATCH /api/orgs/:orgId/webhook — first-set returns secret once, audit redacted", () => {
  it("returns the newly minted secret on first set and logs only a redacted URL", async () => {
    const sqls: Captured[] = [];
    const audits: Captured[] = [];
    const env = makeEnv(sqls, audits, { existingSecret: null });
    const res = await handleUpdateWebhook(
      jsonRequest("PATCH", { webhook_url: WEBHOOK_URL, webhook_events: ["threat.created"] }),
      env,
      "42",
      ORG_ADMIN,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(typeof body.data.webhook_secret).toBe("string");
    expect(body.data.webhook_secret).toMatch(/^[0-9a-f]{64}$/);

    const details = auditDetails(audits);
    expect(details.webhook_url).toBe("https://…slack.com/…");
    expect(details.webhook_events).toEqual(["threat.created"]);
    const rawDetails = audits[0]!.binds[5] as string;
    expect(rawDetails).not.toContain("XXXXXXXXXXXXXXXXXXXXXXXX");
    expect(rawDetails).not.toContain("/services/");
    expect(rawDetails).not.toContain(body.data.webhook_secret as string);
  });

  it("does not return a secret when one already exists", async () => {
    const audits: Captured[] = [];
    const env = makeEnv([], audits, { existingSecret: WEBHOOK_SECRET });
    const res = await handleUpdateWebhook(
      jsonRequest("PATCH", { webhook_url: WEBHOOK_URL }),
      env,
      "42",
      ORG_ADMIN,
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty("webhook_secret");
    expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET);
  });

  it("clearing the webhook logs webhook_url: null", async () => {
    const audits: Captured[] = [];
    const env = makeEnv([], audits);
    await handleUpdateWebhook(jsonRequest("PATCH", { webhook_url: "" }), env, "42", ORG_ADMIN);
    expect(auditDetails(audits).webhook_url).toBeNull();
  });
});

describe("POST /api/orgs/:orgId/webhook/regenerate-secret — still returns the new secret once", () => {
  it("owner receives the regenerated secret; audit details carry no secret", async () => {
    const audits: Captured[] = [];
    const env = makeEnv([], audits);
    const res = await handleRegenerateSecret(jsonRequest("POST"), env, "42", ORG_OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { webhook_secret: string } };
    expect(body.data.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(audits[0]!.binds[5]).not.toContain(body.data.webhook_secret);
  });
});

describe("GET /api/orgs/:orgId/webhook — org admin sees full URL, never the secret", () => {
  it("returns webhook_url + has_secret, not webhook_secret", async () => {
    const env = makeEnv([], []);
    const res = await handleGetWebhookConfig(jsonRequest("GET"), env, "42", ORG_ADMIN);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.webhook_url).toBe(WEBHOOK_URL);
    expect(body.data.has_secret).toBe(true);
    expect(body.data).not.toHaveProperty("webhook_secret");
    expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET);
  });
});

// ─── Helper unit tests ───────────────────────────────────────────

describe("lib/org-public", () => {
  it("redactWebhookUrl keeps scheme + registrable domain only", () => {
    expect(redactWebhookUrl(WEBHOOK_URL)).toBe("https://…slack.com/…");
    expect(redactWebhookUrl("https://user:pw@example.com:8443/hook?token=abc")).toBe(
      "https://example.com/…",
    );
    // Per-tenant tokens in the subdomain are dropped.
    expect(redactWebhookUrl("https://abc123secret.m.pipedream.net/x")).toBe("https://…pipedream.net/…");
    expect(redactWebhookUrl("https://acme.webhook.office.com/webhookb2/tok")).toBe("https://…office.com/…");
    // Short-second-level ccTLDs keep three labels so the service is named.
    expect(redactWebhookUrl("https://hooks.example.co.uk/t")).toBe("https://…example.co.uk/…");
    expect(redactWebhookUrl("https://example.co.uk/t")).toBe("https://example.co.uk/…");
    // IP literals have no subdomain to hide.
    expect(redactWebhookUrl("http://[::1]:8080/a?b")).toBe("http://[::1]/…");
    expect(redactWebhookUrl("http://10.0.0.5/hook")).toBe("http://10.0.0.5/…");
    expect(redactWebhookUrl("not a url")).toBe("[redacted]");
    expect(redactWebhookUrl("")).toBeNull();
    expect(redactWebhookUrl(null)).toBeNull();
    expect(redactWebhookUrl(undefined)).toBeNull();
  });

  it("toPublicOrg drops unknown + secret columns even when requested as extras", () => {
    const out = toPublicOrg(
      { ...FULL_ORG_ROW, future_api_token: "tok", member_count: 1 },
      ["member_count", "webhook_secret", "webhook_url"],
    );
    assertNoSecrets(out);
    expect(out).not.toHaveProperty("future_api_token");
    expect(out).not.toHaveProperty("webhook_events");
    expect(out.member_count).toBe(1);
  });

  it("toPublicOrg reports has_webhook=false when no URL is set", () => {
    const out = toPublicOrg({ ...FULL_ORG_ROW, webhook_url: null });
    expect(out.has_webhook).toBe(false);
    expect(out.webhook_url_redacted).toBeNull();
  });

  it("orgPublicSelectSql never selects secret columns", () => {
    for (const sql of [orgPublicSelectSql(), orgPublicSelectSql("o")]) {
      expect(sql).not.toMatch(/\*/);
      expect(sql).not.toMatch(/webhook_secret|sso_config_json|invite_code|stripe_/);
    }
  });
});
