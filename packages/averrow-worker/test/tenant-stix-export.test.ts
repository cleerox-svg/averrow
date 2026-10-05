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
import { handleTenantStixExport, TENANT_STIX_RATE_LIMIT, safeFilename, parseBeforeCursor, encodeBeforeCursor } from "../src/handlers/tenantStixExport";
import { buildPattern, stixIdFor, toStixTimestamp, uuidV5, escapeStixPatternValue } from "../src/lib/stix";
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

describe("STIX serializer hardening (lib/stix.ts)", () => {
  it("escapes backslash before quote so a crafted URL cannot break out of the pattern literal", () => {
    const evil = "https://x.example/\\'] OR [domain-name:value = 'anything";
    const pattern = buildPattern({ id: "t", threat_type: "phishing", status: "active", created_at: "2026-01-01 00:00:00", malicious_url: evil });
    // Every quote inside the literal is preceded by an odd number of backslashes.
    const inner = pattern.slice("[url:value = '".length, -"']".length);
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] !== "'") continue;
      let bs = 0;
      for (let j = i - 1; j >= 0 && inner[j] === "\\"; j--) bs++;
      expect(bs % 2).toBe(1);
    }
    expect(escapeStixPatternValue("a\\b'c")).toBe("a\\\\b\\'c");
    expect(buildPattern({ id: "t", threat_type: "phishing", status: "active", created_at: "", malicious_domain: "x'.example" }))
      .toBe("[domain-name:value = 'x\\'.example']");
  });

  it("derives deterministic UUIDv5 ids for non-UUID source ids and keeps real UUIDs", async () => {
    expect(await stixIdFor("indicator", "threat_abc")).toBe(await stixIdFor("indicator", "threat_abc"));
    expect(await stixIdFor("indicator", "threat_abc")).not.toBe(await stixIdFor("identity", "threat_abc"));
    expect(await stixIdFor("indicator", "6BA7B810-9DAD-11D1-80B4-00C04FD430C8")).toBe("indicator--6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    // RFC 4122 test vector: uuidv5(DNS namespace, "python.org").
    expect(await uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("normalises timestamps to RFC 3339 UTC", () => {
    const fb = "2000-01-01T00:00:00.000Z";
    expect(toStixTimestamp("2026-10-05 12:34:56", fb)).toBe("2026-10-05T12:34:56.000Z");
    expect(toStixTimestamp("2026-10-05", fb)).toBe("2026-10-05T00:00:00.000Z");
    expect(toStixTimestamp("2026-10-05T12:34:56+02:00", fb)).toBe("2026-10-05T10:34:56.000Z");
    expect(toStixTimestamp("garbage", fb)).toBe(fb);
    expect(toStixTimestamp(null, fb)).toBe(fb);
  });

  it("sanitises filenames and parses cursors strictly", () => {
    expect(safeFilename('a"b\r\nc/../d')).toMatch(/^[A-Za-z0-9_-]+$/);
    // Every created_at format a writer produces round-trips.
    for (const ts of ["2026-10-05 01:02:03", "2026-10-05T01:02:03Z", "2026-10-05T01:02:03.123Z", "2026-10-05T01:02:03+00:00"]) {
      expect(parseBeforeCursor(encodeBeforeCursor(ts, "t|1"))).toEqual({ createdAt: ts, id: "t|1" });
    }
    expect(parseBeforeCursor("nonsense!")).toBeNull();
    expect(parseBeforeCursor(encodeBeforeCursor("", "t1"))).toBeNull();
    expect(parseBeforeCursor(btoa('{"a":1}').replace(/=+$/, ""))).toBeNull();
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
    expect(indicators.map((i) => i.id).sort()).toEqual(
      [await stixIdFor("indicator", "ta1"), await stixIdFor("indicator", "ta2")].sort(),
    );
    const identities = bundle.objects.filter((o) => o.type === "identity").map((o) => o.id);
    expect(identities).toEqual([await stixIdFor("identity", "bA")]);
    for (const o of bundle.objects) {
      expect(o.id).toMatch(/^[a-z-]+--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(o.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }

    expect(text).not.toContain("tb1");
    expect(text).not.toContain("BetaB");
    expect(text).not.toContain("secret_vendor_feed");
    expect(text).not.toContain("source_feed");
    expect(text).not.toContain("vt_malicious");
    expect(text).not.toContain("staff_");
    // confidence_score (37) is internal — STIX confidence = severity band.
    const byId = new Map(indicators.map((i) => [i.id, i]));
    expect(byId.get(await stixIdFor("indicator", "ta1"))!.confidence).toBe(80);
    expect(byId.get(await stixIdFor("indicator", "ta2"))!.confidence).toBe(95);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="[A-Za-z0-9_-]+\.json"$/);
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("X-Averrow-Truncated");
  });

  it("applies filters, validates input, and clamps limit", async () => {
    const active = JSON.parse(await (await handleTenantStixExport(req("1", "?status=active"), env, "1", ctxFor("1"))).text()) as STIXBundle;
    expect(active.objects.filter((o) => o.type === "indicator").map((o) => o.id)).toEqual([await stixIdFor("indicator", "ta1")]);

    const bad = await handleTenantStixExport(req("1", "?severity=nope"), env, "1", ctxFor("1"));
    expect(bad.status).toBe(400);
    const badSince = await handleTenantStixExport(req("1", "?since=yesterday"), env, "1", ctxFor("1"));
    expect(badSince.status).toBe(400);

    const one = await handleTenantStixExport(req("1", "?limit=1"), env, "1", ctxFor("1"));
    expect(one.headers.get("X-Averrow-Truncated")).toBe("true");
    const cursor = one.headers.get("X-Averrow-Next-Before");
    expect(cursor).toBeTruthy();
    const oneBundle = JSON.parse(await one.text()) as STIXBundle;
    const page1 = oneBundle.objects.filter((o) => o.type === "indicator").map((o) => o.id);
    expect(page1).toHaveLength(1);

    // Next page via the cursor: the other indicator, and nothing more.
    const two = await handleTenantStixExport(req("1", `?limit=1&before=${encodeURIComponent(cursor!)}`), env, "1", ctxFor("1"));
    expect(two.headers.get("X-Averrow-Truncated")).toBe("false");
    const page2 = (JSON.parse(await two.text()) as STIXBundle).objects.filter((o) => o.type === "indicator").map((o) => o.id);
    expect(page2).toHaveLength(1);
    expect(page2[0]).not.toBe(page1[0]);

    // Exactly `limit` rows available → not truncated (limit+1 read).
    const exact = await handleTenantStixExport(req("1", "?limit=2"), env, "1", ctxFor("1"));
    expect(exact.headers.get("X-Averrow-Truncated")).toBe("false");

    const badCursor = await handleTenantStixExport(req("1", "?before=nonsense"), env, "1", ctxFor("1"));
    expect(badCursor.status).toBe(400);
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
