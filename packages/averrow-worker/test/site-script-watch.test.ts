/**
 * Site Script Watch PR1 — pure diff logic, the threats IOC match and the
 * 0337 schema. The SQL tests run on a DB built by applying EVERY migration
 * (openMigratedDb), so the new tables, the threats columns and the indexes
 * the lookups rely on are the real ones.
 */

import { describe, it, expect } from "vitest";
import {
  INLINE_SCRIPT_HOST,
  SITE_SCRIPT_MATCH_CHUNK,
  SITE_SCRIPT_PATH_MAX,
  SCAN_SKIP_ACCEPT_AFTER,
  assessScanPlausibility,
  contentHashStem,
  diffContactedHosts,
  diffSiteScan,
  findingDedupeKey,
  inlineScriptPathNorm,
  ipLiteral,
  isBaselineScan,
  isExecutableScriptType,
  isFirstPartyHost,
  isStorageBucketTenant,
  isSharedScriptHost,
  isUrlOnlyIocHost,
  isWellKnownScriptCdn,
  looksContentHashed,
  matchHostsAgainstThreats,
  matchUrlsAgainstThreats,
  normaliseInlineScriptText,
  normaliseScriptUrl,
  threatLookupKeys,
  threatMatchSql,
  threatUrlLookupKeys,
  toAsciiHost,
  type InventoryRow,
  type SiteScriptFinding,
} from "../src/lib/site-script-watch";
import { findHostSuffix, isUnderSharedHosting } from "../src/lib/safeDomains";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SRI = "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC";

describe("findHostSuffix (shared label-suffix lookup)", () => {
  it("returns the most specific matching entry, or null", () => {
    const set = new Set(["example.com", "a.example.com"]);
    expect(findHostSuffix("x.a.example.com", set)).toBe("a.example.com");
    expect(findHostSuffix("b.example.com", set)).toBe("example.com");
    expect(findHostSuffix("EXAMPLE.com.", set)).toBe("example.com");
    expect(findHostSuffix("notexample.com", set)).toBeNull();
    expect(findHostSuffix("com", new Set(["com"]))).toBeNull(); // bare label never checked
    expect(findHostSuffix("maps.googleapis.com", new Map([["googleapis.com", 1]]))).toBe("googleapis.com");
  });

  it("backs isUnderSharedHosting and isWellKnownScriptCdn", () => {
    expect(isUnderSharedHosting("app.herokuapp.com")).toBe(true);
    expect(isUnderSharedHosting("herokuapp.com.evil.net")).toBe(false);
    expect(isWellKnownScriptCdn("cdn.jsdelivr.net")).toBe(true);
    expect(isWellKnownScriptCdn("jsdelivr.net.evil.io")).toBe(false);
  });
});

describe("normaliseScriptUrl", () => {
  it("lowercases the host, strips a trailing dot; port leaves the key but is reported", () => {
    expect(normaliseScriptUrl("https://CDN.Acme.COM.:8443/js/App.js")).toEqual({
      host: "cdn.acme.com",
      path_norm: "/js/App.js",
      url: "https://cdn.acme.com.:8443/js/App.js",
      scheme: "https",
      port: "8443",
    });
  });

  it("drops cache-buster params and the fragment from the key, keeps the full URL as evidence", () => {
    expect(normaliseScriptUrl("https://acme.com/app.js?v=123&t=9#frag")).toEqual({
      host: "acme.com",
      path_norm: "/app.js",
      url: "https://acme.com/app.js?v=123&t=9",
      scheme: "https",
      port: null,
    });
  });

  it("keeps `id` on every host and the per-host identity params, sorted", () => {
    expect(normaliseScriptUrl("https://www.googletagmanager.com/gtm.js?l=dataLayer&id=GTM-ABC&cb=1")?.path_norm).toBe(
      "/gtm.js?id=GTM-ABC",
    );
    expect(normaliseScriptUrl("https://www.googletagmanager.com/gtag/js?id=G-XYZ")?.path_norm).toBe("/gtag/js?id=G-XYZ");
    expect(normaliseScriptUrl("https://widgets.vendor.io/w.js?id=42&ts=1")?.path_norm).toBe("/w.js?id=42");
    expect(
      normaliseScriptUrl("https://maps.googleapis.com/maps/api/js?libraries=places&callback=init&key=AIzaK&v=weekly")?.path_norm,
    ).toBe("/maps/api/js?key=AIzaK&libraries=places&v=weekly");
    expect(normaliseScriptUrl("https://www.paypal.com/sdk/js?currency=USD&client-id=ATTACKER")?.path_norm).toBe(
      "/sdk/js?client-id=ATTACKER",
    );
    // Same identity, params in another order → same key.
    expect(normaliseScriptUrl("https://maps.googleapis.com/maps/api/js?v=weekly&key=AIzaK&libraries=places")?.path_norm).toBe(
      "/maps/api/js?key=AIzaK&libraries=places&v=weekly",
    );
    // A per-host param on another host is a cache-buster.
    expect(normaliseScriptUrl("https://acme.com/app.js?key=abc&libraries=x")?.path_norm).toBe("/app.js");
  });

  it("resolves relative and protocol-relative srcs against the page URL", () => {
    expect(normaliseScriptUrl("/static/main.js?x=1", "https://www.acme.com/shop")).toMatchObject({
      host: "www.acme.com",
      path_norm: "/static/main.js",
      url: "https://www.acme.com/static/main.js?x=1",
    });
    expect(normaliseScriptUrl("//cdn.jsdelivr.net/npm/x.js", "https://acme.com/")).toMatchObject({
      host: "cdn.jsdelivr.net",
      path_norm: "/npm/x.js",
    });
  });

  it("returns punycode hosts", () => {
    expect(normaliseScriptUrl("https://bücher.de/x.js")?.host).toBe("xn--bcher-kva.de");
  });

  it("rejects non-http(s) and unparseable input", () => {
    for (const bad of [
      "data:text/javascript,alert(1)",
      "javascript:alert(1)",
      "blob:https://acme.com/uuid",
      "ftp://acme.com/x.js",
      "not a url",
      "",
      "   ",
    ]) {
      expect(normaliseScriptUrl(bad), bad).toBeNull();
    }
    expect(normaliseScriptUrl("/app.js")).toBeNull();
  });

  it("truncates very long keys", () => {
    const n = normaliseScriptUrl(`https://acme.com/${"x".repeat(5000)}.js`);
    expect(n?.path_norm.length).toBe(SITE_SCRIPT_PATH_MAX);
  });
});

describe("host helpers", () => {
  it("toAsciiHost converts IDNs to punycode and leaves ASCII alone", () => {
    expect(toAsciiHost("Bücher.DE.")).toBe("xn--bcher-kva.de");
    expect(toAsciiHost("acme.com")).toBe("acme.com");
  });

  it("ipLiteral recognises IPv4 and bracketed IPv6 hosts only", () => {
    expect(ipLiteral("203.0.113.7")).toBe("203.0.113.7");
    expect(ipLiteral("[2001:db8::1]")).toBe("2001:db8::1");
    expect(ipLiteral("acme.com")).toBeNull();
    expect(ipLiteral("1.2.3")).toBeNull();
  });
});

describe("isFirstPartyHost", () => {
  it("matches the canonical domain and its subdomains", () => {
    expect(isFirstPartyHost("acme.com", "acme.com")).toBe(true);
    expect(isFirstPartyHost("static.cdn.acme.com", "acme.com")).toBe(true);
    expect(isFirstPartyHost("ACME.com.", "acme.com")).toBe(true);
  });

  it("ignores a leading www. on the canonical domain", () => {
    expect(isFirstPartyHost("cdn.acme.com", "www.acme.com")).toBe(true);
  });

  it("compares an IDN canonical domain in punycode", () => {
    expect(isFirstPartyHost("cdn.xn--bcher-kva.de", "bücher.de")).toBe(true);
    expect(isFirstPartyHost("xn--bcher-kva.de", "www.Bücher.de")).toBe(true);
    expect(isFirstPartyHost("xn--bchr-kva.de", "bücher.de")).toBe(false);
  });

  it("does not match lookalikes or suffix collisions", () => {
    expect(isFirstPartyHost("notacme.com", "acme.com")).toBe(false);
    expect(isFirstPartyHost("acme.com.evil.net", "acme.com")).toBe(false);
    expect(isFirstPartyHost("acme-cdn.com", "acme.com")).toBe(false);
  });

  it("only matches exactly when the canonical domain is shared hosting", () => {
    expect(isFirstPartyHost("acme.myshopify.com", "acme.myshopify.com")).toBe(true);
    expect(isFirstPartyHost("evil.acme.github.io", "acme.github.io")).toBe(false);
    expect(isFirstPartyHost("someshop.myshopify.com", "myshopify.com")).toBe(false);
  });
});

describe("looksContentHashed", () => {
  it.each([
    "/assets/app.3f9a2c1b.js",
    "/assets/index-C5K0wNNo.js",
    "/assets/index-B-x_9aQz.js",
    "/static/js/main.0123abcd4567ef89.chunk.js",
    "/_next/static/chunks/pages/_app-0123abcd4567ef89.js",
    "/_next/static/Xk9_2bQzT1aPq7LmN0vW/_buildManifest.js",
    "/assets/index-BxQzkPaL.js", // digit-free mixed-case base64url, as a separator suffix
    "/build/a1b2c3d4e5f6/app.js",
    "/js/123456789.js", // numeric build id that is not date-like
  ])("hashed: %s", (p) => expect(looksContentHashed(p)).toBe(true));

  it.each([
    "/js/checkout.js",
    "/js/jquery-3.7.1.min.js",
    "/js/polyfills-es2015.js",
    "/js/2fa-handler.js",
    "/js/MainBundle.js",
    "/js/bootstrap4.js",
    "/js/chunk-vendors.js",
    "/gtm.js?id=GTM-ABCDEFGH1",
    // Whole-name digit-free mixed-case words, non-hex names with digits, dated dirs.
    "/js/CheckOut.js",
    "/js/PayPalSdk.js",
    "/js/sk1mmer2.js",
    "/js/20231105/checkout.js",
    "/build/20231105123456/app.js",
    "/js/1731800000/app.js",
    "/js/app-CheckOut.js", // camelCase words are not a hash even as a suffix
    "/js/app-20231105.js",
  ])("not hashed: %s", (p) => expect(looksContentHashed(p)).toBe(false));

  it("contentHashStem replaces only the hash, keeping names and identity params", () => {
    expect(contentHashStem("/assets/app.3f9a2c1b.js")).toBe("/assets/app.#.js");
    expect(contentHashStem("/assets/app.1a2b3c4d.js")).toBe("/assets/app.#.js");
    expect(contentHashStem("/assets/index-C5K0wNNo.js")).toBe("/assets/index-#.js");
    expect(contentHashStem("/assets/index-Abc12345.js")).toBe("/assets/index-#.js");
    expect(contentHashStem("/assets/index-B-x_9aQz.js")).toBe("/assets/index-#.js");
    expect(contentHashStem("/_next/static/chunks/pages/_app-0123abcd4567ef89.js")).toBe("/_next/static/chunks/pages/_app-#.js");
    expect(contentHashStem("/_next/static/Xk9_2bQzT1aPq7LmN0vW/_buildManifest.js")).toBe("/_next/static/#/_buildManifest.js");
    expect(contentHashStem("/js/checkout.js?id=x")).toBe("/js/checkout.js?id=x");
    expect(contentHashStem("/assets/vendor-C5K0wNNo.js")).not.toBe(contentHashStem("/assets/index-C5K0wNNo.js"));
  });
});

describe("diffSiteScan", () => {
  const opts = { canonicalDomain: "acme.com", pageUrl: "https://www.acme.com/" };
  const inventory: InventoryRow[] = [
    { script_host: "www.acme.com", path_norm: "/app.js", last_sha256: SHA_A },
    { script_host: "widgets.vendor.io", path_norm: "/w.js", last_sha256: SHA_A, integrity: SRI },
    { script_host: "cdn.jsdelivr.net", path_norm: "/npm/lib@1.0.0/lib.js", last_sha256: SHA_A },
  ];

  it("baseline scan inventories everything and produces no findings", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js?v=1", sha256: SHA_A },
        { url: "https://widgets.vendor.io/w.js", sha256: SHA_A, integrity: SRI },
        { url: "https://evil-skimmer.ru/s.js", sha256: SHA_B },
        { url: "https://cdn.jsdelivr.net/npm/lib.js", sha256: SHA_A },
        { url: "https://shop-x.herokuapp.com/s.js", sha256: SHA_A },
        { inline: true, sha256: SHA_C.toUpperCase() },
        { url: "data:text/javascript,1", sha256: null },
        { inline: true, sha256: null },
      ],
      [],
      { ...opts, baseline: true },
    );
    expect(d.baseline).toBe(true);
    expect(d.findings).toEqual([]);
    expect(d.rejected).toBe(2);
    expect(d.observed.map((o) => [o.host, o.path_norm, o.is_first_party, o.is_inline, o.cdn, o.shared_hosting])).toEqual([
      ["www.acme.com", "/app.js", true, false, false, false],
      ["widgets.vendor.io", "/w.js", false, false, false, false],
      ["evil-skimmer.ru", "/s.js", false, false, false, false],
      ["cdn.jsdelivr.net", "/npm/lib.js", false, false, true, false],
      ["shop-x.herokuapp.com", "/s.js", false, false, false, true],
      [INLINE_SCRIPT_HOST, `sha256:${SHA_C}`, true, true, false, false],
    ]);
    expect(d.observed[1]!.integrity).toBe(SRI);
    expect(d.observed[0]!.integrity).toBeUndefined(); // not captured
  });

  it("baseline is the caller's decision: default FALSE compares even against an empty inventory", () => {
    const d = diffSiteScan([{ url: "https://evil-skimmer.ru/s.js", sha256: SHA_B }], [], opts);
    expect(d.baseline).toBe(false);
    expect(d.findings.map((f) => f.kind)).toEqual(["new_host"]);
    // explicit baseline wins over a non-empty inventory
    expect(diffSiteScan([{ url: "https://evil-skimmer.ru/s.js", sha256: SHA_B }], inventory, { ...opts, baseline: true }).findings).toEqual(
      [],
    );
  });

  it("raises new_host once per never-seen external host, with resolved URL and page_url", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js", sha256: SHA_A },
        { url: "https://evil-skimmer.ru/s.js?cb=1#x", sha256: SHA_B, page_url: "https://www.acme.com/checkout" },
        { url: "https://evil-skimmer.ru/t.js", sha256: SHA_B },
      ],
      inventory,
      opts,
    );
    expect(d.findings).toEqual<SiteScriptFinding[]>([
      {
        kind: "new_host",
        host: "evil-skimmer.ru",
        path_norm: "/s.js",
        page_url: "https://www.acme.com/checkout",
        threat_id: null,
        evidence: { url: "https://evil-skimmer.ru/s.js?cb=1", sha256: SHA_B },
      },
    ]);
  });

  it("resolves a relative src against the script's own page and attributes the finding to it", () => {
    const d = diffSiteScan(
      [{ url: "pay/skim.js", sha256: SHA_B, page_url: "https://www.acme.com/checkout/" }],
      inventory,
      opts,
    );
    expect(d.findings).toEqual([
      expect.objectContaining({
        kind: "new_script",
        host: "www.acme.com",
        path_norm: "/checkout/pay/skim.js",
        page_url: "https://www.acme.com/checkout/",
        evidence: { url: "https://www.acme.com/checkout/pay/skim.js", sha256: SHA_B },
      }),
    ]);
  });

  it("records scheme / port / mixed content for non-default locations", () => {
    const d = diffSiteScan(
      [
        { url: "http://evil-skimmer.ru/s.js", sha256: null },
        { url: "https://other-evil.net:8443/s.js", sha256: null },
      ],
      inventory,
      opts,
    );
    expect(d.findings.map((f) => f.evidence)).toEqual([
      { url: "http://evil-skimmer.ru/s.js", sha256: null, scheme: "http", mixed_content: true },
      { url: "https://other-evil.net:8443/s.js", sha256: null, port: "8443" },
    ]);
  });

  it("only public script CDNs are exempt from new_host — shared-hosting tenants raise it; CDN scripts still raise new_script", () => {
    const d = diffSiteScan(
      [
        { url: "https://cdn.jsdelivr.net/npm/other.js", sha256: SHA_A }, // known CDN host, new path → new_script
        { url: "https://cdnjs.cloudflare.com/ajax/libs/x.js", sha256: SHA_A },
        { url: "https://unpkg.com/x.js", sha256: SHA_A },
        { url: "https://shop-x.herokuapp.com/s.js", sha256: SHA_A },
        { url: "https://d111111abcdef8.cloudfront.net/x.js", sha256: SHA_A },
        { url: "https://evil-bucket.s3.amazonaws.com/x.js", sha256: SHA_A },
        { url: "https://skim.someone.workers.dev/x.js", sha256: SHA_A },
        { url: "https://skim.pages.dev/x.js", sha256: SHA_A },
        { url: "https://abcd-1-2-3-4.ngrok-free.app/x.js", sha256: SHA_A },
        { url: "https://raw.githubusercontent.com/u/r/main/x.js", sha256: SHA_A },
      ],
      inventory,
      opts,
    );
    expect(d.findings.map((f) => [f.kind, f.host])).toEqual([
      ["new_script", "cdn.jsdelivr.net"],
      ["new_script", "cdnjs.cloudflare.com"], // never-seen CDN: no new_host, but the script is new
      ["new_script", "unpkg.com"],
      ["new_host", "shop-x.herokuapp.com"],
      ["new_host", "d111111abcdef8.cloudfront.net"],
      ["new_host", "evil-bucket.s3.amazonaws.com"],
      ["new_host", "skim.someone.workers.dev"],
      ["new_host", "skim.pages.dev"],
      ["new_host", "abcd-1-2-3-4.ngrok-free.app"],
      ["new_host", "raw.githubusercontent.com"],
    ]);
  });

  it("new_script: always on known third-party hosts; a hashed first-party file with no predecessor is new", () => {
    const d = diffSiteScan(
      [
        { url: "https://widgets.vendor.io/other.js", sha256: SHA_B },
        { url: "https://widgets.vendor.io/bundle.3f9a2c1b.js", sha256: SHA_B },
        { url: "/assets/app.3f9a2c1b.js", sha256: SHA_B }, // hashed, but nothing it replaces
        { url: "/js/jquery-migrate.min.js", sha256: SHA_B },
        { url: "https://static.acme.com/new.js", sha256: SHA_A }, // new first-party HOST: silent
      ],
      inventory,
      opts,
    );
    expect(d.findings.map((f) => [f.kind, f.host, f.path_norm])).toEqual([
      ["new_script", "widgets.vendor.io", "/other.js"],
      ["new_script", "widgets.vendor.io", "/bundle.3f9a2c1b.js"],
      ["new_script", "www.acme.com", "/assets/app.3f9a2c1b.js"],
      ["new_script", "www.acme.com", "/js/jquery-migrate.min.js"],
    ]);
  });

  it("first-party hashed build files are skipped only when they replace a disappeared file of the same stem", () => {
    const inv: InventoryRow[] = [
      { script_host: "www.acme.com", path_norm: "/assets/app.1a2b3c4d.js", last_sha256: SHA_A },
      { script_host: "www.acme.com", path_norm: "/assets/index-Abc12345.js", last_sha256: SHA_A },
      { script_host: "www.acme.com", path_norm: "/assets/vendor.9f8e7d6c.js", last_sha256: SHA_A },
    ];
    // A deploy: every hashed file replaced by its new build.
    const deploy = diffSiteScan(
      [
        { url: "/assets/app.3f9a2c1b.js", sha256: SHA_B },
        { url: "/assets/index-C5K0wNNo.js", sha256: SHA_B },
        { url: "/assets/vendor.0a1b2c3d.js", sha256: SHA_B },
      ],
      inv,
      opts,
    );
    expect(deploy.findings).toEqual([]);

    // The predecessor is still loaded: the hashed newcomer is an addition, not a replacement.
    const added = diffSiteScan(
      [
        { url: "/assets/app.1a2b3c4d.js", sha256: SHA_A },
        { url: "/assets/app.3f9a2c1b.js", sha256: SHA_B },
        { url: "/assets/index-Abc12345.js", sha256: SHA_A },
        { url: "/assets/vendor.9f8e7d6c.js", sha256: SHA_A },
      ],
      inv,
      opts,
    );
    expect(added.findings.map((f) => [f.kind, f.path_norm])).toEqual([["new_script", "/assets/app.3f9a2c1b.js"]]);

    // One disappeared predecessor covers ONE new build file; a second of the same stem is new.
    const two = diffSiteScan(
      [
        { url: "/assets/app.3f9a2c1b.js", sha256: SHA_B },
        { url: "/assets/app.5e6f7a8b.js", sha256: SHA_C },
        { url: "/assets/index-Abc12345.js", sha256: SHA_A },
        { url: "/assets/vendor.9f8e7d6c.js", sha256: SHA_A },
      ],
      inv,
      opts,
    );
    expect(two.findings.map((f) => [f.kind, f.path_norm])).toEqual([["new_script", "/assets/app.5e6f7a8b.js"]]);

    // A different stem (or another host) never counts as the replacement.
    const otherStem = diffSiteScan(
      [
        { url: "/assets/skim.3f9a2c1b.js", sha256: SHA_B },
        { url: "https://static.acme.com/assets/app.3f9a2c1b.js", sha256: SHA_B },
      ],
      [...inv, { script_host: "static.acme.com", path_norm: "/x.js", last_sha256: SHA_A }],
      opts,
    );
    expect(otherStem.findings.map((f) => [f.kind, f.host, f.path_norm])).toEqual([
      ["new_script", "www.acme.com", "/assets/skim.3f9a2c1b.js"],
      ["new_script", "static.acme.com", "/assets/app.3f9a2c1b.js"],
    ]);

    // The former false positives are not hashed at all: always new_script.
    const fp = diffSiteScan(
      ["/js/CheckOut.js", "/js/PayPalSdk.js", "/js/sk1mmer2.js", "/js/20231105/checkout.js"].map((url) => ({ url, sha256: SHA_B })),
      [...inv, { script_host: "www.acme.com", path_norm: "/js/checkout.js", last_sha256: SHA_A }],
      opts,
    );
    expect(fp.findings.map((f) => f.path_norm)).toEqual(["/js/CheckOut.js", "/js/PayPalSdk.js", "/js/sk1mmer2.js", "/js/20231105/checkout.js"]);
  });

  it("a never-seen CDN suppresses new_host but every script on it is new_script (jsDelivr /gh/, unpkg, esm.sh)", () => {
    const d = diffSiteScan(
      [
        { url: "https://cdn.jsdelivr.net/gh/attacker/repo@main/skim.js", sha256: SHA_B },
        { url: "https://esm.sh/evil-pkg@1.0.0", sha256: SHA_B },
        { url: "https://unpkg.com/evil-pkg@1.0.0/index.js", sha256: SHA_B },
        { url: "https://unpkg.com/evil-pkg@1.0.0/index.js?v=2", sha256: SHA_B }, // duplicate
      ],
      [],
      opts,
    );
    expect(d.findings.map((f) => [f.kind, f.host, f.path_norm])).toEqual([
      ["new_script", "cdn.jsdelivr.net", "/gh/attacker/repo@main/skim.js"],
      ["new_script", "esm.sh", "/evil-pkg@1.0.0"],
      ["new_script", "unpkg.com", "/evil-pkg@1.0.0/index.js"],
    ]);
  });

  it("a changed identity param is a new script; a changed cache-buster is not", () => {
    const inv: InventoryRow[] = [
      { script_host: "www.paypal.com", path_norm: "/sdk/js?client-id=MERCHANT", last_sha256: SHA_A },
    ];
    expect(
      diffSiteScan([{ url: "https://www.paypal.com/sdk/js?client-id=MERCHANT&currency=EUR&cb=9", sha256: SHA_A }], inv, opts)
        .findings,
    ).toEqual([]);
    expect(
      diffSiteScan([{ url: "https://www.paypal.com/sdk/js?client-id=ATTACKER", sha256: SHA_A }], inv, opts).findings.map(
        (f) => [f.kind, f.path_norm],
      ),
    ).toEqual([["new_script", "/sdk/js?client-id=ATTACKER"]]);
  });

  it("raises body_changed for the same host + path with a different hash (first- and third-party)", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js?v=2", sha256: SHA_B },
        { url: "https://widgets.vendor.io/w.js", sha256: SHA_B },
      ],
      inventory,
      opts,
    );
    expect(d.findings.map((f) => [f.kind, f.host, f.path_norm, f.evidence.prev_sha256, f.evidence.sha256])).toEqual([
      ["body_changed", "www.acme.com", "/app.js", SHA_A, SHA_B],
      ["body_changed", "widgets.vendor.io", "/w.js", SHA_A, SHA_B],
    ]);
  });

  it("does not raise body_changed when either hash is unknown or the hash is unchanged", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js", sha256: SHA_A },
        { url: "https://widgets.vendor.io/w.js", sha256: null },
      ],
      inventory,
      opts,
    );
    expect(d.findings).toEqual([]);
    const unknownPrev = diffSiteScan(
      [{ url: "/app.js", sha256: SHA_B }],
      [{ script_host: "www.acme.com", path_norm: "/app.js", last_sha256: null }],
      opts,
    );
    expect(unknownPrev.findings).toEqual([]);
  });

  it("CDN scripts still raise body_changed once inventoried", () => {
    const d = diffSiteScan([{ url: "https://cdn.jsdelivr.net/npm/lib@1.0.0/lib.js", sha256: SHA_B }], inventory, opts);
    expect(d.findings.map((f) => f.kind)).toEqual(["body_changed"]);
  });

  it("sri_removed when a script that carried integrity loses it — only when the attribute was captured", () => {
    const removed = diffSiteScan([{ url: "https://widgets.vendor.io/w.js", sha256: SHA_A, integrity: null }], inventory, opts);
    expect(removed.findings).toEqual([
      expect.objectContaining({
        kind: "sri_removed",
        host: "widgets.vendor.io",
        path_norm: "/w.js",
        evidence: expect.objectContaining({ integrity: null, prev_integrity: SRI }),
      }),
    ]);
    expect(diffSiteScan([{ url: "https://widgets.vendor.io/w.js", sha256: SHA_A, integrity: "" }], inventory, opts).findings).toHaveLength(1);
    // Not captured, still present, or never had one → nothing.
    expect(diffSiteScan([{ url: "https://widgets.vendor.io/w.js", sha256: SHA_A }], inventory, opts).findings).toEqual([]);
    expect(diffSiteScan([{ url: "https://widgets.vendor.io/w.js", sha256: SHA_A, integrity: SRI }], inventory, opts).findings).toEqual([]);
    expect(diffSiteScan([{ url: "/app.js", sha256: SHA_A, integrity: null }], inventory, opts).findings).toEqual([]);
    // Both at once: body changed AND SRI dropped (the polyfill.io pattern).
    expect(
      diffSiteScan([{ url: "https://widgets.vendor.io/w.js", sha256: SHA_B, integrity: null }], inventory, opts).findings.map((f) => f.kind),
    ).toEqual(["body_changed", "sri_removed"]);
  });

  it("inline scripts: silent until inline rows are inventoried, then a new hash is new_script", () => {
    const inline = [{ inline: true, sha256: SHA_B, page_url: "https://www.acme.com/checkout" }];
    expect(diffSiteScan(inline, inventory, opts).findings).toEqual([]);
    const withInline: InventoryRow[] = [...inventory, { script_host: INLINE_SCRIPT_HOST, path_norm: inlineScriptPathNorm(SHA_A), last_sha256: SHA_A }];
    expect(diffSiteScan([{ inline: true, sha256: SHA_A }], withInline, opts).findings).toEqual([]);
    expect(diffSiteScan(inline, withInline, opts).findings).toEqual([
      {
        kind: "new_script",
        host: INLINE_SCRIPT_HOST,
        path_norm: `sha256:${SHA_B}`,
        page_url: "https://www.acme.com/checkout",
        threat_id: null,
        evidence: { url: null, sha256: SHA_B },
      },
    ]);
  });

  it("drops inline data blocks (non-executable type) and keeps executable inline scripts", () => {
    const withInline: InventoryRow[] = [...inventory, { script_host: INLINE_SCRIPT_HOST, path_norm: inlineScriptPathNorm(SHA_A), last_sha256: SHA_A }];
    const d = diffSiteScan(
      [
        { inline: true, sha256: SHA_B, type: "application/json" }, // __NEXT_DATA__
        { inline: true, sha256: SHA_B, type: "application/ld+json" },
        { inline: true, sha256: SHA_B, type: "importmap" },
        { inline: true, sha256: SHA_C, type: "module" },
      ],
      withInline,
      opts,
    );
    expect(d.data_blocks).toBe(3);
    expect(d.rejected).toBe(0);
    expect(d.findings.map((f) => [f.kind, f.path_norm])).toEqual([["new_script", `sha256:${SHA_C}`]]);
  });

  it("de-duplicates cache-buster variants of the same script, keeping the first known hash / integrity", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js?v=1", sha256: null },
        { url: "/app.js?v=2", sha256: SHA_A, integrity: SRI },
        { url: "/app.js?v=3", sha256: SHA_B, integrity: null },
      ],
      [],
      { ...opts, baseline: true },
    );
    expect(d.observed).toHaveLength(1);
    expect(d.observed[0]!.sha256).toBe(SHA_A);
    expect(d.observed[0]!.integrity).toBe(SRI);
    expect(d.observed[0]!.url).toBe("https://www.acme.com/app.js?v=1");
  });
});

describe("normaliseInlineScriptText", () => {
  it("collapses whitespace and masks per-request tokens and timestamps", () => {
    const a = normaliseInlineScriptText(`  var csrf = "${"f".repeat(40)}";\n\n  var t = 1731800000123;  `);
    const b = normaliseInlineScriptText(`var csrf = "${"0".repeat(20)}${"e".repeat(20)}"; var t = 1731811111999;`);
    expect(a).toBe('var csrf = "#"; var t = 0;');
    expect(b).toBe(a);
    expect(normaliseInlineScriptText("fetch('https://evil.example/c')")).not.toBe(normaliseInlineScriptText("fetch('https://shop.example/c')"));
  });

  it("masks UUIDs, ISO-8601 timestamps and long mixed-case tokens", () => {
    const a = normaliseInlineScriptText(
      'window.cfg = {req: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", at: "2026-11-16T12:34:56.789Z", csrf: "aZ3kP9qLm2Xv7Rt1Yb5Nc8Wd"};',
    );
    const b = normaliseInlineScriptText(
      'window.cfg = {req: "9B2E61A4-1C2D-4E5F-8A9B-0C1D2E3F4A5B", at: "2026-11-17T01:02:03+02:00", csrf: "Qw8Er4Ty6Ui2Op0As3Df5Gh7Jk9"};',
    );
    expect(a).toBe('window.cfg = {req: "#", at: "T0", csrf: "#"};');
    expect(b).toBe(a);
    // Long camelCase identifiers (no digits) are code, not tokens.
    expect(normaliseInlineScriptText("handleCheckoutSubmitButtonClick()")).toBe("handleCheckoutSubmitButtonClick()");
  });

  it("does NOT mask wallet addresses: a swapped recipient changes the normalised text", () => {
    const eth = (addr: string): string => normaliseInlineScriptText(`sendTo("${addr}")`);
    const legit = eth("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(legit).toBe('sendTo("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")');
    expect(eth("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359")).not.toBe(legit);
    expect(eth("0x" + "a".repeat(40))).not.toBe(eth("0x" + "b".repeat(40)));
    expect(eth("0x1234567890123456789012345678901234567890")).not.toBe(eth("0x1234567890123456789012345678901234567891"));
    const btc = (addr: string): string => normaliseInlineScriptText(`pay("${addr}")`);
    expect(btc("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe('pay("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")');
    expect(btc("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).not.toBe(btc("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"));
  });

  it("isExecutableScriptType: only code types, never data blocks", () => {
    for (const t of [undefined, null, "", " ", "module", "text/javascript", "TEXT/JavaScript", "application/javascript", "application/ecmascript", "text/jscript"]) {
      expect(isExecutableScriptType(t), String(t)).toBe(true);
    }
    for (const t of ["application/json", "application/ld+json", "importmap", "speculationrules", "text/template", "text/x-handlebars-template", "text/javascript; charset=utf-8"]) {
      expect(isExecutableScriptType(t), t).toBe(false);
    }
  });

  it("inlineScriptPathNorm prefixes the lowercase hash", () => {
    expect(inlineScriptPathNorm(` ${SHA_A.toUpperCase()} `)).toBe(`sha256:${SHA_A}`);
  });
});

describe("diffContactedHosts", () => {
  const opts = { canonicalDomain: "acme.com", pageUrl: "https://www.acme.com/checkout" };

  it("one row per host with request count and the first named initiator", () => {
    const d = diffContactedHosts(
      [
        { url: "https://collect.evil.net/a?cc=1" },
        { url: "https://collect.evil.net/b", initiator_url: "/js/jquery-migrate.min.js?v=3" },
        { url: "https://collect.evil.net/c", initiator_url: "https://other.example/x.js" },
        { url: "wss://ws.evil.net/socket" },
        { url: "/api/cart" },
        { url: "data:image/png;base64,AAAA" },
        { url: "chrome-extension://abc/x.js" },
      ],
      [],
      { ...opts, baseline: true },
    );
    expect(d.baseline).toBe(true);
    expect(d.findings).toEqual([]);
    expect(d.rejected).toBe(2);
    expect(d.observed.map((o) => [o.host, o.request_count, o.initiator_host, o.initiator_path, o.is_first_party])).toEqual([
      ["collect.evil.net", 3, "www.acme.com", "/js/jquery-migrate.min.js", false],
      ["ws.evil.net", 1, null, null, false],
      ["www.acme.com", 1, null, null, true],
    ]);
  });

  it("raises new_contacted_host for unknown hosts; first-party and CDNs exempt, shared-hosting tenants not", () => {
    const d = diffContactedHosts(
      [
        { url: "https://collect.evil.net/a", initiator_url: "https://widgets.vendor.io/w.js" },
        { url: "https://known.analytics.io/p" },
        { url: "https://api.acme.com/cart" },
        { url: "https://cdn.jsdelivr.net/npm/x.js" },
        { url: "https://exfil-x.herokuapp.com/c", page_url: "https://www.acme.com/pay" },
        { url: "http://plain.evil.org:8080/c" },
      ],
      ["KNOWN.analytics.io"],
      opts,
    );
    expect(d.findings).toEqual<SiteScriptFinding[]>([
      {
        kind: "new_contacted_host",
        host: "collect.evil.net",
        path_norm: null,
        page_url: "https://www.acme.com/checkout",
        threat_id: null,
        evidence: { url: "https://collect.evil.net/a", initiator_url: "https://widgets.vendor.io/w.js" },
      },
      {
        kind: "new_contacted_host",
        host: "exfil-x.herokuapp.com",
        path_norm: null,
        page_url: "https://www.acme.com/pay",
        threat_id: null,
        evidence: { url: "https://exfil-x.herokuapp.com/c", initiator_url: null },
      },
      {
        kind: "new_contacted_host",
        host: "plain.evil.org",
        path_norm: null,
        page_url: "https://www.acme.com/checkout",
        threat_id: null,
        evidence: { url: "http://plain.evil.org:8080/c", initiator_url: null, scheme: "http", port: "8080", mixed_content: true },
      },
    ]);
  });
});

describe("scan bookkeeping", () => {
  it("isBaselineScan: only when no earlier scan completed", () => {
    expect(isBaselineScan(0)).toBe(true);
    expect(isBaselineScan(1)).toBe(false);
  });

  it("assessScanPlausibility flags implausibly small scans as skipped", () => {
    expect(assessScanPlausibility(0, 3)).toEqual({ status: "skipped", reason: "0 scripts; previous complete scan had 3" });
    expect(assessScanPlausibility(0, 2)).toEqual({ status: "complete", reason: null });
    expect(assessScanPlausibility(0, null)).toEqual({ status: "complete", reason: null });
    expect(assessScanPlausibility(2, 20).status).toBe("skipped");
    expect(assessScanPlausibility(3, 20).status).toBe("complete");
    expect(assessScanPlausibility(1, 9).status).toBe("complete");
  });

  it("accepts the scan after repeated skips so a real redesign is not skipped forever", () => {
    expect(assessScanPlausibility(0, 30, SCAN_SKIP_ACCEPT_AFTER - 1).status).toBe("skipped");
    expect(assessScanPlausibility(0, 30, SCAN_SKIP_ACCEPT_AFTER).status).toBe("complete");
  });
});

describe("findingDedupeKey", () => {
  const base: SiteScriptFinding = {
    kind: "new_host",
    host: "evil.ru",
    path_norm: "/s.js",
    page_url: "https://acme.com/",
    threat_id: null,
    evidence: { url: "https://evil.ru/s.js", sha256: SHA_A },
  };

  it("host-level kinds key on kind + host only (path, threat, page and evidence ignored)", () => {
    expect(findingDedupeKey(base)).toBe(JSON.stringify(["new_host", "evil.ru"]));
    expect(findingDedupeKey({ ...base, path_norm: "/t.js", page_url: "https://acme.com/checkout", evidence: { url: null, sha256: SHA_B } })).toBe(
      findingDedupeKey(base),
    );
    const ioc = { ...base, kind: "ioc_match" as const, threat_id: "t1", path_norm: null };
    expect(findingDedupeKey(ioc)).toBe(JSON.stringify(["ioc_match", "evil.ru"]));
    expect(findingDedupeKey({ ...ioc, threat_id: "t2", path_norm: "/s.js" })).toBe(findingDedupeKey(ioc));
    const nch = { ...base, kind: "new_contacted_host" as const, path_norm: null };
    expect(findingDedupeKey(nch)).toBe(JSON.stringify(["new_contacted_host", "evil.ru"]));
    expect(findingDedupeKey(ioc)).not.toBe(findingDedupeKey(base));
  });

  it("script-level kinds keep the path; body_changed also keys on the new hash", () => {
    const ns = { ...base, kind: "new_script" as const };
    expect(findingDedupeKey(ns)).toBe(JSON.stringify(["new_script", "evil.ru", "/s.js"]));
    expect(findingDedupeKey({ ...ns, path_norm: "/t.js" })).not.toBe(findingDedupeKey(ns));
    expect(findingDedupeKey({ ...ns, page_url: "https://acme.com/x" })).toBe(findingDedupeKey(ns));
    expect(findingDedupeKey({ ...base, kind: "sri_removed" as const })).toBe(JSON.stringify(["sri_removed", "evil.ru", "/s.js"]));
    const bc = { ...base, kind: "body_changed" as const };
    expect(findingDedupeKey(bc)).toBe(JSON.stringify(["body_changed", "evil.ru", "/s.js", SHA_A]));
    expect(findingDedupeKey(bc)).not.toBe(findingDedupeKey({ ...bc, evidence: { url: null, sha256: SHA_B } }));
  });
});

describe("threatLookupKeys / threatUrlLookupKeys", () => {
  it("expands a host to its parents down to the registrable domain", () => {
    expect(threatLookupKeys("a.b.evil.com")).toEqual(["a.b.evil.com", "b.evil.com", "evil.com"]);
    expect(threatLookupKeys("cdn.evil.co.uk")).toEqual(["cdn.evil.co.uk", "evil.co.uk"]);
    expect(threatLookupKeys("evil.com")).toEqual(["evil.com"]);
  });

  it("matches shared-hosting tenants exactly and never looks up the provider or a CDN", () => {
    expect(isSharedScriptHost("acme-pay.github.io")).toBe(true);
    expect(threatLookupKeys("acme-pay.github.io")).toEqual(["acme-pay.github.io"]);
    expect(threatLookupKeys("shop-x.herokuapp.com")).toEqual(["shop-x.herokuapp.com"]);
    expect(threatLookupKeys("cdn.jsdelivr.net")).toEqual([]);
    expect(threatLookupKeys("github.io")).toEqual([]);
  });

  it("public file hosts are URL-only: no host keys at all", () => {
    for (const h of [
      "raw.githubusercontent.com",
      "storage.googleapis.com",
      "cdn.discordapp.com",
      "drive.google.com",
      "bitbucket.org",
      "gitlab.com",
      "s3.amazonaws.com",
      "blob.core.windows.net",
      "firebasestorage.googleapis.com",
    ]) {
      expect(isUrlOnlyIocHost(h), h).toBe(true);
      expect(isStorageBucketTenant(h), h).toBe(false);
      expect(threatLookupKeys(h), h).toEqual([]);
    }
    expect(isUrlOnlyIocHost("githubusercontent.com.evil.io")).toBe(false);
  });

  it("storage-bucket subdomains are tenants: an exact-host key (never the parents), still URL-matched too", () => {
    for (const h of [
      "evil-bucket.s3.amazonaws.com",
      "acct.blob.core.windows.net",
      "bucket.storage.googleapis.com",
      "x.firebasestorage.googleapis.com",
      "a.b.s3.amazonaws.com",
    ]) {
      expect(isStorageBucketTenant(h), h).toBe(true);
      expect(isUrlOnlyIocHost(h), h).toBe(true);
      expect(threatLookupKeys(h), h).toEqual([h]);
    }
    expect(threatLookupKeys("EVIL-Bucket.S3.amazonaws.com.")).toEqual(["evil-bucket.s3.amazonaws.com"]);
    expect(isStorageBucketTenant("s3.amazonaws.com.evil.io")).toBe(false);
    expect(threatUrlLookupKeys("https://evil-bucket.s3.amazonaws.com/skim.js")).toEqual(["https://evil-bucket.s3.amazonaws.com/skim.js"]);
  });

  it("keeps an IP host as an exact key; converts IDNs", () => {
    expect(threatLookupKeys("203.0.113.7")).toEqual(["203.0.113.7"]);
    expect(threatLookupKeys("cdn.bücher.de")).toEqual(["cdn.xn--bcher-kva.de", "xn--bcher-kva.de"]);
  });

  it("URL keys: the URL, plus the URL without its query; fragment dropped", () => {
    expect(threatUrlLookupKeys("https://raw.githubusercontent.com/u/r/main/s.js?token=1#x")).toEqual([
      "https://raw.githubusercontent.com/u/r/main/s.js?token=1",
      "https://raw.githubusercontent.com/u/r/main/s.js",
    ]);
    expect(threatUrlLookupKeys("data:text/javascript,1")).toEqual([]);
  });
});

describe("threatMatchSql", () => {
  it("binds every value and filters active threats on the given column", () => {
    expect(threatMatchSql(3)).toBe(
      "SELECT malicious_domain AS matched_value, MIN(id) AS threat_id FROM threats " +
        "WHERE malicious_domain IN (?, ?, ?) AND +status = 'active' GROUP BY malicious_domain",
    );
    expect(threatMatchSql(1, "malicious_url")).toBe(
      "SELECT malicious_url AS matched_value, MIN(id) AS threat_id FROM threats " +
        "WHERE malicious_url IN (?) AND +status = 'active' GROUP BY malicious_url",
    );
  });
});

describe.skipIf(!hasSqlite())("migration 0337 + threat matching (all migrations applied)", () => {
  function seedThreat(
    raw: SqliteDb,
    id: string,
    cols: { malicious_domain?: string; malicious_url?: string; ip_address?: string; ioc_value?: string; status?: string },
  ): void {
    raw
      .prepare(
        "INSERT INTO threats (id, source_feed, threat_type, malicious_domain, malicious_url, ip_address, ioc_value, status) " +
          "VALUES (?, 'test', 'phishing', ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        cols.malicious_domain ?? null,
        cols.malicious_url ?? null,
        cols.ip_address ?? null,
        cols.ioc_value ?? null,
        cols.status ?? "active",
      );
  }

  function planOf(raw: SqliteDb, e: StatementLogEntry): string {
    return (raw.prepare(`EXPLAIN QUERY PLAN ${e.sql}`).all(...e.binds!) as Array<{ detail: string }>).map((r) => r.detail).join(" / ");
  }

  it("creates the four tables with the expected columns; kind is free text", () => {
    const raw = openMigratedDb();
    const cols = (t: string): string[] =>
      (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols("site_scans")).toEqual([
      "id", "brand_id", "url", "status", "scanned_at", "scripts_count", "hosts_count", "error", "capture_ref",
    ]);
    expect(cols("site_script_inventory")).toEqual([
      "brand_id", "script_host", "path_norm", "is_first_party", "is_inline", "first_seen", "last_seen", "first_page_url",
      "last_sha256", "prev_sha256", "integrity", "change_count",
    ]);
    expect(cols("site_contacted_hosts")).toEqual([
      "brand_id", "host", "first_seen", "last_seen", "request_count", "initiator_host", "initiator_path",
    ]);
    expect(cols("site_script_findings")).toEqual([
      "id", "brand_id", "scan_id", "kind", "host", "path_norm", "page_url", "threat_id", "dedupe_key", "evidence_json",
      "created_at", "status",
    ]);

    // No CHECK on kind: every documented kind (and a future one) inserts.
    const ins = raw.prepare("INSERT INTO site_script_findings (id, brand_id, scan_id, kind, host, dedupe_key) VALUES (?, 'b', 's', ?, 'h', ?)");
    for (const k of ["new_host", "new_script", "body_changed", "sri_removed", "new_contacted_host", "ioc_match", "future_kind"]) {
      ins.run(`f-${k}`, k, k);
    }
    expect((raw.prepare("SELECT status FROM site_script_findings WHERE id = 'f-ioc_match'").all() as Array<{ status: string }>)[0]!.status).toBe("open");

    // UNIQUE keys support ON CONFLICT upserts.
    const up = raw.prepare(
      "INSERT INTO site_script_inventory (brand_id, script_host, path_norm, last_sha256, integrity) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (brand_id, script_host, path_norm) DO UPDATE SET prev_sha256 = last_sha256, last_sha256 = excluded.last_sha256, " +
        "integrity = excluded.integrity, change_count = change_count + 1",
    );
    up.run("b", "acme.com", "/app.js", SHA_A, SRI);
    up.run("b", "acme.com", "/app.js", SHA_B, null);
    expect(raw.prepare("SELECT last_sha256, prev_sha256, integrity, change_count FROM site_script_inventory").all()).toEqual([
      { last_sha256: SHA_B, prev_sha256: SHA_A, integrity: null, change_count: 1 },
    ]);
    raw
      .prepare("INSERT INTO site_script_inventory (brand_id, script_host, path_norm, is_inline) VALUES ('b', ?, ?, 1)")
      .run(INLINE_SCRIPT_HOST, inlineScriptPathNorm(SHA_C));
    expect(() => raw.prepare("INSERT INTO site_script_inventory (brand_id, script_host, path_norm, is_inline) VALUES ('b','h','/p',2)").run()).toThrow(
      /CHECK/,
    );

    // Contacted hosts: the first initiator is kept.
    const hostUp = raw.prepare(
      "INSERT INTO site_contacted_hosts (brand_id, host, request_count, initiator_host, initiator_path) VALUES (?, ?, 1, ?, ?) " +
        "ON CONFLICT (brand_id, host) DO UPDATE SET request_count = request_count + 1, " +
        "initiator_host = COALESCE(initiator_host, excluded.initiator_host), initiator_path = COALESCE(initiator_path, excluded.initiator_path)",
    );
    hostUp.run("b", "x.com", "www.acme.com", "/a.js");
    hostUp.run("b", "x.com", "evil.ru", "/b.js");
    expect(raw.prepare("SELECT request_count, initiator_host, initiator_path FROM site_contacted_hosts").all()).toEqual([
      { request_count: 2, initiator_host: "www.acme.com", initiator_path: "/a.js" },
    ]);
  });

  it("has the retention and dedupe indexes", () => {
    const raw = openMigratedDb();
    const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_site_%'").all() as Array<{ name: string }>)
      .map((r) => r.name)
      .sort();
    expect(idx).toEqual([
      "idx_site_contacted_hosts_last_seen",
      "idx_site_scans_brand_scanned",
      "idx_site_scans_scanned",
      "idx_site_script_findings_brand_created",
      "idx_site_script_findings_created",
      "idx_site_script_findings_open",
      "idx_site_script_findings_open_dedupe",
      "idx_site_script_findings_scan",
      "idx_site_script_inventory_last_seen",
    ]);
    const plan = (sql: string, ...binds: string[]): string =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>).map((r) => r.detail).join(" / ");
    expect(plan("DELETE FROM site_scans WHERE scanned_at < ?", "2026-01-01")).toMatch(/idx_site_scans_scanned/);
    expect(plan("DELETE FROM site_script_findings WHERE created_at < ?", "2026-01-01")).toMatch(/idx_site_script_findings_created/);
    expect(plan("DELETE FROM site_contacted_hosts WHERE last_seen < ?", "2026-01-01")).toMatch(/idx_site_contacted_hosts_last_seen/);
    expect(plan("DELETE FROM site_script_inventory WHERE last_seen < ?", "2026-01-01")).toMatch(/idx_site_script_inventory_last_seen/);
  });

  it("dedupes OPEN findings per (brand, dedupe_key); a closed finding can reopen", () => {
    const raw = openMigratedDb();
    const f: SiteScriptFinding = {
      kind: "new_host",
      host: "evil.ru",
      path_norm: "/s.js",
      page_url: "https://acme.com/",
      threat_id: null,
      evidence: { url: "https://evil.ru/s.js", sha256: SHA_A },
    };
    const ins = raw.prepare(
      "INSERT INTO site_script_findings (id, brand_id, scan_id, kind, host, path_norm, page_url, threat_id, dedupe_key, evidence_json) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (brand_id, dedupe_key) WHERE status = 'open' DO NOTHING",
    );
    const write = (id: string, brand: string, x: SiteScriptFinding): void => {
      ins.run(id, brand, "scan", x.kind, x.host, x.path_norm, x.page_url, x.threat_id, findingDedupeKey(x), JSON.stringify(x.evidence));
    };
    write("f1", "b1", f);
    write("f2", "b1", { ...f, page_url: "https://acme.com/checkout" }); // same key → ignored
    write("f3", "b2", f); // other brand
    const count = (): number => (raw.prepare("SELECT COUNT(*) AS n FROM site_script_findings").all() as Array<{ n: number }>)[0]!.n;
    expect(count()).toBe(2);
    raw.prepare("UPDATE site_script_findings SET status = 'resolved' WHERE id = 'f1'").run();
    write("f4", "b1", f); // reopens
    expect(count()).toBe(3);
    // body_changed with a different new hash is a separate open finding.
    write("f5", "b1", { ...f, kind: "body_changed" });
    write("f6", "b1", { ...f, kind: "body_changed", evidence: { url: null, sha256: SHA_B } });
    expect(count()).toBe(5);
  });

  it("matches exact hosts and parent domains on malicious_domain, active only", async () => {
    const raw = openMigratedDb();
    seedThreat(raw, "t-exact", { malicious_domain: "skimmer.evil.com" });
    seedThreat(raw, "t-parent", { malicious_domain: "evil.com" });
    seedThreat(raw, "t-pay", { malicious_domain: "pay-cdn.net" });
    seedThreat(raw, "t-ioc-only", { ioc_value: "ioc-only.example" });
    seedThreat(raw, "t-down", { malicious_domain: "dead.example", status: "down" });
    seedThreat(raw, "t-cdn", { malicious_domain: "cdn.jsdelivr.net" });
    seedThreat(raw, "t-raw", { malicious_domain: "raw.githubusercontent.com" });
    seedThreat(raw, "t-blob", { malicious_domain: "acct.blob.core.windows.net" });
    seedThreat(raw, "t-z", { malicious_domain: "evil.com" });
    const log: StatementLogEntry[] = [];
    const db = d1FromSqlite(raw, { log });

    const matches = await matchHostsAgainstThreats(db, [
      "Skimmer.Evil.com.",
      "static.pay-cdn.net",
      "dead.example",
      "cdn.jsdelivr.net",
      "clean.example",
      "ioc-only.example",
      "raw.githubusercontent.com",
      "acct.blob.core.windows.net",
      INLINE_SCRIPT_HOST,
    ]);
    const view = matches.map((m) => [m.host, m.matched_value, m.match_kind, m.threat_id].join("|")).sort();
    expect(view).toEqual([
      "acct.blob.core.windows.net|acct.blob.core.windows.net|exact|t-blob", // storage-bucket tenant: exact
      "skimmer.evil.com|evil.com|parent|t-parent",
      "skimmer.evil.com|skimmer.evil.com|exact|t-exact",
      "static.pay-cdn.net|pay-cdn.net|parent|t-pay",
    ]);
    for (const e of log) {
      expect(e.error).toBeUndefined();
      expect(e.sql).not.toMatch(/evil|pay-cdn|example|blob/);
    }
  });

  it("matches IP-literal hosts on threats.ip_address, seeking an ip_address index", async () => {
    const raw = openMigratedDb();
    seedThreat(raw, "t-ip", { ip_address: "203.0.113.7" });
    seedThreat(raw, "t-ip6", { ip_address: "2001:db8::1" });
    seedThreat(raw, "t-ip-down", { ip_address: "198.51.100.9", status: "down" });
    const log: StatementLogEntry[] = [];
    const matches = await matchHostsAgainstThreats(d1FromSqlite(raw, { log }), ["203.0.113.7", "[2001:db8::1]", "198.51.100.9", "acme.com"]);
    expect(matches.filter((m) => m.match_kind === "ip").map((m) => [m.host, m.matched_value, m.threat_id]).sort()).toEqual([
      ["203.0.113.7", "203.0.113.7", "t-ip"],
      ["[2001:db8::1]", "2001:db8::1", "t-ip6"],
    ]);
    const ipStmt = log.find((e) => /ip_address IN/.test(e.sql));
    expect(ipStmt).toBeDefined();
    const plan = planOf(raw, ipStmt!);
    expect(plan).toMatch(/SEARCH threats USING (COVERING )?INDEX idx_threats_ip\w* \(ip_address=\?\)/);
    expect(plan).not.toMatch(/idx_threats_status|SCAN threats/);
  });

  it("matches script URLs on threats.malicious_url (file hosts), seeking idx_threats_malicious_url", async () => {
    const raw = openMigratedDb();
    seedThreat(raw, "t-url", { malicious_url: "https://raw.githubusercontent.com/bad/repo/main/skim.js" });
    seedThreat(raw, "t-url-q", { malicious_url: "https://storage.googleapis.com/b/x.js?alt=media" });
    seedThreat(raw, "t-url-down", { malicious_url: "https://cdn.discordapp.com/a/1/x.js", status: "down" });
    const log: StatementLogEntry[] = [];
    const matches = await matchUrlsAgainstThreats(d1FromSqlite(raw, { log }), [
      "https://raw.githubusercontent.com/bad/repo/main/skim.js?cb=17",
      "https://raw.githubusercontent.com/good/repo/main/lib.js",
      "https://storage.googleapis.com/b/x.js?alt=media#frag",
      "https://cdn.discordapp.com/a/1/x.js",
      "data:text/javascript,1",
    ]);
    expect(matches.map((m) => [m.host, m.match_kind, m.threat_id]).sort()).toEqual([
      ["raw.githubusercontent.com", "url", "t-url"],
      ["storage.googleapis.com", "url", "t-url-q"],
    ]);
    expect(log).toHaveLength(1);
    expect(log[0]!.sql).not.toMatch(/github|googleapis|discord/);
    const plan = planOf(raw, log[0]!);
    expect(plan).toMatch(/SEARCH threats USING (COVERING )?INDEX idx_threats_malicious_url \(/);
    expect(plan).not.toMatch(/idx_threats_status|SCAN threats/);
  });

  it("chunks lookup keys at ≤ 90 binds per statement and seeks idx_threats_domain", async () => {
    const raw = openMigratedDb();
    const hosts = Array.from({ length: 200 }, (_, i) => `h${i}.example.org`);
    seedThreat(raw, "t-150", { malicious_domain: "h150.example.org" });
    seedThreat(raw, "t-7", { malicious_domain: "h7.example.org" });
    const log: StatementLogEntry[] = [];
    const db = d1FromSqlite(raw, { log });

    const matches = await matchHostsAgainstThreats(db, hosts);
    expect(matches.map((m) => m.threat_id).sort()).toEqual(["t-150", "t-7"]);

    // 200 hosts + the shared parent example.org = 201 keys → 90 / 90 / 21.
    expect(log.map((e) => e.binds!.length)).toEqual([90, 90, 21]);
    for (const e of log) {
      expect(e.binds!.length).toBeLessThanOrEqual(SITE_SCRIPT_MATCH_CHUNK);
      const plan = planOf(raw, e);
      expect(plan).toMatch(/SEARCH threats USING (COVERING )?INDEX idx_threats_domain \(/);
      expect(plan).not.toMatch(/idx_threats_status|SCAN threats/);
    }
  });

  it("issues no query when there is nothing to look up", async () => {
    const raw = openMigratedDb();
    const log: StatementLogEntry[] = [];
    const db = d1FromSqlite(raw, { log });
    expect(await matchHostsAgainstThreats(db, ["cdn.jsdelivr.net", "", "github.io", "raw.githubusercontent.com", INLINE_SCRIPT_HOST])).toEqual([]);
    expect(await matchUrlsAgainstThreats(db, ["data:x", "not a url"])).toEqual([]);
    expect(log).toHaveLength(0);
  });
});
