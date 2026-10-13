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
import { matchMonitoredBrand } from "../src/feeds/certstream";
import { GenericBrandSet, creditGenericBrand, genericBrandOwnerCredit, matchGenericBrand } from "../src/lib/brandDetect";

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

describe("abuse mailbox — short generic brands stay excluded (review M4)", () => {
  const brands = [
    { id: "b_bit", name: "Bit", canonical_domain: "bit.ly" },
    { id: "b_app", name: "App", canonical_domain: "app.com" },
    { id: "b_mail", name: "Mail", canonical_domain: "mail.ru" },
  ];
  const input = (over: Partial<Parameters<typeof matchAbuseMailboxBrand>[0]>) =>
    ({ from_domain: null, subject: null, body_snippet: null, url_domains: [], ...over });

  it("a short-link report never wins Bit (bit.ly) at 95", () => {
    expect(matchAbuseMailboxBrand(input({ url_domains: ["bit.ly"] }), brands)).toBeNull();
    expect(matchAbuseMailboxBrand(input({ url_domains: ["x.app.com"] }), brands)).toBeNull();
  });

  it("a generic brand's multi-tenant subdomain is not url_domain_exact", () => {
    expect(matchAbuseMailboxBrand(input({ url_domains: ["cloud.mail.ru"] }), brands)).toBeNull();
    expect(matchAbuseMailboxBrand(input({ url_domains: ["e.mail.ru"] }), brands))
      .toMatchObject({ brand_id: "b_mail", signal: "url_domain_exact" });
  });
});

describe("CT feed — matchMonitoredBrand (review M1 / M3 / N2 / N3)", () => {
  const live = { id: "b_live", keyword: "livecom", domain: "live.com", genericName: "Live" };
  const cloud = { id: "b_cloud", keyword: "cloudmicrosoft", domain: "cloud.microsoft", genericName: "Cloud" };
  const mail = { id: "b_mail", keyword: "mailru", domain: "mail.ru", genericName: "Mail" };
  const ms = { id: "brand_microsoft_com", keyword: "microsoft", domain: "microsoft.com", genericName: null };
  const paypal = { id: "b_paypal", keyword: "paypal", domain: "paypal.com", genericName: null };
  const coinbase = { id: "b_coinbase", keyword: "coinbase", domain: "coinbase.com", genericName: null };

  it("generic brands only via the shared predicate, scored on their own word", () => {
    const entries = [mail, live, ms];
    expect(matchMonitoredBrand("emailrules.com", entries)).toBeNull();
    expect(matchMonitoredBrand("olivecompany.com", entries)).toBeNull();
    expect(matchMonitoredBrand("mail.ru.evil.com", entries)).toEqual({ id: "b_mail", keyword: "mail", isHomoglyph: false });
    expect(matchMonitoredBrand("mai1ru-login.com", entries)).toMatchObject({ id: "b_mail", isHomoglyph: true });
    expect(matchMonitoredBrand("e.mail.ru", entries)).toBeNull(); // own domain
  });

  it("an ordinary brand always wins over a generic one, whatever the row order (N2)", () => {
    for (const order of [[live, cloud, paypal, coinbase, ms], [paypal, coinbase, ms, live, cloud]]) {
      expect(matchMonitoredBrand("paypal-live-login.com", order)?.id).toBe("b_paypal");
      expect(matchMonitoredBrand("coinbase-cloud-login.com", order)?.id).toBe("b_coinbase");
    }
  });

  it("a vendor-product generic brand credits the parent only with a real vendor token (N3)", () => {
    const entries = [live, cloud, { id: "b_office", keyword: "officecom", domain: "office.com", genericName: "Office" }, ms];
    expect(matchMonitoredBrand("outlook-live-verify.com", entries)).toMatchObject({ id: "brand_microsoft_com", keyword: "live" });
    for (const h of ["cloud-login.com", "secure-cloud-login.net", "cloudlogin.io", "box-office-login.com", "live-login.com"]) {
      expect(matchMonitoredBrand(h, entries), h).toBeNull();
    }
    expect(matchMonitoredBrand("outlook-live-verify.com", [live, cloud])).toBeNull(); // parent not loaded
  });
});

describe("lure-gated generic brands in the other writers", () => {
  it("typosquat scanner keeps LINE's lure combos", () => {
    expect(variantsForBrand("Line", "line.me")).toContain("line-login.com");
    expect(variantsForBrand("Line", "line.me")).not.toContain("line.com");
  });
});

describe("writers never credit Microsoft from the generic word alone (review N3)", () => {
  const brands = [
    { id: "b_cloud", name: "Cloud", canonical_domain: "cloud.microsoft" },
    { id: "b_office", name: "Office", canonical_domain: "office.com" },
    { id: "b_live", name: "Live", canonical_domain: "live.com" },
  ];
  const set = new GenericBrandSet(brands, (id) => id === "brand_microsoft_com");
  it.each(["cloud-login.com", "secure-cloud-login.net", "cloudlogin.io", "box-office-login.com", "live-login.com",
    "outlook.office365.com", "login.live.com", "x.outlook.com"])("%s → nothing", (host) => {
    expect(set.credit(host)).toBeNull();
    for (const b of brands) expect(creditGenericBrand(host, b, () => true), `${host} x ${b.name}`).toBeNull();
  });
  it.each(["office365-login.com", "outlook-live.com", "onedrive-cloud-share.net", "hotmail-live-verify.com"])("%s → Microsoft", (host) => {
    expect(set.credit(host)?.brandId).toBe("brand_microsoft_com");
  });
  it("the cleanup uses the same rule (no broader cleanup-only context)", () => {
    expect(genericBrandOwnerCredit("live-login.com", "live.com")).toBeNull();
    expect(genericBrandOwnerCredit("cloud-login.com", "cloud.microsoft")).toBeNull();
    expect(genericBrandOwnerCredit("outlook-live-login.com", "live.com")).toEqual({ parentBrandId: "brand_microsoft_com" });
    expect(genericBrandOwnerCredit("outlook.office365.com", "office.com")).toBeNull(); // Microsoft's own host
  });
});

describe("owner credit on attacker-controlled tenant / subdomain labels (2026-10-13)", () => {
  const brands = [
    { id: "b_office", name: "Office", canonical_domain: "office.com" },
    { id: "b_live", name: "Live", canonical_domain: "live.com" },
  ];
  const set = new GenericBrandSet(brands, (id) => id === "brand_microsoft_com");
  // Production Live / Office links that the generic cleanup would otherwise
  // clear. Each is credited for the generic product its host names.
  it.each([
    ["ee6d1ec.outlookliveprotectionaccess.pages.dev", "live.com"],      // pages.dev tenant label
    ["acesorvirtual-356--segoffice365.replit.app", "office.com"],       // replit.app tenant label
    ["office358.rricrosoft-offices.org", "office.com"],                 // homoglyph "rricrosoft"
    ["net-outlook-live-management-mimecast--secured-protection.com", "live.com"],
    ["office365--account--verify.latestcasinoreviews.co.uk", "office.com"], // subdomain of an unrelated domain
  ] as const)("%s → Microsoft (via %s)", (host, canonical) => {
    expect(genericBrandOwnerCredit(host, canonical)).toEqual({ parentBrandId: "brand_microsoft_com" });
    expect(set.credit(host)?.brandId).toBe("brand_microsoft_com");
    const brand = brands.find((x) => x.canonical_domain === canonical)!;
    expect(creditGenericBrand(host, brand, (id) => id === "brand_microsoft_com")).toEqual({
      brandId: "brand_microsoft_com", method: "token",
    });
  });
  it("still needs the product word: a Live link on an Office-only host is not credited, and vice versa", () => {
    expect(genericBrandOwnerCredit("acesorvirtual-356--segoffice365.replit.app", "live.com")).toBeNull();
    expect(genericBrandOwnerCredit("ee6d1ec.outlookliveprotectionaccess.pages.dev", "office.com")).toBeNull();
  });
  it.each(["olive-sandpiper.hostingersite.com", "liveveiwtech.com", "livenation.com", "office-supplies.pages.dev",
    "live-stream.replit.app", "officemax.com"])("%s → no Microsoft", (host) => {
    for (const c of ["live.com", "office.com"]) expect(genericBrandOwnerCredit(host, c), `${host} x ${c}`).toBeNull();
    expect(set.credit(host)).toBeNull();
  });
  it("never on Microsoft's own hosts or shared multi-tenant hosts", () => {
    for (const host of ["outlook.office365.com", "login.live.com", "contoso.sharepoint.com", "onedrive.live.com",
      "office365-login.github.com", "outlook-live.safelinks.protection.outlook.com"]) {
      for (const c of ["live.com", "office.com"]) expect(genericBrandOwnerCredit(host, c), `${host} x ${c}`).toBeNull();
    }
  });
  it("the product word must be a whole token or glued only to lures / vendor tokens (review M1)", () => {
    for (const host of ["paypal-delivery.outlook-x.com", "olive-outlook.com", "deliveryoutlook-help.com",
      "paypal-delivery.rnicrosoft-support.com", "livenation-outlook.com", "officemax-outlook.com"]) {
      for (const c of ["live.com", "office.com"]) expect(genericBrandOwnerCredit(host, c), `${host} x ${c}`).toBeNull();
    }
    for (const [host, c] of [["livelogin-outlook.com", "live.com"], ["liveoutlook-verify.com", "live.com"],
      ["hotmaillive.com", "live.com"], ["myoffice-microsoft.com", "office.com"], ["office358-outlook.net", "office.com"]] as const) {
      expect(genericBrandOwnerCredit(host, c), host).toEqual({ parentBrandId: "brand_microsoft_com" });
    }
  });
  it("IdP tenant hosts: the tenant label is attacker-chosen, the vendor's own subdomain is not (review L1)", () => {
    expect(genericBrandOwnerCredit("outlook-live.okta.com", "live.com")).toEqual({ parentBrandId: "brand_microsoft_com" });
    expect(genericBrandOwnerCredit("login.okta.com", "live.com")).toBeNull();
    expect(genericBrandOwnerCredit("login.okta.com", "office.com")).toBeNull();
  });
  it("the homoglyph fold applies to the vendor NAME only, never the product word", () => {
    expect(genericBrandOwnerCredit("office-rnicrosoft.com", "office.com")).toEqual({ parentBrandId: "brand_microsoft_com" });
    expect(genericBrandOwnerCredit("office-micr0soft.com", "office.com")).toEqual({ parentBrandId: "brand_microsoft_com" });
    expect(genericBrandOwnerCredit("0ffice-microsoft.com", "office.com")).toBeNull();
    expect(genericBrandOwnerCredit("office-mirror-soft.com", "office.com")).toBeNull();
  });
});

describe("lure-gated LINE / Free use a narrow lure set (review N4)", () => {
  const line = { name: "Line", canonical_domain: "line.me" };
  const free = { name: "Free", canonical_domain: "free.fr" };
  it.each([
    ["free-claim.com", free], ["freetracking.com", free], ["free-wallet-claim.io", free], ["freeupdate.org", free],
    ["free-support-center.com", free], ["freerefund.net", free],
    ["linesupport.com", line], ["line-tracking.com", line], ["online-line-update.com", line], ["line-wallet.io", line],
  ] as const)("%s → not credited", (host, brand) => {
    expect(matchGenericBrand(host, brand, { subdomains: true })).toBeNull();
  });
  it.each([
    ["line-login.com", line], ["linelogin.xyz", line], ["mylinelogin.com", line], ["secure-line-verify.com", line],
    ["line-id-verify.com", line], ["free-facture-login.com", free], ["freelogin-verify.net", free], ["free-account.fr", free],
  ] as const)("%s → credited", (host, brand) => {
    expect(matchGenericBrand(host, brand, { subdomains: true })).toBe("token");
  });
});
