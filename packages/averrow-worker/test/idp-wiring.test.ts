// IdP impersonation wiring (docs/IDP_IMPERSONATION_PLAN_2026-10.md T2–T5):
// tagging glue, brand attribution on IdP tenant hosts, lookalike triage
// non-dismissal, dnstwist lure reservation, and the summary roll-up.
import { describe, it, expect } from "vitest";
import { tagThreat, needsBrandTokens, brandTokensFrom, lookalikeIdpLure } from "../src/lib/idp-tagging";
import { fuzzyMatchBrandDetailed, isPlatformTenantHost, isIdpTenantHost, isSharedHostingHost, tagIdpAfterBrandMatch, type BrandRow } from "../src/lib/brandDetect";
import { scoreAbuseHeuristics, type HeuristicInput } from "../src/lib/abuse-mailbox-heuristics";
import { decideLookalikeRegistrationTriage } from "../src/lib/alert-triage";
import { isUnderSharedHosting, resolveOfficialDomain, type OfficialDomainRow } from "../src/lib/safeDomains";
import { generatePermutations, generateIdpLurePermutations, IDP_LURE_PREFIXES, IDP_LURE_SUFFIXES } from "../src/lib/dnstwist";
import { STRONG_WORDS } from "../src/lib/nrd-brand-match";
import { IDP_TENANT_HOSTS, IDP_MITRE } from "../src/lib/idp-impersonation";
import { computeIdentityThreats, parseIdentityWindow } from "../src/handlers/identityThreats";
import {
  parseIdpBackfillLimit, parseIdpLureTopupBrands, topUpIdpLures, IDP_LURE_TOPUP_CURSOR_KEY,
  handleBackfillIdpImpersonation, handleIdpLureTopup,
  IDP_BACKFILL_THREAT_CURSOR_KEY, IDP_BACKFILL_LOOKALIKE_CURSOR_KEY,
} from "../src/handlers/admin/idpBackfill";
import type { AuthContext } from "../src/middleware/auth";
import { classifyIdpImpersonation } from "../src/lib/idp-impersonation";
import type { Env } from "../src/types";

describe("tagThreat", () => {
  it("stamps an IdP tenant host", () => {
    expect(tagThreat({ malicious_domain: "acme-sso.okta.com", malicious_url: "https://acme-sso.okta.com/login" }))
      .toEqual({ technique: "idp_tenant_abuse", impersonated_idp: "okta" });
  });
  it("never overwrites a non-family technique", () => {
    expect(tagThreat({ malicious_domain: "acme-okta.com", technique: "clickfix" }))
      .toEqual({ technique: "clickfix", impersonated_idp: null });
  });
  it("keeps an existing device-code technique and refines the idp", () => {
    expect(tagThreat({ malicious_domain: "example.org", technique: "device_code_phishing" }))
      .toEqual({ technique: "device_code_phishing", impersonated_idp: "entra" });
  });
  it("passes through untouched when nothing matches", () => {
    expect(tagThreat({ malicious_domain: "example.org" })).toEqual({ technique: null, impersonated_idp: null });
    expect(tagThreat({ malicious_domain: null, malicious_url: null })).toEqual({ technique: null, impersonated_idp: null });
  });
  it("admits a weak lure only with brand tokens", () => {
    const row = { malicious_domain: "acme-servicedesk.com" };
    expect(tagThreat(row).impersonated_idp).toBeNull();
    expect(needsBrandTokens(row)).toBe(true);
    expect(tagThreat(row, brandTokensFrom("Acme Corp", "acme.com")))
      .toEqual({ technique: "idp_lookalike", impersonated_idp: "generic_sso" });
  });
  it("needsBrandTokens is false for strong lures, plain hosts and set techniques", () => {
    expect(needsBrandTokens({ malicious_domain: "acme-okta.com" })).toBe(false);
    expect(needsBrandTokens({ malicious_domain: "example.org" })).toBe(false);
    expect(needsBrandTokens({ malicious_domain: "acme-helpdesk.com", technique: "clickfix" })).toBe(false);
  });
});

describe("brand attribution on IdP tenant hosts (T3)", () => {
  const BRANDS: BrandRow[] = [
    { id: "b_okta", name: "Okta", canonical_domain: "okta.com", tier: "monitored" },
    { id: "b_acme", name: "Acmecorp", canonical_domain: "acmecorp.com", tier: "monitored" },
  ] as BrandRow[];
  it.each([
    "acmecorp-sso.okta.com",
    "acmecorp.oktapreview.com",
    "acmecorp-admin.okta.com",
    "acmecorp.eu.auth0.com",
    "acmecorp.onelogin.com",
    "openam-acmecorp.forgeblocks.com",
  ])("%s → the tenant brand, not the IdP", (host) => {
    expect(fuzzyMatchBrandDetailed([host], BRANDS)?.brandId).toBe("b_acme");
  });
  it("an unbranded tenant does not credit the IdP vendor", () => {
    expect(fuzzyMatchBrandDetailed(["randomtenant.okta.com"], BRANDS)?.brandId ?? null).not.toBe("b_okta");
  });
});

describe("lookalike triage never dismisses an IdP tenant as an official subdomain (T3)", () => {
  const trustedOkta: OfficialDomainRow = {
    domain: "okta.com", brand_id: "b_okta", brand_name: "Okta", source: "canonical_domain", trusted: 1,
  };
  it("every IdP tenant suffix is shared hosting", () => {
    for (const suffix of Object.keys(IDP_TENANT_HOSTS)) {
      expect(isUnderSharedHosting(`acme.${suffix}`), suffix).toBe(true);
    }
  });
  it("acme-sso.okta.com is not a trusted subdomain of okta.com", () => {
    expect(resolveOfficialDomain("acme-sso.okta.com", [trustedOkta]).trusted).toBeNull();
  });
  it("keeps the alert", () => {
    const d = decideLookalikeRegistrationTriage(
      { lookalike_domain: "acme-sso.okta.com" },
      { officialRows: [trustedOkta], nowMs: Date.parse("2026-10-10T00:00:00Z") },
    );
    expect(d.action).toBe("keep");
  });
  it("the apex itself still matches exactly", () => {
    expect(resolveOfficialDomain("okta.com", [trustedOkta]).trusted?.brand_id).toBe("b_okta");
  });
});

describe("detection widening (T5)", () => {
  const lures = (name: string, tld = "com") => [
    ...IDP_LURE_PREFIXES.map((p) => `${p}${name}.${tld}`),
    ...IDP_LURE_SUFFIXES.map((s) => `${name}${s}.${tld}`),
  ];
  it.each(["acme.com", "paypal.com", "bankofamerica.com", "microsoft.com"])(
    "%s appends every IdP lure ON TOP of the 30-cap",
    (domain) => {
      const perms = generatePermutations(domain);
      const name = domain.split(".")[0]!;
      const lureSet = new Set(lures(name));
      const core = perms.filter((p) => !lureSet.has(p.domain));
      expect(core).toHaveLength(30);
      expect(perms).toHaveLength(37);
      expect(perms.slice(30).map((p) => p.domain)).toEqual(lures(name));
      expect(perms.slice(30).every((p) => p.type === "keyword")).toBe(true);
      expect(new Set(perms.map((p) => p.domain)).size).toBe(perms.length);
      expect(perms.some((p) => p.type === "idn_homoglyph")).toBe(true);
    },
  );
  it("generateIdpLurePermutations yields only the 7 lures", () => {
    expect(generateIdpLurePermutations("Acme.co.uk").map((p) => p.domain)).toEqual(lures("acme", "co.uk"));
    expect(generateIdpLurePermutations("x.com")).toEqual([]);
  });
  it("NRD matcher treats okta / vpn / servicedesk as strong lures", () => {
    for (const w of ["okta", "vpn", "servicedesk", "sso", "helpdesk"]) expect(STRONG_WORDS.has(w), w).toBe(true);
  });
});

describe("endpoint params", () => {
  it("parses window", () => {
    expect(parseIdentityWindow(null)).toBe("7d");
    expect(parseIdentityWindow("30d")).toBe("30d");
    expect(parseIdentityWindow("90d")).toBeNull();
    expect(parseIdentityWindow("7")).toBeNull();
  });
  it("clamps backfill limit", () => {
    expect(parseIdpBackfillLimit(null)).toBe(500);
    expect(parseIdpBackfillLimit("abc")).toBe(500);
    expect(parseIdpBackfillLimit("-5")).toBe(500);
    expect(parseIdpBackfillLimit("200")).toBe(200);
    expect(parseIdpBackfillLimit("5000")).toBe(1000);
  });
});

describe("computeIdentityThreats roll-up (T4)", () => {
  type Row = Record<string, unknown>;
  const current: Row[] = [
    { technique: "idp_tenant_abuse", idp: "okta", brand_id: "b1", day: "2026-10-09", status: "active", n: 3 },
    { technique: "idp_lookalike", idp: "generic_sso", brand_id: "b1", day: "2026-10-10", status: "down", n: 2 },
    { technique: "idp_lookalike", idp: "okta", brand_id: "b2", day: "2026-10-10", status: "remediated", n: 1 },
    { technique: "device_code_phishing", idp: null, brand_id: null, day: "2026-10-08", status: "active", n: 4 },
  ];
  const prev: Row[] = [
    { technique: "idp_tenant_abuse", idp: "okta", n: 5 },
    { technique: "oauth_consent_phishing", idp: null, n: 1 },
  ];
  const recent: Row[] = [
    { id: "t1", malicious_domain: null, malicious_url: "https://acme-sso.okta.com/x", target_brand_id: "b1",
      brand_name: "Acme", impersonated_idp: "okta", technique: "idp_tenant_abuse", status: "active",
      created_at: "2026-10-10 09:00:00" },
  ];
  const binds: unknown[][] = [];
  let lureSql = "";
  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => {
      binds.push(args);
      return {
        all: async () => ({
          results: sql.includes("FROM brands WHERE id IN")
            ? [{ id: "b1", name: "Acme" }, { id: "b2", name: "Globex" }]
            : sql.includes("LEFT JOIN brands") ? recent
            : sql.includes("created_at < ?") ? prev
            : current,
        }),
        first: async () => { lureSql = sql; return { n: 9 }; },
      };
    },
  });
  const env = { DB: { withSession: () => ({ prepare: stmt }) } } as unknown as Env;

  it("matches the ops contract", async () => {
    const data = await computeIdentityThreats(env, { bookmark: null }, "7d", new Date("2026-10-10T12:00:00Z"));
    expect(data.window).toBe("7d");
    expect(data.kpis).toEqual({
      detections: 10, detections_prev: 6, brands_targeted: 2, idps_impersonated: 3,
      live: 7, taken_down: 3, lookalikes_flagged: 9,
    });
    expect(data.trend).toHaveLength(7);
    expect(data.trend[0]).toEqual({ day: "2026-10-04", count: 0 });
    expect(data.trend[6]).toEqual({ day: "2026-10-10", count: 3 });
    expect(data.by_vector.map((v) => [v.vector, v.count, v.prev])).toEqual([
      ["device_code", 4, 1], ["idp_tenant", 3, 5], ["idp_lookalike", 3, 0],
    ]);
    expect(data.by_idp.find((i) => i.idp === "okta")).toEqual({ idp: "okta", label: "Okta", count: 4, brands: 2, prev: 5 });
    expect(data.by_idp.find((i) => i.idp === "entra")).toMatchObject({ count: 4, prev: 1 });
    expect(data.top_brands[0]).toEqual({ brand_id: "b1", brand_name: "Acme", count: 5, idps: ["Okta", "Generic SSO"] });
    expect(data.recent[0]).toEqual({
      threat_id: "t1", domain: "acme-sso.okta.com", brand_id: "b1", brand_name: "Acme", idp: "Okta",
      vector: "idp_tenant", status: "active", created_at: "2026-10-10T09:00:00Z",
    });
    expect(data.mitre).toHaveLength(IDP_MITRE.length);
    expect(data.mitre.find((m) => m.id === "T1528")?.count).toBe(4);
    expect(data.mitre.find((m) => m.id === "T1566.002")?.count).toBe(10);
    // Window starts at the UTC day 6 days before today; previous window is 7 days earlier.
    expect(binds[0]).toContain("2026-10-04 00:00:00");
    // Previous window = same elapsed span shifted back 7 days: [09-27 00:00, 10-03 12:00).
    expect(binds[1]).toEqual(expect.arrayContaining(["2026-09-27 00:00:00", "2026-10-03 12:00:00"]));
    expect(binds[1]).not.toContain("2026-10-04 00:00:00");
    // Lookalike KPI counts registered, non-benign detections by first_seen.
    expect(lureSql).toMatch(/registered = 1/);
    expect(lureSql).toMatch(/status != 'benign'/);
    expect(lureSql).toMatch(/first_seen >= \?/);
    expect(binds[3]).toEqual(["2026-10-04"]);
  });
});

describe("IdP lure top-up for already-seeded brands", () => {
  it("clamps brands", () => {
    expect(parseIdpLureTopupBrands(null)).toBe(50);
    expect(parseIdpLureTopupBrands("500")).toBe(200);
    expect(parseIdpLureTopupBrands("0")).toBe(50);
  });

  function harness(brands: Array<{ rid: number; brand_id: string; domain: string }>, trusted: string[] = []) {
    const kv = new Map<string, string>();
    const inserts: Array<{ sql: string; args: unknown[] }> = [];
    const brandBinds: unknown[][] = [];
    const prepare = (sql: string) => ({
      bind: (...args: unknown[]) => ({
        sql, args,
        all: async () => {
          if (sql.includes("b.rowid AS rid")) { brandBinds.push(args); return { results: brands }; }
          // loadOfficialDomainMatches: return a trusted canonical row per requested trusted domain.
          return { results: trusted.filter((d) => args.includes(d)).map((d) => ({
            domain: d, brand_id: "other", brand_name: "Other", source: "canonical_domain", trusted: 1 })) };
        },
      }),
    });
    const env = {
      CACHE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
      DB: {
        prepare,
        batch: async (stmts: Array<{ sql: string; args: unknown[] }>) => {
          inserts.push(...stmts);
          return stmts.map(() => ({ meta: { changes: 1 } }));
        },
      },
    } as unknown as Env;
    return { env, kv, inserts, brandBinds };
  }

  it("inserts only lure permutations, scoped to seeded monitored brands, and advances the cursor", async () => {
    const h = harness([{ rid: 11, brand_id: "b1", domain: "acme.com" }, { rid: 42, brand_id: "b2", domain: "globex.io" }],
      ["acme-vpn.com"]);
    const r = await topUpIdpLures(h.env, 2);
    expect(r).toEqual({ brands_scanned: 2, inserted: 14, cursor: 42, done: false });
    expect(h.kv.get(IDP_LURE_TOPUP_CURSOR_KEY)).toBe("42");
    expect(h.brandBinds[0]).toEqual([0, 2]);
    expect(h.inserts).toHaveLength(14);
    for (const ins of h.inserts) {
      expect(ins.sql).toMatch(/INSERT OR IGNORE INTO lookalike_domains/);
      expect(ins.sql).toMatch(/idp_lure/);
      expect(ins.args[3]).toBe("keyword");
      // Every bind count stays far below D1's 100.
      expect(ins.args.length).toBeLessThan(100);
    }
    const vpn = h.inserts.find((i) => i.args[2] === "acme-vpn.com")!;
    expect(vpn.sql).toMatch(/'benign'/);
    expect(vpn.args.at(-1)).toBe("generic_sso");
    const okta = h.inserts.find((i) => i.args[2] === "globex-okta.io")!;
    expect(okta.sql).not.toMatch(/'benign'/);
    expect(okta.args.at(-1)).toBe("okta");
  });

  it("resumes from the cursor and reports done when the page is short", async () => {
    const h = harness([]);
    h.kv.set(IDP_LURE_TOPUP_CURSOR_KEY, "42");
    expect(await topUpIdpLures(h.env, 50)).toEqual({ brands_scanned: 0, inserted: 0, cursor: 42, done: true });
    expect(h.brandBinds[0]).toEqual([42, 50]);
  });
});

describe("review fixes", () => {
  it("brand tokens are the full name + canonical label, never single words (expressvpn)", () => {
    expect(brandTokensFrom("American Express", "americanexpress.com")).toEqual(["American Express", "americanexpress"]);
    expect(tagThreat({ malicious_domain: "expressvpn.com" }, brandTokensFrom("American Express", "americanexpress.com")).impersonated_idp)
      .toBeNull();
  });

  it("one lure rule for seeder / top-up / lookalike backfill", () => {
    expect(lookalikeIdpLure("acme-helpdesk.com", "acme.com")).toBe("generic_sso");
    expect(lookalikeIdpLure("acme-okta.com", "acme.com")).toBe("okta");
    expect(lookalikeIdpLure("acmee.com", "acme.com")).toBeNull();
    expect(lookalikeIdpLure("acme-helpdesk.com", null)).toBeNull();
  });

  it("bbva-entra / mail550 never classify (brand or not)", () => {
    expect(classifyIdpImpersonation({ host: "bbva-entra.com", brandTokens: ["bbva"] })).toBeNull();
    expect(classifyIdpImpersonation({ host: "mail550.com" })).toBeNull();
  });

  it("IdP vendor-owned subdomains are not platform tenants; tenants are", () => {
    for (const h of ["login.okta.com", "status.okta.com", "eu.auth0.com", "support.onelogin.com"]) {
      expect(isPlatformTenantHost(h), h).toBe(false);
      expect(isIdpTenantHost(h), h).toBe(false);
    }
    expect(isPlatformTenantHost("acme.okta.com")).toBe(true);
    expect(isIdpTenantHost("acme.eu.auth0.com")).toBe(true);
    expect(isSharedHostingHost("okta.com")).toBe(false);
    expect(isSharedHostingHost("pages.dev")).toBe(true);
  });

  it("abuse-mailbox does not flag a legitimate IdP tenant link as free hosting", () => {
    const base: HeuristicInput = {
      senderEmail: "it@acme.example", subject: "Sign in", bodyText: "Please sign in",
      urls: [], attachments: [], brand: null, safeDomains: null, authResults: null, isAttachmentForward: false,
    };
    const codes = (u: string, h: string) =>
      scoreAbuseHeuristics({ ...base, urls: [{ url: u, host: h }] }).signals.map((x) => x.code);
    expect(codes("https://acme.okta.com/app", "acme.okta.com")).not.toContain("link_free_hosting");
    expect(codes("https://x.pages.dev/", "x.pages.dev")).toContain("link_free_hosting");
  });

  it("brand-match step tags a weak lure once the brand is known, with the family guard", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ run: async () => { calls.push({ sql, args }); } }) }),
    } as unknown as D1Database;
    const row = { id: "t1", malicious_domain: "acme-helpdesk.com", malicious_url: null, technique: null };
    await tagIdpAfterBrandMatch(db, row, { name: "Acme", canonical_domain: "acme.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/technique IS NULL OR technique IN/);
    expect(calls[0]!.args.slice(0, 3)).toEqual(["idp_lookalike", "generic_sso", "t1"]);
    // Non-family technique: never touched. Unrelated host: no statement.
    await tagIdpAfterBrandMatch(db, { ...row, technique: "clickfix" }, { name: "Acme", canonical_domain: "acme.com" });
    await tagIdpAfterBrandMatch(db, { ...row, malicious_domain: "acme-shop.com" }, { name: "Acme", canonical_domain: "acme.com" });
    expect(calls).toHaveLength(1);
  });
});

describe("backfill audit-first + reset", () => {
  const ctx = { userId: "u_admin" } as AuthContext;
  function env(opts: { failDb?: boolean } = {}) {
    const kv = new Map<string, string>([[IDP_BACKFILL_THREAT_CURSOR_KEY, "10"], [IDP_BACKFILL_LOOKALIKE_CURSOR_KEY, "20"],
      [IDP_LURE_TOPUP_CURSOR_KEY, "30"]]);
    const audits: Array<{ action: unknown; outcome: unknown; at: number }> = [];
    let seq = 0;
    const dbWrites: number[] = [];
    const e = {
      CACHE: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => { kv.set(k, v); },
        delete: async (k: string) => { kv.delete(k); },
      },
      AUDIT_DB: { prepare: () => ({ bind: (...a: unknown[]) => ({ run: async () => { audits.push({ action: a[2], outcome: a[8], at: seq++ }); } }) }) },
      DB: {
        prepare: () => ({ bind: () => ({ all: async () => {
          if (opts.failDb) throw new Error("boom");
          return { results: [] };
        } }) }),
        batch: async () => { dbWrites.push(seq++); return []; },
      },
    } as unknown as Env;
    return { e, kv, audits };
  }
  const req = (q: string) => new Request(`https://x/api/admin/backfills/idp-impersonation${q}`, { method: "POST" });

  it("audits before running and after completing", async () => {
    const h = env();
    const res = await handleBackfillIdpImpersonation(req("?limit=5"), h.e, ctx);
    expect(res.status).toBe(200);
    expect(h.audits.map((a) => a.action)).toEqual(["backfill_idp_impersonation_started", "backfill_idp_impersonation"]);
  });

  it("records a failure audit when the pass throws", async () => {
    const h = env({ failDb: true });
    const res = await handleBackfillIdpImpersonation(req(""), h.e, ctx);
    expect(res.status).toBe(500);
    expect(h.audits.map((a) => [a.action, a.outcome])).toEqual([
      ["backfill_idp_impersonation_started", "success"], ["backfill_idp_impersonation", "failure"],
    ]);
  });

  it("?reset=1 clears the cursors, audits, and runs nothing", async () => {
    const h = env();
    const res = await handleBackfillIdpImpersonation(req("?reset=1"), h.e, ctx);
    const body = await res.json() as { data: { reset: boolean } };
    expect(body.data.reset).toBe(true);
    expect(h.kv.has(IDP_BACKFILL_THREAT_CURSOR_KEY)).toBe(false);
    expect(h.kv.has(IDP_BACKFILL_LOOKALIKE_CURSOR_KEY)).toBe(false);
    expect(h.kv.get(IDP_LURE_TOPUP_CURSOR_KEY)).toBe("30");
    expect(h.audits.map((a) => a.action)).toEqual(["backfill_idp_impersonation_reset"]);

    const h2 = env();
    await handleIdpLureTopup(new Request("https://x/api/admin/backfills/idp-lure-topup?reset=1", { method: "POST" }), h2.e, ctx);
    expect(h2.kv.has(IDP_LURE_TOPUP_CURSOR_KEY)).toBe(false);
    expect(h2.kv.get(IDP_BACKFILL_THREAT_CURSOR_KEY)).toBe("10");
    expect(h2.audits.map((a) => a.action)).toEqual(["backfill_idp_lure_topup_reset"]);
  });
});

describe("abuse-mailbox technique precedence (real SQLite)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { promoteToThreats } = await import("../src/lib/abuse-mailbox-iocs");
  const { threatId } = await import("../src/feeds/types");

  function harness() {
    const sql = new DatabaseSync(":memory:");
    sql.exec(`CREATE TABLE threats (id TEXT PRIMARY KEY, source_feed TEXT, threat_type TEXT, malicious_url TEXT,
      malicious_domain TEXT, target_brand_id TEXT, hosting_provider_id TEXT, ip_address TEXT, asn TEXT,
      country_code TEXT, registrar TEXT, status TEXT, confidence_score INTEGER, campaign_id TEXT, ioc_value TEXT,
      severity TEXT, is_private_ip INTEGER, technique TEXT, impersonated_idp TEXT, named_threat_id TEXT,
      ssl_cert_serial TEXT, ssl_cert_issuer TEXT, ssl_san_hash TEXT, first_seen TEXT, last_seen TEXT, created_at TEXT)`);
    const DB = {
      prepare: (q: string) => ({
        bind: (...a: unknown[]) => ({
          run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...(a as never[])).changes) } }),
        }),
      }),
    };
    return { sql, env: { DB } as unknown as Env };
  }
  const url = "https://acme-sso.okta.com/login";
  const id = threatId("abuse_mailbox", "url", url);
  const promote = (env: Env, technique: string | null) => promoteToThreats(env, {
    urls: [{ url, domain: "acme-sso.okta.com" } as never], classification: "phishing", confidence: 90,
    brandId: null, senderIp: null, messageId: "m1", technique,
  });
  const read = (s: InstanceType<typeof DatabaseSync>) =>
    s.prepare("SELECT technique, impersonated_idp FROM threats WHERE id = ?").get(id);

  it("a non-family mailbox technique replaces an IdP-family label and clears the idp", async () => {
    const h = harness();
    await promote(h.env, null);
    expect(read(h.sql)).toEqual({ technique: "idp_tenant_abuse", impersonated_idp: "okta" });
    await promote(h.env, "clickfix");
    expect(read(h.sql)).toEqual({ technique: "clickfix", impersonated_idp: null });
  });

  it("a family technique never replaces a non-family one", async () => {
    const h = harness();
    await promote(h.env, "clickfix");
    await promote(h.env, "device_code_phishing");
    expect(read(h.sql)).toEqual({ technique: "clickfix", impersonated_idp: null });
  });
});
