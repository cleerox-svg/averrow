/**
 * G3 / L3 — customer STIX 2.1 export, GET /api/orgs/:orgId/export/stix.
 *
 * Real handler against node:sqlite (migration-derived schema). Pins:
 *   - another org's caller → 403 (handler-level verifyOrgAccess);
 *   - another org's brand_id → 404, never its threats;
 *   - the bundle carries only the calling org's brands' indicators;
 *   - no T3: no source_feed, no internal confidence_score (STIX confidence
 *     comes from the severity band only), no enrichment/vendor fields;
 *   - limit is clamped to the documented max; the route is guarded by
 *     requireOrgMember (static pin).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { handleTenantStixExport, TENANT_STIX_RATE_LIMIT } from "../src/handlers/tenantStixExport";
import type { AuthContext } from "../src/middleware/auth";
import type { STIXBundle, STIXIndicator } from "../src/lib/stix";
import type { Env } from "../src/types";

const ctxFor = (orgId: string, userId = `u${orgId}`): AuthContext => ({
  userId, email: `${userId}@x.example`, role: "client",
  orgId, orgRole: "viewer", embeddedScope: undefined,
});

const req = (orgId: string, qs = "") =>
  new Request(`https://averrow.com/api/orgs/${orgId}/export/stix${qs}`);

describe("tenant STIX route registration", () => {
  it("is registered behind requireOrgMember", () => {
    const routes = readFileSync(fileURLToPath(new URL("../src/routes/tenant.ts", import.meta.url)), "utf8");
    const i = routes.indexOf('router.get("/api/orgs/:orgId/export/stix"');
    expect(i).toBeGreaterThan(-1);
    expect(routes.slice(i, i + 300)).toContain("requireOrgMember(request, env)");
  });
});

describe.skipIf(!hasSqlite())("GET /api/orgs/:orgId/export/stix (real SQLite)", () => {
  let raw: SqliteDb;
  let env: Env;

  const threat = (id: string, brandId: string, severity: string, extra: { confidence?: number; status?: string } = {}) =>
    raw.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, malicious_url, malicious_domain, target_brand_id,
                            severity, status, confidence_score, vt_malicious)
       VALUES (?, 'secret_vendor_feed', 'phishing', ?, ?, ?, ?, ?, ?, 7)`,
    ).run(id, `https://${id}.bad.example/login`, `${id}.bad.example`, brandId, severity,
      extra.status ?? "active", extra.confidence ?? 37);

  beforeEach(() => {
    raw = openDerivedDb(["brands", "org_brands", "threats"]);
    env = { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;
    raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('bA', 'AcmeA', 'a.example', 'customer')").run();
    raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('bB', 'BetaB', 'b.example', 'customer')").run();
    raw.prepare("INSERT INTO org_brands (org_id, brand_id) VALUES (1, 'bA')").run();
    raw.prepare("INSERT INTO org_brands (org_id, brand_id) VALUES (2, 'bB')").run();
    threat("ta1", "bA", "high");
    threat("ta2", "bA", "critical", { status: "down" });
    threat("tb1", "bB", "high");
  });

  it("rejects a caller from another org (403)", async () => {
    const res = await handleTenantStixExport(req("1"), env, "1", ctxFor("2"));
    expect(res.status).toBe(403);
  });

  it("404s another org's brand_id instead of exporting it", async () => {
    const res = await handleTenantStixExport(req("1", "?brand_id=bB"), env, "1", ctxFor("1"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("tb1");
  });

  it("returns only the calling org's objects, with no internal scores or feed names", async () => {
    const res = await handleTenantStixExport(req("1"), env, "1", ctxFor("1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/stix+json");
    const text = await res.text();
    const bundle = JSON.parse(text) as STIXBundle;
    expect(bundle.type).toBe("bundle");

    const indicators = bundle.objects.filter((o): o is STIXIndicator => o.type === "indicator");
    expect(indicators.map((i) => i.id).sort()).toEqual(["indicator--ta1", "indicator--ta2"]);
    const identities = bundle.objects.filter((o) => o.type === "identity").map((o) => o.id);
    expect(identities).toEqual(["identity--bA"]);

    expect(text).not.toContain("tb1");
    expect(text).not.toContain("BetaB");
    expect(text).not.toContain("secret_vendor_feed");
    expect(text).not.toContain("source_feed");
    expect(text).not.toContain("vt_malicious");
    expect(text).not.toContain("staff_");
    // confidence_score (37) is internal — STIX confidence = severity band.
    const byId = new Map(indicators.map((i) => [i.id, i]));
    expect(byId.get("indicator--ta1")!.confidence).toBe(80);
    expect(byId.get("indicator--ta2")!.confidence).toBe(95);
  });

  it("applies filters, validates input, and clamps limit", async () => {
    const active = JSON.parse(await (await handleTenantStixExport(req("1", "?status=active"), env, "1", ctxFor("1"))).text()) as STIXBundle;
    expect(active.objects.filter((o) => o.type === "indicator").map((o) => o.id)).toEqual(["indicator--ta1"]);

    const bad = await handleTenantStixExport(req("1", "?severity=nope"), env, "1", ctxFor("1"));
    expect(bad.status).toBe(400);
    const badSince = await handleTenantStixExport(req("1", "?since=yesterday"), env, "1", ctxFor("1"));
    expect(badSince.status).toBe(400);

    const one = await handleTenantStixExport(req("1", "?limit=1"), env, "1", ctxFor("1"));
    expect(one.headers.get("X-Averrow-Truncated")).toBe("true");
    const oneBundle = JSON.parse(await one.text()) as STIXBundle;
    expect(oneBundle.objects.filter((o) => o.type === "indicator")).toHaveLength(1);
  });

  it("is rate-limited per org+user", async () => {
    let last = 200;
    for (let i = 0; i <= TENANT_STIX_RATE_LIMIT.maxRequests; i++) {
      last = (await handleTenantStixExport(req("1"), env, "1", ctxFor("1", "u-rl"))).status;
    }
    expect(last).toBe(429);
    // A different user in the same org has their own bucket.
    expect((await handleTenantStixExport(req("1"), env, "1", ctxFor("1", "u-other"))).status).toBe(200);
  });
});
