/**
 * Perf guard for the generic-brand predicate (review N1, 2026-10-12): the
 * NRD feed runs BrandMatcher.collect over ~443K domains in one invocation.
 * Before the precomputed GenericBrandSet + early exits, 100k non-matching
 * domains with 20 generic brands took ~30–40 s (vs ~0.5 s on ce133a4); now
 * ~0.8 s. The bounds are generous for CI — they catch the regression class,
 * not single-digit drift.
 */
import { describe, it, expect } from "vitest";
import { buildBrandKeywords, BrandMatcher } from "../src/lib/nrd-brand-match";
import { fuzzyMatchBrandDetailed, platformSuffixList, platformSuffixForSlow, platformSuffixOf } from "../src/lib/brandDetect";

const GENERIC = [["Line", "line.me"], ["Live", "live.com"], ["Cloud", "cloud.microsoft"], ["Mail", "mail.ru"],
  ["Shop", "shop.app"], ["Site", "site.com"], ["Office", "office.com"], ["Free", "free.fr"], ["Login", "login.gov"],
  ["Gnu", "gnu.org"], ["Express", "express.co.uk"], ["Inbox", "inbox.lv"], ["One", "one.com"], ["Web", "web.de"],
  ["App", "app.com"], ["Secure", "secure.com"], ["Account", "account.com"], ["Bank", "bank.com"],
  ["Store", "store.com"], ["Online", "online.com"]];
const ROWS = [
  ...GENERIC.map(([name, d]) => ({ id: `g_${d}`, name: name!, canonical_domain: d! })),
  { id: "brand_microsoft_com", name: "Microsoft", canonical_domain: "microsoft.com" },
  { id: "b_paypal", name: "PayPal", canonical_domain: "paypal.com" },
];
const TLDS = ["com", "net", "org", "xyz", "ru", "fr", "de", "co.uk", "io", "top"];

function randomDomains(n: number): string[] {
  let s = 12345;
  const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Array.from({ length: n }, (_, i) => `${Math.floor(r() * 1e12).toString(36)}${i}.${TLDS[i % TLDS.length]}`);
}

describe("generic-brand predicate performance (review N1)", () => {
  it("NRD collect: 100k non-matching domains, 20 generic brands, well under 10 s (pre-fix: ~30 s)", () => {
    const domains = randomDomains(100_000);
    const matcher = new BrandMatcher(buildBrandKeywords(ROWS));
    const t = performance.now();
    const { rows } = matcher.collect(domains, new Set());
    const ms = performance.now() - t;
    expect(rows).toHaveLength(0);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);

  it("catalog matcher: 20k non-matching hosts with generic brands, well under 10 s (pre-fix: ~30 s)", () => {
    const catalog = ROWS.map((r) => ({ ...r, tier: "monitored" }));
    const hosts = randomDomains(20_000);
    const t = performance.now();
    for (const h of hosts) fuzzyMatchBrandDetailed([h], catalog);
    expect(performance.now() - t).toBeLessThan(10_000);
  }, 60_000);
});

describe("platformSuffixFor suffix walk == original first-match loop", () => {
  it("agrees on every listed suffix, its tenants and nested hosts", () => {
    const list = platformSuffixList();
    const hosts = new Set<string>();
    for (const p of list) {
      for (const h of [p, `x.${p}`, `a.b.${p}`, `acme.${p}`, `login.${p}`, `www.${p}`]) hosts.add(h);
    }
    for (const h of ["paypal-login.github.io", "acme.eu.auth0.com", "acme.auth0.com", "login.okta.com", "acme-sso.okta.com",
      "bucket.s3.amazonaws.com", "x.ipfs.dweb.link", "evil.com", "a.my.site.com",
      // PLATFORM_SUFFIX_PATTERNS hosts: both paths share the same pattern
      // fallback, so this only guards the list walk around them — the
      // pattern rules themselves are covered by brand-detect.test.ts.
      "b.s3.eu-west-1.amazonaws.com", "a.b.s3-website-us-west-1.amazonaws.com", "ec2-1-2-3-4.compute-1.amazonaws.com",
      "x.website-us-southeast-1.linodeobjects.com", "mail.ded7815.inmotionhosting.com", "vps1.inmotionhosting.com",
      "secure.inmotionhosting.com", "inmotionhosting.com"]) hosts.add(h);
    for (const h of hosts) expect(platformSuffixOf(h), h).toBe(platformSuffixForSlow(h));
  });
});
