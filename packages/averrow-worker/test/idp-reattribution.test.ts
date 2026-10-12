import { describe, it, expect } from "vitest";
import {
  decideReattribution,
  handleIdpReattribution,
  runIdpReattribution,
  type ReattributionRow,
} from "../src/handlers/admin/idpReattribution";
import { fuzzyMatchBrandDetailed, type BrandRow } from "../src/lib/brandDetect";
import type { Env } from "../src/types";

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

  it("Okta's own corp hosts are never re-attributed", () => {
    expect(decideReattribution(row("login.okta.com"), () => null))
      .toMatchObject({ action: "keep", keptBecause: "vendor_official_domain" });
    // …but a customer tenant still is.
    expect(decideReattribution(row("acme-sso.okta.com"), prodRematch).newBrandId).toBe("b_acme");
  });
});

describe("handleIdpReattribution request guards", () => {
  const env = {} as Env;
  it("apply without the confirm token is a 400 (no DB access)", async () => {
    const res = await handleIdpReattribution(new URL("https://x/api/internal/backfills/idp-reattribution?apply=1"), env);
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

  it("dry run reports skipped_logged without writing", async () => {
    const { env, batches } = fakeEnv([row("okta-acme.com", { logged: 1 })]);
    const r = await runIdpReattribution(env, { apply: false, cursor: 0, limit: 500, runId: "x" });
    expect(r.skipped_logged).toBe(1);
    expect(batches).toHaveLength(0);
  });
});
