/**
 * Generic-word brands ("Mail" mail.ru, "Site" site.com, "Login" login.gov)
 * across every writer that credits a brand by name/keyword (2026-10-12):
 * each one consults lib/brandDetect isGenericBrandName + genericBrandHostMatch,
 * so a generic brand is credited only for its canonical domain, a subdomain
 * of it, or a lookalike of the FULL canonical domain — never the bare word.
 * The NRD keyword matcher is covered in nrd-hagezi-source.test.ts.
 */
import { describe, it, expect } from "vitest";
import { variantsForBrand, generateVariants } from "../src/feeds/typosquat_scanner";
import { numberedVariantBrandId } from "../src/agents/analyst";
import { lookalikePermutationsForBrand } from "../src/scanners/lookalike-domains";
import { generatePermutations } from "../src/lib/dnstwist";
import { matchAbuseMailboxBrand } from "../src/lib/abuse-mailbox-brand-match";

describe("typosquat scanner — variantsForBrand", () => {
  it("keeps every variant for an ordinary brand", () => {
    expect(variantsForBrand("PayPal", "paypal.com")).toEqual(generateVariants("paypal.com"));
  });

  it("keeps only full-canonical lookalikes for a generic brand", () => {
    const v = variantsForBrand("Mail", "mail.ru");
    expect(v.length).toBeGreaterThan(0);
    expect(v).toContain("ma1l.ru");
    for (const bad of ["mail.com", "mail.net", "mal.ru", "ail.ru", "secure-mail.com", "mail-login.com"]) {
      expect(v, bad).not.toContain(bad);
    }
    expect(variantsForBrand("Site", "site.com")).not.toContain("site.net");
  });
});

describe("numbered-variant scan — numberedVariantBrandId", () => {
  const seed = (name: string | null, canonical: string | null) =>
    ({ target_brand_id: "b_seed", brand_name: name, brand_canonical: canonical });

  it("inherits an ordinary brand unchanged", () => {
    expect(numberedVariantBrandId("paypal-login12.com", seed("PayPal", "paypal.com"))).toBe("b_seed");
    expect(numberedVariantBrandId("x12.com", { target_brand_id: null, brand_name: null, brand_canonical: null })).toBeNull();
  });

  it("drops a generic brand unless the variant is its genuine lookalike", () => {
    expect(numberedVariantBrandId("xfinitymail98.weebly.com", seed("Mail", "mail.ru"))).toBeNull();
    expect(numberedVariantBrandId("1v.litemailkit.info", seed("Mail", "mail.ru"))).toBeNull();
    expect(numberedVariantBrandId("free-5532326.webadorsite.com", seed("Site", "site.com"))).toBeNull();
    expect(numberedVariantBrandId("mail-ru-2.com", seed("Mail", "mail.ru"))).toBe("b_seed");
    expect(numberedVariantBrandId("e2.mail.ru", seed("Mail", "mail.ru"))).toBe("b_seed");
  });
});

describe("lookalike seeder — lookalikePermutationsForBrand", () => {
  it("unchanged for an ordinary brand or an unknown name", () => {
    expect(lookalikePermutationsForBrand("PayPal", "paypal.com")).toEqual(generatePermutations("paypal.com"));
    expect(lookalikePermutationsForBrand(undefined, "mail.ru")).toEqual(generatePermutations("mail.ru"));
  });

  it("a generic brand keeps homoglyphs of the full canonical, drops TLD swaps / omissions / combos", () => {
    const kept = lookalikePermutationsForBrand("Mail", "mail.ru");
    const domains = kept.map((p) => p.domain);
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.some((d) => d.endsWith(".ru"))).toBe(true);
    for (const bad of ["mail.com", "mail.net", "mai.ru", "ail.ru"]) expect(domains, bad).not.toContain(bad);
    for (const p of kept) expect(p.domain.endsWith(".ru"), p.domain).toBe(true);
  });
});

describe("abuse mailbox — matchAbuseMailboxBrand", () => {
  const brands = [
    { id: "b_mail", name: "Mail", canonical_domain: "mail.ru" },
    { id: "b_paypal", name: "PayPal", canonical_domain: "paypal.com" },
  ];
  const input = (over: Partial<Parameters<typeof matchAbuseMailboxBrand>[0]>) =>
    ({ from_domain: null, subject: null, body_snippet: null, url_domains: [], ...over });

  it("never credits a generic brand by the bare word", () => {
    expect(matchAbuseMailboxBrand(input({ url_domains: ["zs-mail.com"] }), brands)).toBeNull();
    expect(matchAbuseMailboxBrand(input({ from_domain: "securemail-notify.com" }), brands)).toBeNull();
    expect(matchAbuseMailboxBrand(input({ subject: "Your mail box is full" }), brands)).toBeNull();
    expect(matchAbuseMailboxBrand(input({ body_snippet: "verify your mail account" }), brands)).toBeNull();
  });

  it("credits a generic brand on its canonical domain or a full-canonical lookalike", () => {
    expect(matchAbuseMailboxBrand(input({ url_domains: ["e.mail.ru"] }), brands))
      .toMatchObject({ brand_id: "b_mail", signal: "url_domain_exact" });
    expect(matchAbuseMailboxBrand(input({ url_domains: ["mail-ru.com"] }), brands))
      .toMatchObject({ brand_id: "b_mail", signal: "url_domain_typosquat" });
  });

  it("ordinary brands keep every signal", () => {
    expect(matchAbuseMailboxBrand(input({ url_domains: ["paypal-secure-update.com"] }), brands))
      .toMatchObject({ brand_id: "b_paypal", signal: "url_domain_typosquat" });
    expect(matchAbuseMailboxBrand(input({ subject: "PayPal: account limited" }), brands))
      .toMatchObject({ brand_id: "b_paypal", signal: "subject_keyword" });
  });
});
