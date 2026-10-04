// PR-F: staff-surface monitor READ paths give every staff role the same
// full-platform answer; their MUTATION gates are unchanged.
//
// Runs the real handlers against an in-memory SQLite whose schema is derived
// from migrations/ (test/sqlite-d1-harness.ts), so a phantom column fails the
// test instead of being stubbed around.
//
// Fixture:
//   bm1 — monitored_brands row, assigned to org 1 (org_brands)
//   bm2 — monitored_brands row, no org
//   bu  — NOT in monitored_brands, no org
// Every per-brand read is aimed at `bu`, the brand that only a global
// predicate can reach. Before PR-F an org-less admin/analyst got 403/404 on
// it (CT + lookalike: everyone but super_admin / super_admin+auditor; dark
// web / app store / social: everyone but admin+super_admin), and the
// overviews returned EMPTY for org-less non-admins.
//
// Takedown authorizations have no ops read path — the only read is the tenant
// route GET /api/orgs/:orgId/takedown-authorization, and that stays on the
// tenant backstop. Its coverage lives in tenant-org-member-guard.test.ts
// ("PR-F: staff stay blocked on another org's tenant routes").

import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { handleListCertificates, handleCertStats, handleTriggerCTScan } from "../src/handlers/ctMonitor";
import { handleListLookalikes, handleGenerateLookalikes } from "../src/handlers/lookalikeDomains";
import {
  handleListDarkWebMentions, handleDarkWebOverview, handleTriggerDarkWebScan,
} from "../src/handlers/darkWebMonitor";
import {
  handleListAppStoreListings, handleAppStoreOverview, handleTriggerAppStoreScan,
} from "../src/handlers/appStoreMonitor";
import { handleTrademarkOverview } from "../src/handlers/trademarkMonitor";
import { handleBrandSocialMonitor, handleTriggerSocialScan } from "../src/handlers/socialMonitor";
import type { AuthContext } from "../src/middleware/auth";
import type { Env, UserRole } from "../src/types";

const TABLES = [
  "brands", "monitored_brands", "org_brands", "users",
  "ct_certificates", "lookalike_domains",
  "dark_web_mentions", "dark_web_brand_summary",
  "app_store_listings", "app_store_brand_summary",
  "brand_monitor_schedule", "trademark_assets", "trademark_findings",
  "social_profiles",
];

const STAFF_ROLES: UserRole[] = ["super_admin", "admin", "analyst", "sales", "support", "billing", "auditor"];

// users.role CHECK admits only super_admin/admin/analyst/client (see
// CLAUDE.md §7). Handlers that read the role back from D1 (dark web, app
// store, social) are exercised with the storable staff roles; `auditor` is
// stored as its `analyst` placeholder, exactly like the minted service row.
const DB_ROLE: Record<string, string> = {
  super_admin: "super_admin", admin: "admin", analyst: "analyst", auditor: "analyst", client: "client",
};
const DB_STAFF_ROLES = ["super_admin", "admin", "analyst", "auditor"] as const;

function seed(db: SqliteDb): void {
  db.exec(`
    INSERT INTO brands (id, name, canonical_domain) VALUES
      ('bm1', 'Monitored One', 'one.example'),
      ('bm2', 'Monitored Two', 'two.example'),
      ('bu',  'Unmonitored',   'un.example');
    INSERT INTO monitored_brands (brand_id, added_by) VALUES ('bm1', 'seed'), ('bm2', 'seed');
    INSERT INTO org_brands (org_id, brand_id) VALUES (1, 'bm1');
    INSERT INTO ct_certificates (id, brand_id, domain) VALUES ('ct1', 'bu', 'login-un.example');
    INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type) VALUES ('lk1', 'bu', 'un-example.com', 'hyphenation');
    INSERT INTO dark_web_mentions (id, brand_id, source, source_url, status) VALUES ('dw1', 'bu', 'paste', 'https://paste.example/1', 'active');
    INSERT INTO app_store_listings (id, brand_id, store, app_id, app_name, status) VALUES ('as1', 'bu', 'google_play', 'com.un.fake', 'Un Fake', 'active');
    INSERT INTO trademark_findings (id, brand_id, found_url, status) VALUES
      ('tf1', 'bm2', 'https://tm.example/1', 'active'),
      ('tf2', 'bu',  'https://tm.example/2', 'active');
    INSERT INTO social_profiles (id, brand_id, platform, handle, status) VALUES ('sp1', 'bu', 'twitter', 'un_fake', 'active');
  `);
  for (const [role, dbRole] of Object.entries(DB_ROLE)) {
    db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)")
      .run(`u_${role}`, `${role}@averrow.local`, role, dbRole);
  }
}

function ctxFor(role: UserRole, orgId: string | null = null): AuthContext {
  return {
    userId: `u_${role}`, email: `${role}@averrow.local`, role,
    orgId, orgRole: orgId ? "viewer" : null,
    embeddedScope: undefined, enrollOnly: false,
  };
}

function req(path: string, method = "GET"): Request {
  return new Request(`https://averrow.com${path}`, { method });
}

async function readTotal(res: Response): Promise<{ status: number; total: number | undefined; dataLen: number | undefined }> {
  const body = await res.json<Record<string, unknown>>();
  const data = body.data as unknown;
  const nested = data && !Array.isArray(data) && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const total = (body.total ?? nested?.total) as number | undefined;
  const arr = Array.isArray(data) ? data : Array.isArray(nested?.mentions) ? nested?.mentions
    : Array.isArray(nested?.listings) ? nested?.listings : Array.isArray(nested?.profiles) ? nested?.profiles : undefined;
  return { status: res.status, total, dataLen: (arr as unknown[] | undefined)?.length };
}

describe.skipIf(!hasSqlite())("PR-F: monitor read paths — same full-platform view for every staff role", () => {
  let env: Env;

  beforeEach(() => {
    const raw = openDerivedDb(TABLES);
    seed(raw);
    const d1 = d1FromSqlite(raw);
    const withSession = () => ({ prepare: (sql: string) => d1.prepare(sql), getBookmark: () => null });
    env = { DB: Object.assign(d1, { withSession }), CACHE: fakeKv() } as unknown as Env;
  });

  // ── ctx-role handlers: every staff role, org-less and (analyst) org-scoped ──
  const CTX_CALLERS: Array<[string, AuthContext]> = [
    ...STAFF_ROLES.map((r): [string, AuthContext] => [`org-less ${r}`, ctxFor(r)]),
    ["analyst carrying org 1 in its JWT", ctxFor("analyst", "1")],
  ];

  for (const [label, ctx] of CTX_CALLERS) {
    it(`CT: ${label} lists + stats an unassigned brand`, async () => {
      const list = await readTotal(await handleListCertificates(req("/api/ct/certificates/bu"), env, "bu", ctx));
      expect(list.status).toBe(200);
      expect(list.total).toBe(1);
      const stats = await handleCertStats(req("/api/ct/certificates/bu/stats"), env, "bu", ctx);
      expect(stats.status).toBe(200);
    });

    it(`lookalikes: ${label} lists an unassigned brand`, async () => {
      const r = await readTotal(await handleListLookalikes(req("/api/lookalikes/bu"), env, "bu", ctx));
      expect(r.status).toBe(200);
      expect(r.total).toBe(1);
    });

    it(`dark web overview: ${label} sees every monitored brand`, async () => {
      const r = await readTotal(await handleDarkWebOverview(req("/api/darkweb/overview"), env, ctx));
      expect(r.status).toBe(200);
      expect(r.total).toBe(2);
    });

    it(`app store overview: ${label} sees every monitored brand`, async () => {
      const r = await readTotal(await handleAppStoreOverview(req("/api/appstore/overview"), env, ctx));
      expect(r.status).toBe(200);
      expect(r.total).toBe(2);
    });

    it(`trademark overview: ${label} sees every brand with trademark data`, async () => {
      const r = await readTotal(await handleTrademarkOverview(req("/api/trademarks/overview"), env, ctx));
      expect(r.status).toBe(200);
      expect(r.total).toBe(2);
    });
  }

  // ── DB-role handlers: per-brand reads on the unmonitored brand ──
  for (const role of DB_STAFF_ROLES) {
    it(`dark web / app store / social per-brand reads: ${role} reaches the unmonitored brand`, async () => {
      const dw = await readTotal(await handleListDarkWebMentions(req("/api/darkweb/mentions/bu"), env, "bu", `u_${role}`));
      expect(dw.status).toBe(200);
      expect(dw.total).toBe(1);
      const as = await readTotal(await handleListAppStoreListings(req("/api/appstore/monitor/bu"), env, "bu", `u_${role}`));
      expect(as.status).toBe(200);
      expect(as.total).toBe(1);
      const so = await readTotal(await handleBrandSocialMonitor(req("/api/social/monitor/bu"), env, "bu", `u_${role}`));
      expect(so.status).toBe(200);
      expect(so.total).toBe(1);
    });
  }

  it("client is still refused on the unmonitored brand (defense-in-depth below requireStaff)", async () => {
    expect((await handleListDarkWebMentions(req("/x"), env, "bu", "u_client")).status).toBe(403);
    expect((await handleListAppStoreListings(req("/x"), env, "bu", "u_client")).status).toBe(403);
    expect((await handleBrandSocialMonitor(req("/x"), env, "bu", "u_client")).status).toBe(403);
    expect((await handleListCertificates(req("/x"), env, "bu", ctxFor("client"))).status).toBe(404);
    expect((await handleListLookalikes(req("/x"), env, "bu", ctxFor("client"))).status).toBe(404);
    // Client with an org sees only its org's slice on the overviews.
    const dw = await readTotal(await handleDarkWebOverview(req("/api/darkweb/overview"), env, ctxFor("client", "1")));
    expect(dw.total).toBe(1);
    const dwNone = await readTotal(await handleDarkWebOverview(req("/api/darkweb/overview?limit=10"), env, ctxFor("client")));
    expect(dwNone.total).toBe(0);
  });

  // ── Mutation gates are NOT widened ──
  it("write gates unchanged: an analyst still cannot scan/generate on the unmonitored brand", async () => {
    const analyst = ctxFor("analyst");
    expect((await handleTriggerCTScan(req("/api/ct/scan/bu", "POST"), env, "bu", analyst)).status).toBe(404);
    expect((await handleGenerateLookalikes(req("/api/lookalikes/bu/generate", "POST"), env, "bu", analyst)).status).toBe(404);
    expect((await handleTriggerDarkWebScan(req("/api/darkweb/scan/bu", "POST"), env, "bu", "u_analyst")).status).toBe(403);
    expect((await handleTriggerAppStoreScan(req("/api/appstore/scan/bu", "POST"), env, "bu", "u_analyst")).status).toBe(403);
    expect((await handleTriggerSocialScan(req("/api/social/scan/bu", "POST"), env, "bu", "u_analyst")).status).toBe(403);
  });

  it("write gates unchanged: admin (not super_admin) still cannot CT-scan or generate lookalikes on an unassigned brand", async () => {
    const admin = ctxFor("admin");
    expect((await handleTriggerCTScan(req("/api/ct/scan/bu", "POST"), env, "bu", admin)).status).toBe(404);
    expect((await handleGenerateLookalikes(req("/api/lookalikes/bu/generate", "POST"), env, "bu", admin)).status).toBe(404);
  });
});
