import { beforeEach, describe, it, expect } from "vitest";
import {
  decideReattribution,
  handleIdpReattribution,
  IDP_REATTRIBUTION_DEFAULT_RUN_ID,
  runIdpReattribution,
  type ReattributionRow,
} from "../src/handlers/admin/idpReattribution";
import { fuzzyMatchBrandDetailed, resetBrandCatalogCacheForTest, type BrandRow } from "../src/lib/brandDetect";
import { decideLink, type LinkRow } from "../src/lib/brand-link-cleanup";
import type { Env } from "../src/types";

// loadBrandsCached memoizes the catalog per isolate; each test stubs its own.
beforeEach(() => resetBrandCatalogCacheForTest());

const CATALOG: BrandRow[] = [
  { id: "b_okta", name: "Okta", canonical_domain: "okta.com", tier: "monitored" },
  { id: "b_ms", name: "Microsoft", canonical_domain: "microsoft.com", tier: "monitored" },
  { id: "b_persona", name: "Persona", canonical_domain: "withpersona.com", tier: "monitored" },
  { id: "b_acme", name: "Acme", canonical_domain: "acme.com", tier: "monitored" },
];
const rematch = (h: string[]) => fuzzyMatchBrandDetailed(h, CATALOG);

const row = (domain: string, over: Partial<ReattributionRow> = {}): ReattributionRow => ({
  rid: 1, id: `t_${domain}`, malicious_domain: domain, malicious_url: null, ioc_value: null,
  source_feed: "phishtank", target_brand_id: "b_okta", brand_match_method: "token",
  brand_name: "Okta", brand_canonical: "okta.com", brand_tier: "monitored", ...over,
});

describe("decideReattribution", () => {
  it("relinks an Okta-credited lure lookalike to the targeted brand", () => {
    expect(decideReattribution(row("withpersona.okta-linksso.com"), rematch))
      .toEqual({ action: "relink", newBrandId: "b_persona", method: "token" });
    expect(decideReattribution(row("okta-acme.com"), rematch))
      .toEqual({ action: "relink", newBrandId: "b_acme", method: "token" });
  });

  it("relinks an Okta-credited tenant host to the tenant brand", () => {
    expect(decideReattribution(row("acme-sso.okta.com"), rematch).newBrandId).toBe("b_acme");
  });

  it("keeps the vendor credit on a vendor-only lure", () => {
    expect(decideReattribution(row("okta-login-secure.com"), rematch))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
  });

  it("keeps the vendor when the leftover matches no brand", () => {
    expect(decideReattribution(row("contosoltd.okta-linksso.com"), rematch))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
  });

  it("clears when nothing in the catalog matches", () => {
    expect(decideReattribution(row("okta-acme.com"), () => null))
      .toEqual({ action: "clear", newBrandId: null, method: null });
  });

  it("leaves links the lure-token rule did not make", () => {
    // Microsoft credit on a host without "microsoft" (AI / page-context link).
    expect(decideReattribution(row("acme-adfs.com", {
      target_brand_id: "b_ms", brand_name: "Microsoft", brand_canonical: "microsoft.com",
    }), rematch)).toMatchObject({ action: "keep", keptBecause: "not_lure_credit" });
    expect(decideReattribution(row("okta-acme.com", { source_feed: "typosquat_scanner" }), rematch))
      .toMatchObject({ action: "keep", keptBecause: "protected_feed" });
  });
});

describe("production dry run 2026-10-12 — the 11 proposed changes", () => {
  // Catalog junk that won before: substring "author" in "authorize", the
  // login words "register" / "logmein", and Microsoft's own products.
  const PROD: BrandRow[] = [
    ...CATALOG,
    { id: "b_author", name: "Author", canonical_domain: "author.today", tier: "monitored" },
    { id: "b_authortoday", name: "Author.Today", canonical_domain: "author.today", tier: "monitored" },
    { id: "b_register", name: "Register", canonical_domain: "register.com", tier: "monitored", tranco_rank: 2500 },
    { id: "b_logmein", name: "LogMeIn", canonical_domain: "logmein.com", tier: "monitored", tranco_rank: 1800 },
    { id: "b_asana", name: "Asana", canonical_domain: "asana.com", tier: "monitored" },
    { id: "b_outlook", name: "Outlook", canonical_domain: "outlook.com", tier: "monitored" },
    { id: "b_onedrive", name: "OneDrive", canonical_domain: "onedrive.com", tier: "monitored" },
    { id: "b_teams", name: "Teams Hub", canonical_domain: "teams.com", tier: "monitored" },
  ];
  const prodRematch = (h: string[]) => fuzzyMatchBrandDetailed(h, PROD);
  const ms = { target_brand_id: "b_ms", brand_name: "Microsoft", brand_canonical: "microsoft.com" };
  const AUTHZ = "teams-microsoftonline-com-common-oauth2-v2-0-authorize-login.com";

  it.each([
    [`login.login.o365.${AUTHZ}`, "still_matches"],
    [`mail.${AUTHZ}`, "still_matches"],
    [`o365.${AUTHZ}`, "still_matches"],
    ["register.microsoftonline-p-int.com", "still_matches"],
    ["logmein-microsoftonline.com", "still_matches"],
    ["https://logmein-microsoftonline.com/common/oauth2/authorize", "still_matches"],
    ["*.dns.partner.microsoftonline.cn", "vendor_official_domain"],
    ["dns.partner.microsoftonline.cn", "vendor_official_domain"],
    // Same-vendor product leftovers keep the Microsoft credit.
    ["microsoftonline-outlook.live", "still_matches"],
    ["com-microsoftonline-ondrive.ca", "still_matches"],
  ])("Microsoft-credited %s → keep (%s)", (host, reason) => {
    const r = host.startsWith("https://")
      ? row("logmein-microsoftonline.com", { ...ms, malicious_url: host })
      : row(host, ms);
    expect(decideReattribution(r, prodRematch)).toMatchObject({ action: "keep", keptBecause: reason });
  });

  it.each([
    "ms365-copilot.onmicrosoft.aviasg.co",
    "login-microsoftonnline.jimdofree.com",
  ])("second prod dry run: Microsoft-credited %s → keep", (host) => {
    const cat: BrandRow[] = [
      ...PROD,
      { id: "brand_copilot_com", name: "Copilot", canonical_domain: "copilot.com", tier: "monitored" },
      { id: "brand_jimdofree_com", name: "Jimdofree", canonical_domain: "jimdofree.com", tier: "monitored" },
      { id: "brand_aviasg_co", name: "Aviasg", canonical_domain: "aviasg.co", tier: "tracked", tranco_rank: 900000 },
    ];
    expect(decideReattribution(row(host, ms), (h) => fuzzyMatchBrandDetailed(h, cat)))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
  });

  it.each([
    ["asana-okta.com", "b_asana"], ["databricks-okta.com", "b_databricks"], ["dialpad.okta-sso.com", "b_dialpad"],
    ["smartbear-okta.com", "b_smartbear"], ["smartbear.okta-login.com", "b_smartbear"],
    ["medallia-okta.com", "b_medallia"], ["withpersona.okta-linksso.com", "b_persona"],
    ["withpersona-okta.com", "b_persona"], ["appsflyer-okta.com", "b_appsflyer"],
    ["appsflyer.okta-verify.com", "b_appsflyer"], ["zendesk-okta.com", "b_zendesk"],
  ])("Okta → targeted brand: %s → %s", (host, brand) => {
    const cat: BrandRow[] = [
      ...PROD,
      ...["Databricks", "Dialpad", "SmartBear", "Medallia", "AppsFlyer", "Zendesk"].map((n) =>
        ({ id: `b_${n.toLowerCase()}`, name: n, canonical_domain: `${n.toLowerCase()}.com`, tier: "monitored" })),
    ];
    expect(decideReattribution(row(host), (h) => fuzzyMatchBrandDetailed(h, cat)))
      .toMatchObject({ action: "relink", newBrandId: brand });
  });

  it("asana-okta.com Okta → Asana (whole-token leftover)", () => {
    expect(decideReattribution(row("asana-okta.com"), prodRematch))
      .toEqual({ action: "relink", newBrandId: "b_asana", method: "token" });
  });

  it("earlier cases are unchanged", () => {
    expect(decideReattribution(row("withpersona.okta-linksso.com"), prodRematch).newBrandId).toBe("b_persona");
    expect(decideReattribution(row("okta-acme.com"), prodRematch).newBrandId).toBe("b_acme");
    expect(decideReattribution(row("www2.okta-login.com"), prodRematch))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
    expect(decideReattribution(row("okta-login-secure.com"), prodRematch))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
  });

  it("vendor credit keeps the existing vendor link even on a duplicate vendor row", () => {
    const dup: BrandRow[] = [{ id: "b_ms_dup", name: "Microsoft", canonical_domain: "microsoft.net", tier: "monitored" }, ...PROD];
    expect(decideReattribution(row("logmein-microsoftonline.com", ms), (h) => fuzzyMatchBrandDetailed(h, dup)))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
  });

  it("vendor_official_domain looks at the threat's own host, not every haystack", () => {
    expect(decideReattribution(row("okta-acme.com", { ioc_value: "login.microsoftonline.com" }), prodRematch).newBrandId)
      .toBe("b_acme");
  });

  it("the general brand-link cleanup keeps links the old rules accepted", () => {
    const link = (domain: string, name: string, canonical: string, id: string): LinkRow => ({
      rid: 1, id: `t_${domain}`, malicious_domain: domain, malicious_url: null, ioc_value: null,
      target_brand_id: id, brand_match_method: "token", brand_name: name, brand_canonical: canonical,
      brand_tier: "monitored", source_feed: "phishtank",
    } as LinkRow);
    const cleanupRematch = (h: string[]) => fuzzyMatchBrandDetailed(h, PROD);
    expect(decideLink(link("paypa1-okta.com", "PayPal", "paypal.com", "b_pp"), cleanupRematch).action).toBe("keep");
    expect(decideLink(link("microsoftonline-outlook.live", "Outlook", "outlook.com", "b_outlook"), cleanupRematch).action)
      .toBe("keep");
    expect(decideLink(link("logmein-microsoftonline.com", "Microsoft", "microsoft.com", "b_ms"), cleanupRematch).action)
      .toBe("keep");
  });

  it("Okta's own corp hosts are never re-attributed", () => {
    expect(decideReattribution(row("login.okta.com"), () => null))
      .toMatchObject({ action: "keep", keptBecause: "vendor_official_domain" });
    // …but a customer tenant still is.
    expect(decideReattribution(row("acme-sso.okta.com"), prodRematch).newBrandId).toBe("b_acme");
  });
});

describe("scope=all_idp — revisit links made under earlier leftover rules", () => {
  const CAT: BrandRow[] = [
    ...CATALOG,
    { id: "brand_copilot_com", name: "Copilot", canonical_domain: "copilot.com", tier: "monitored" },
    { id: "brand_jimdofree_com", name: "Jimdofree", canonical_domain: "jimdofree.com", tier: "monitored" },
    { id: "b_edge", name: "Edge", canonical_domain: "edge.org", tier: "monitored" },
    { id: "b_viva", name: "Viva Wallet", canonical_domain: "vivawallet.com", tier: "monitored" },
    { id: "b_slack", name: "Slack", canonical_domain: "slack.com", tier: "monitored" },
    { id: "b_cust", name: "Contoso", canonical_domain: "contoso.com", tier: "customer" },
  ];
  const rm = (h: string[]) => fuzzyMatchBrandDetailed(h, CAT);
  const on = (domain: string, id: string, name: string, canonical: string, tier = "monitored") =>
    row(domain, { target_brand_id: id, brand_name: name, brand_canonical: canonical, brand_tier: tier });
  const all = (r: ReattributionRow) => decideReattribution(r, rm, "all_idp");

  it("a Microsoft product word credit moves to Microsoft", () => {
    expect(all(on("ms365-copilot.onmicrosoft.aviasg.co", "brand_copilot_com", "Copilot", "copilot.com")))
      .toEqual({ action: "relink", newBrandId: "b_ms", method: "token" });
    expect(all(on("edge-microsoftonline.com", "b_edge", "Edge", "edge.org")).newBrandId).toBe("b_ms");
  });

  it("a free-builder platform credit moves to the vendor", () => {
    expect(all(on("login-microsoftonnline.jimdofree.com", "brand_jimdofree_com", "Jimdofree", "jimdofree.com")))
      .toMatchObject({ action: "relink", newBrandId: "b_ms" });
  });

  it("a link the current matcher still produces is kept", () => {
    expect(all(on("withpersona.okta-linksso.com", "b_persona", "Persona", "withpersona.com")))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
    expect(all(on("slack-okta.com", "b_slack", "Slack", "slack.com")))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
    // vendor-credited row already on the vendor brand
    expect(all(row("okta-login-secure.com"))).toMatchObject({ action: "keep", keptBecause: "still_matches" });
  });

  it("customer-tier links never fall back to the vendor or get cleared while a rule accepts them", () => {
    expect(all(on("contoso-okta.com", "b_cust", "Contoso", "contoso.com", "customer")))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
    // Old rules accepted Contoso via substring inside a glued word; the new
    // matcher falls back to Okta — customer link is kept.
    expect(all(on("mycontosoportal-okta.com", "b_cust", "Contoso", "contoso.com", "customer")))
      .toMatchObject({ action: "keep", keptBecause: "customer_tier" });
    // A host naming two brands: the current rules still accept Contoso → keep.
    expect(all(on("withpersona-contoso.okta-sso.com", "b_cust", "Contoso", "contoso.com", "customer")))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
    // …but when only the OLD rules accepted Contoso (substring inside a glued
    // word), a different specific brand wins.
    expect(all(on("mycontosoportal.withpersona-okta.com", "b_cust", "Contoso", "contoso.com", "customer")))
      .toMatchObject({ action: "relink", newBrandId: "b_persona" });
  });

  it("M1: a vendor-credited row gets the same answer as vendor scope", () => {
    for (const h of ["withpersona.okta-linksso.com", "okta-acme.com", "asana-okta.com"]) {
      const cat: BrandRow[] = [...CAT, { id: "b_asana", name: "Asana", canonical_domain: "asana.com", tier: "monitored" }];
      const r = (x: string[]) => fuzzyMatchBrandDetailed(x, cat);
      expect(decideReattribution(row(h), r, "all_idp"), h).toEqual(decideReattribution(row(h), r, "vendor"));
      expect(decideReattribution(row(h), r, "all_idp").action, h).toBe("relink");
    }
  });

  it("M2: a well-known tracked brand (rank) still counts as an accepted leftover target", () => {
    const cat: BrandRow[] = [...CAT, { id: "b_asana", name: "Asana", canonical_domain: "asana.com", tier: "tracked", tranco_rank: 3000 }];
    const r = (x: string[]) => fuzzyMatchBrandDetailed(x, cat);
    const asanaLink = on("contoso-asana.okta-sso.com", "b_asana", "Asana", "asana.com", "tracked");
    expect(decideReattribution({ ...asanaLink, brand_rank: 3000 }, r, "all_idp"))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
    // without the rank the guard could not accept Asana (the M2 bug)
    expect(decideReattribution({ ...asanaLink, brand_rank: null }, r, "all_idp").action).toBe("relink");
  });

  it("M3: all_idp protects every authoritative feed; vendor scope keeps its two", () => {
    const cat: BrandRow[] = [...CAT, { id: "b_box", name: "Box", canonical_domain: "box.com", tier: "monitored" }];
    const r = (x: string[]) => fuzzyMatchBrandDetailed(x, cat);
    for (const feed of ["ct_logs", "nrd_hagezi", "spam_trap", "abuse_mailbox", "typosquat_scanner"]) {
      expect(decideReattribution({ ...on("box-okta-sso.com", "b_box", "Box", "box.com"), source_feed: feed }, r, "all_idp"), feed)
        .toMatchObject({ action: "keep", keptBecause: "protected_feed" });
    }
    expect(decideReattribution(row("okta-acme.com", { source_feed: "ct_logs" }), r, "vendor").action).toBe("relink");
  });

  it("AI / page-context links and protected feeds are untouched", () => {
    expect(all(on("okta-login-secure.com", "b_viva", "Viva Wallet", "vivawallet.com")))
      .toMatchObject({ action: "keep", keptBecause: "not_lure_credit" });
    expect(all(row("okta-acme.com", { source_feed: "typosquat_scanner", target_brand_id: "b_edge", brand_name: "Edge" })))
      .toMatchObject({ action: "keep", keptBecause: "protected_feed" });
    expect(all(on("dns.partner.microsoftonline.cn", "brand_copilot_com", "Copilot", "copilot.com")))
      .toMatchObject({ action: "keep", keptBecause: "vendor_official_domain" });
  });

  it("vendor scope is unchanged by the new mode", () => {
    expect(decideReattribution(on("ms365-copilot.onmicrosoft.aviasg.co", "brand_copilot_com", "Copilot", "copilot.com"), rm))
      .toMatchObject({ action: "keep" });
  });
});

describe("general brand-link cleanup on free-builder hosts", () => {
  const CAT: BrandRow[] = [
    ...CATALOG,
    { id: "b_jimdofree", name: "Jimdofree", canonical_domain: "jimdofree.com", tier: "monitored" },
    { id: "b_chase", name: "Chase", canonical_domain: "chase.com", tier: "monitored" },
  ];
  const link = (domain: string, id: string, name: string, canonical: string): LinkRow => ({
    rid: 1, id: `t_${domain}`, malicious_domain: domain, malicious_url: null, ioc_value: null,
    target_brand_id: id, brand_match_method: "token", brand_name: name, brand_canonical: canonical,
    brand_tier: "monitored", source_feed: "phishtank",
  });
  const rm = (h: string[]) => fuzzyMatchBrandDetailed(h, CAT);

  it("relinks a builder credit to the subdomain's brand, or clears it", () => {
    expect(decideLink(link("chase-login.jimdofree.com", "b_jimdofree", "Jimdofree", "jimdofree.com"), rm))
      .toMatchObject({ action: "relink", newBrandId: "b_chase" });
    expect(decideLink(link("xk2-login.jimdofree.com", "b_jimdofree", "Jimdofree", "jimdofree.com"), rm))
      .toMatchObject({ action: "clear" });
    expect(decideLink(link("login-microsoftonnline.jimdofree.com", "b_jimdofree", "Jimdofree", "jimdofree.com"), rm))
      .toMatchObject({ action: "relink", newBrandId: "b_ms" });
  });

  it("keeps correct links on builder hosts and the builder's own site", () => {
    expect(decideLink(link("chase-login.jimdofree.com", "b_chase", "Chase", "chase.com"), rm).action).toBe("keep");
    expect(decideLink(link("jimdofree.com", "b_jimdofree", "Jimdofree", "jimdofree.com"), rm).action).toBe("keep");
  });
});

describe("handleIdpReattribution request guards", () => {
  const env = {} as Env;
  it("apply without the confirm token is a 400 (no DB access)", async () => {
    const res = await handleIdpReattribution(new URL("https://x/api/internal/backfills/idp-reattribution?apply=1"), env);
    expect(res.status).toBe(400);
  });
  it("default run_id differs per scope", () => {
    expect(IDP_REATTRIBUTION_DEFAULT_RUN_ID).toEqual({ vendor: "idp-reattribution", all_idp: "idp-reattribution-all" });
  });
  it("rejects an unknown scope", async () => {
    const res = await handleIdpReattribution(new URL("https://x/?scope=everything"), env);
    expect(res.status).toBe(400);
  });
  it("rejects a malformed run_id", async () => {
    const res = await handleIdpReattribution(new URL("https://x/?run_id=bad%20id"), env);
    expect(res.status).toBe(400);
  });
});

describe("runIdpReattribution — live cleanup-log rows are never overwritten", () => {
  function fakeEnv(rows: ReattributionRow[]) {
    const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
    const stmt = (sql: string) => {
      const s = {
        sql, args: [] as unknown[],
        bind(...a: unknown[]) { s.args = a; return s; },
        async all() {
          return { results: sql.includes("FROM brands") ? CATALOG : sql.includes("FROM threats t") ? rows : [] };
        },
        async run() { return { meta: { changes: 0 } }; },
      };
      return s;
    };
    const env = {
      DB: {
        prepare: stmt,
        async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
          batches.push(stmts);
          return stmts.map(() => ({ meta: { changes: 1 } }));
        },
      },
      AUDIT_DB: { prepare: stmt },
    } as unknown as Env;
    return { env, batches };
  }

  it("skips (and counts) a would-change row that already has a live log entry", async () => {
    const { env, batches } = fakeEnv([
      row("okta-acme.com", { rid: 1, id: "t1", logged: 1 }),
      row("withpersona.okta-linksso.com", { rid: 2, id: "t2", logged: 0 }),
    ]);
    const r = await runIdpReattribution(env, { apply: true, cursor: 0, limit: 500, runId: "idp-reattribution" });
    expect(r.skipped_logged).toBe(1);
    expect(r.relink).toBe(1);
    const written = batches.flat().filter((s) => s.sql.includes("UPDATE threats"));
    expect(written).toHaveLength(1);
    expect(written[0]!.args).toContain("t2");
    expect(written[0]!.sql).toMatch(/EXISTS \(SELECT 1 FROM brand_link_cleanup_log/);
  });

  it("scope=all_idp drops the vendor filter and stays far under the bind limit", async () => {
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    const stmt = (sql: string) => {
      const s = {
        sql, args: [] as unknown[],
        bind(...a: unknown[]) { s.args = a; seen.push(s); return s; },
        async all() {
          return { results: sql.includes("FROM brands") ? CATALOG : sql.includes("FROM threats t")
            ? [row("ms365-copilot.onmicrosoft.aviasg.co", {
                target_brand_id: "b_acme", brand_name: "Copilot", brand_canonical: "copilot.com" })]
            : [] };
        },
      };
      return s;
    };
    const env = { DB: { prepare: stmt } } as unknown as Env;
    const r = await runIdpReattribution(env, { apply: false, cursor: 0, limit: 500, runId: "x", scope: "all_idp" });
    const q = seen.find((x) => x.sql.includes("FROM threats t"))!;
    expect(q.sql).not.toMatch(/canonical_domain IN/);
    expect(q.args).toHaveLength(4);
    expect(r.scope).toBe("all_idp");
    expect(r.relink).toBe(1);
    expect(r.samples[0]).toMatchObject({ to: "b_ms", action: "relink" });
  });

  it("dry run reports skipped_logged without writing", async () => {
    const { env, batches } = fakeEnv([row("okta-acme.com", { logged: 1 })]);
    const r = await runIdpReattribution(env, { apply: false, cursor: 0, limit: 500, runId: "x" });
    expect(r.skipped_logged).toBe(1);
    expect(batches).toHaveLength(0);
  });
});
