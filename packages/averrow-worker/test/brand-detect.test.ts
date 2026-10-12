import { describe, it, expect } from "vitest";
import {
  fuzzyMatchBrand,
  fuzzyMatchBrandDetailed,
  matchBrandToHost,
  keywordMatchesHost,
  hostOf,
  isGenericBrand,
  isMultiTenantHost,
  isPlatformTenantHost,
  isGenericBrandName,
  genericBrandDomainKeywords,
  genericBrandHostMatch,
  type BrandRow,
} from "../src/lib/brandDetect";

const b = (name: string, canonical_domain: string): BrandRow => ({
  id: `brand_${canonical_domain.replace(/[^a-z0-9]/g, "_")}`,
  name,
  canonical_domain,
});

// The brands the Star Blizzard / RedFlick OTX pulse (Sep 30 2026) was
// wrongly linked to in production, plus real impersonation targets.
const BRANDS: BrandRow[] = [
  b("Club", "club.fr"), b("Click", "click.ro"), b("Link", "link.me"),
  b("China", "china.com.cn"), b("Media", "media.net"), b("Secure", "secure.ne.jp"),
  b("Kick", "kick.com"), b("Lider", "lider.cl"), b("Uach", "uach.cl"),
  b("Coveo", "coveo.com"), b("Observer", "observer.com"), b("Mauve", "mauve.cloud"),
  b("Groww", "groww.in"), b("Aman", "aman.com"),
  b("Data", "data.gov.uk"), b("Login", "login.gov"), b("Word", "word.tips"),
  b("PayPal", "paypal.com"), b("DocuSign", "docusign.com"), b("Microsoft", "microsoft.com"),
  b("Netflix", "netflix.com"), b("Roblox", "roblox.com"),
];

describe("Star Blizzard pulse false positives — must not match any brand", () => {
  it.each([
    "drasw.club", "matjk.click", "bpdaersa.click", "qumel.link", "cyrna.top",
    "etia.ca", "secure-dns-hub.com", "divekickspolic.org", "gliderrompercycl.com",
    "guach.net", "byveo.org", "ruten.observer", "muvb.net", "groy.cc",
    "stuseamandesilt.org",
  ])("%s → null", (domain) => {
    expect(fuzzyMatchBrand([domain, `http://${domain}`], BRANDS)).toBeNull();
  });
});

describe("real impersonations still match", () => {
  it.each([
    ["paypal-secure.com", "brand_paypal_com", "token"],
    ["paypalsecure-verify.net", "brand_paypal_com", "substring"],
    ["mypaypalcheckout.com", "brand_paypal_com", "substring"],
    ["paypa1-login.com", "brand_paypal_com", "levenshtein"],
    ["docusign-verify.net", "brand_docusign_com", "token"],
    ["docusigm.com", "brand_docusign_com", "levenshtein"],
    ["microsoft365-login.co.uk", "brand_microsoft_com", "substring"],
    ["kick-login.com", "brand_kick_com", "token"],
    ["netflix.com", "brand_netflix_com", "canonical"],
    ["www.paypal.com", "brand_paypal_com", "canonical"],
    ["https://roblox-free.xyz/claim?x=1", "brand_roblox_com", "token"],
  ])("%s → %s via %s", (input, brandId, method) => {
    expect(fuzzyMatchBrandDetailed([input], BRANDS)).toEqual({ brandId, method });
  });
});

describe("generic-word brands match only by canonical domain", () => {
  it("never matches as a token or substring", () => {
    expect(fuzzyMatchBrand(["paypal-login.com"], [b("Login", "login.gov")])).toBeNull();
    expect(fuzzyMatchBrand(["data-export.io"], [b("Data", "data.gov.uk")])).toBeNull();
    expect(fuzzyMatchBrand(["evil.pages.dev"], [b("Pages", "pages.dev")])).toBeNull();
  });

  it("still matches its exact canonical domain", () => {
    expect(fuzzyMatchBrandDetailed(["login.gov"], [b("Login", "login.gov")]))
      .toEqual({ brandId: "brand_login_gov", method: "canonical" });
  });

  it("isGenericBrand covers dictionary words, filler words and numerics", () => {
    for (const w of ["data", "login", "click", "secure", "media", "club", "12345"]) {
      expect(isGenericBrand(w), w).toBe(true);
    }
    expect(isGenericBrand("paypal")).toBe(false);
  });
});

describe("public suffix and URL path are never matched", () => {
  it("ignores the TLD label", () => {
    expect(matchBrandToHost("anything.observer", b("Observeur", "observeur.fr"))).toBeNull();
    expect(matchBrandToHost("roblox.co.uk", b("Roblox", "roblox.com"))).toBe("token");
  });

  it("ignores the URL path", () => {
    expect(fuzzyMatchBrand(["http://evil.example/paypal/login"], BRANDS)).toBeNull();
  });

  it("ignores IP literals", () => {
    expect(fuzzyMatchBrand(["103.160.59.97"], BRANDS)).toBeNull();
  });
});

describe("edit-distance thresholds", () => {
  const roblox = b("Roblox", "roblox.com");      // 6 chars → distance 1
  const docusign = b("DocuSign", "docusign.com"); // 8 chars → distance 2
  it("allows 1 edit for 6–7 char names, not 2", () => {
    expect(matchBrandToHost("rob1ox.com", roblox)).toBe("levenshtein");
    expect(matchBrandToHost("rib1ox.com", roblox)).toBeNull();
  });
  it("allows 2 edits for 8+ char names", () => {
    expect(matchBrandToHost("d0cus1gn.com", docusign)).toBe("levenshtein");
  });
  it("requires the same first character", () => {
    expect(matchBrandToHost("xoblox.com", roblox)).toBeNull();
  });
  it("never fuzzy-matches names under 6 chars", () => {
    expect(matchBrandToHost("byveo.org", b("Coveo", "coveo.com"))).toBeNull();
    expect(matchBrandToHost("cyrna.top", b("China", "china.com.cn"))).toBeNull();
  });
});

describe("keywordMatchesHost (Analyst pre-match)", () => {
  it("applies the same boundary rules", () => {
    expect(keywordMatchesHost("kick", "divekickspolic.org")).toBe(false);
    expect(keywordMatchesHost("kick", "kick-verify.net")).toBe(true);
    expect(keywordMatchesHost("paypal", "secure-paypal-update.com")).toBe(true);
    expect(keywordMatchesHost("click", "matjk.click")).toBe(false);
    expect(keywordMatchesHost("data", "data-portal.com")).toBe(false);
  });
});

describe("hostOf", () => {
  it.each([
    ["https://User@Paypal-Login.com:8443/a?b#c", "paypal-login.com"],
    ["www.example.com.", "example.com"],
    ["example.com/path", "example.com"],
  ])("%s → %s", (input, host) => {
    expect(hostOf(input)).toBe(host);
  });
});

describe("PhishTank target field (bare brand name)", () => {
  it("still resolves", () => {
    expect(fuzzyMatchBrand(["unrelated-host.xyz", "paypal"], BRANDS)).toBe("brand_paypal_com");
  });
});

describe("non-domain IOC values never match", () => {
  const brands = [
    b("Login", "login.gov"), b("Word", "word.tips"), b("Data", "data.gov.uk"),
    b("Ashs", "ashs.org"), b("List", "list.am"), b("1x1x5", "1x1x5.com"),
    b("Httpwg", "httpwg.org"), b("Finder", "finder.co.kr"),
  ];
  it.each([
    '{"ip":"45.178.74.75","category":"telnet_brute","dataplane_feed":"telnetlogin"}',
    '{"ip":"109.123.238.174","category":"ssh_password_spray","dataplane_feed":"sshpwauth"}',
    '{"value":"45.61.163.8","type":"ip","user":"Fact_Finder03","tags":["#C2"]}',
    "hash:sha-256:cc00c23768bee76e2f297c1766a013a681efb519888545352cff96fc5cead035",
    "49.235.175.36 (6 lists)",
    "115.50.231.176",
    "http://59.96.136.45:56936/i",
    "12345",
  ])("%s → null", (ioc) => {
    expect(fuzzyMatchBrand([ioc], brands)).toBeNull();
  });
});

describe("adjacent transposition counts as one edit", () => {
  it("camosda.com → Camsoda", () => {
    expect(matchBrandToHost("camosda.com", b("Camsoda", "camsoda.com"))).toBe("levenshtein");
  });
});

describe("code-review regressions", () => {
  it("shared-hosting platform names are not brand evidence", () => {
    const brands = [b("Github", "github.com"), b("PayPal", "paypal.com"), b("Firebase", "firebase.google.com")];
    expect(fuzzyMatchBrandDetailed(["paypal-login.github.io"], brands))
      .toEqual({ brandId: "brand_paypal_com", method: "token" });
    expect(fuzzyMatchBrand(["khoiho805.github.io"], brands)).toBeNull();
    expect(fuzzyMatchBrand(["myapp-12345.firebaseapp.com"], brands)).toBeNull();
    expect(matchBrandToHost("evil.pages.dev", b("Pages", "pages.dev"))).toBeNull();
  });

  it("no filler stripping inside short words", () => {
    expect(matchBrandToHost("helpscout.net", b("Scout", "scout.com"))).toBeNull();
    expect(matchBrandToHost("webflow-x.io", b("Flow", "flow.com"))).toBeNull();
    expect(matchBrandToHost("kicklogin.com", b("Kick", "kick.com"))).toBeNull();
  });

  it("unprefixed hex digests never match", () => {
    expect(matchBrandToHost("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f0cafe24",
      b("Cafe24", "cafe24.com"))).toBeNull();
  });

  it("bare names with punctuation stripped still match (PhishTank target)", () => {
    expect(fuzzyMatchBrand(["ebay inc"], [b("eBay", "ebay.com")])).toBe("brand_ebay_com");
    expect(fuzzyMatchBrand(["wells fargo company"], [b("Wells Fargo", "wellsfargo.com")]))
      .toBe("brand_wellsfargo_com");
  });

  it("accepts underscores in hostnames", () => {
    expect(matchBrandToHost("paypal_login.weebly.com", b("PayPal", "paypal.com"))).toBe("token");
  });

  it("single-pair and catalog matchers agree", () => {
    for (const host of ["costc0.com", "camosda.com", "mypaypalcheckout.com", "drasw.club"]) {
      const brand = [b("Costco", "costco.com"), b("Camsoda", "camsoda.com"), b("PayPal", "paypal.com"), b("Club", "club.fr")];
      const hit = fuzzyMatchBrandDetailed([host], brand);
      const pair = brand.map((x) => matchBrandToHost(host, x)).find((m) => m) ?? null;
      expect(hit?.method ?? null, host).toBe(pair);
    }
  });
});

describe("tier gate (2026-10-01 production dry run)", () => {
  const tracked = (name: string, canonical: string): BrandRow => ({ ...b(name, canonical), tier: "tracked" });
  const monitored = (name: string, canonical: string): BrandRow => ({ ...b(name, canonical), tier: "monitored" });

  it("tracked-catalog brands match only their exact canonical domain", () => {
    expect(matchBrandToHost("abc.protocol-labs.net", tracked("Protocol", "protocol.com"))).toBeNull();
    expect(matchBrandToHost("us-east-1.foo.com", tracked("East", "east.net"))).toBeNull();
    expect(matchBrandToHost("shieldsecure.xyz", tracked("Shield", "shield.com"))).toBeNull();
    expect(matchBrandToHost("protocol.com", tracked("Protocol", "protocol.com"))).toBe("canonical");
  });

  it("monitored brands keep full fuzzy matching", () => {
    expect(matchBrandToHost("t-mobile-verify.net", monitored("T-Mobile", "t-mobile.com"))).toBe("substring");
    expect(matchBrandToHost("metamask-restore.app", monitored("MetaMask", "metamask.io"))).toBe("token");
  });

  it("the catalog matcher skips tracked brands and picks the monitored one", () => {
    const brands = [tracked("Vault", "vault.com"), monitored("Ledger", "ledger.com")];
    expect(fuzzyMatchBrandDetailed(["ledger-vault-secure.com"], brands))
      .toEqual({ brandId: "brand_ledger_com", method: "token" });
    expect(fuzzyMatchBrand(["my-vault.com"], brands)).toBeNull();
  });

  it("brands without a tier (legacy callers) still match fully", () => {
    expect(matchBrandToHost("paypal-secure.com", b("PayPal", "paypal.com"))).toBe("token");
  });

  it("dynamic-DNS / tunnel suffixes are not brand evidence", () => {
    for (const host of ["paypal-login.dynv6.net", "paypal-login.mydns.jp", "paypal-login.trycloudflare.com"]) {
      expect(fuzzyMatchBrandDetailed([host], [b("Dynv6", "dynv6.net"), b("Mydns", "mydns.jp"), b("PayPal", "paypal.com")]), host)
        .toEqual({ brandId: "brand_paypal_com", method: "token" });
    }
    expect(fuzzyMatchBrand(["xyz123.dynv6.net"], [b("Dynv6", "dynv6.net")])).toBeNull();
  });

  it("content hosted on a shared IPFS gateway is not the gateway's brand", () => {
    expect(matchBrandToHost("https://ipfs.io/ipfs/bafkreia34hv5rni", b("Ipfs", "ipfs.io"))).toBeNull();
    // Subdomain-style gateway: the CID label is the tenant, "ipfs"/"dweb" are not evidence.
    expect(matchBrandToHost("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.dweb.link",
      b("Ipfs", "ipfs.io"))).toBeNull();
  });

  it("the gate decides the winner even when the tracked brand would match first", () => {
    const brands = [tracked("Harbor", "harbor.com"), monitored("Ledger", "ledger.com")];
    expect(fuzzyMatchBrandDetailed(["harbor-ledger.com"], brands))
      .toEqual({ brandId: "brand_ledger_com", method: "token" });
    expect(fuzzyMatchBrandDetailed(["harbor-ledger.com"], brands.map((x) => ({ ...x, tier: "monitored" }))))
      .toEqual({ brandId: "brand_harbor_com", method: "token" });
  });
});

describe("IdP-lure lookalikes credit the targeted brand, not the IdP vendor", () => {
  const m = (name: string, canonical_domain: string, id: string): BrandRow =>
    ({ id, name, canonical_domain, tier: "monitored" });
  const IDP_BRANDS: BrandRow[] = [
    m("Okta", "okta.com", "b_okta"),
    m("Microsoft", "microsoft.com", "b_ms"),
    m("Persona", "withpersona.com", "b_persona"),
    m("Acme", "acme.com", "b_acme"),
    m("Persona Identities", "personaid.io", "b_personaid"),
    // Generic catalog names the platform already mis-credits.
    m("One", "one.com", "b_one"), m("Cloud", "cloud.com", "b_cloud"), m("Gnu", "gnu.org", "b_gnu"),
    m("Login", "login.gov", "b_login"), m("Portal", "portal.io", "b_portal"),
  ];
  const brandOf = (h: string) => fuzzyMatchBrandDetailed([h], IDP_BRANDS)?.brandId ?? null;

  it.each([
    ["withpersona.okta-linksso.com", "b_persona"],
    ["https://withpersona.okta-linksso.com/app/sso/saml", "b_persona"],
    ["okta-acme.com", "b_acme"],
    ["acme-okta-sso.net", "b_acme"],
    ["withpersona.microsoftonline-sso.com", "b_persona"],
    // IdP tenant host — unchanged tenant-label rule.
    ["acme-sso.okta.com", "b_acme"],
  ])("%s → %s", (host, brand) => {
    expect(brandOf(host)).toBe(brand);
  });

  it("a remainder label equal to a brand's canonical owner label matches it", () => {
    // "Persona Identities" is not a substring of "personaid"; the owner label is.
    expect(brandOf("personaid.okta-verify.com")).toBe("b_personaid");
  });

  it("vendor-only lure (no other brand evidence) credits the IdP vendor itself", () => {
    expect(brandOf("okta-login-secure.com")).toBe("b_okta");
    expect(brandOf("oktalogin.com")).toBe("b_okta");
    expect(brandOf("0kta-verify.com")).toBe("b_okta");
  });

  it("a leftover that matches no brand does not block the vendor fallback", () => {
    for (const h of [
      "www2.okta-login.com", "a8f3kd.okta-signin.com", "okta-auth-7hj2k.duckdns.org",
      "cdn.okta-sso.com", "mail-okta-verify.com", "contosoltd.okta-linksso.com", "okta-contosoltd.com",
    ]) expect(brandOf(h), h).toBe("b_okta");
    // …but a leftover that DOES match a brand still wins.
    expect(brandOf("withpersona.okta-linksso.com")).toBe("b_persona");
  });

  it("filler owner labels are never brand evidence beside a lure", () => {
    const withRemote: BrandRow[] = [...IDP_BRANDS, m("Remote Inc", "remote.com", "b_remote")];
    expect(fuzzyMatchBrandDetailed(["okta-acme-remote.com"], withRemote)?.brandId).toBe("b_acme");
  });

  it.each([
    "one-okta-login.com", "okta-cloud-portal.com", "okta-gnu.com", "login.okta-sso.com",
    "secure-portal.okta-access.net",
  ])("generic words never become the brand: %s → Okta (vendor-only)", (host) => {
    expect(brandOf(host)).toBe("b_okta");
  });

  it("matchBrandToHost (catalog-free) validates the remainder and the vendor fallback", () => {
    const okta = IDP_BRANDS[0]!;
    const persona = IDP_BRANDS[2]!;
    // Permissive by design: without the catalog it cannot know the leftover
    // names Persona, so the vendor fallback validates. Catalog-aware
    // re-attribution uses fuzzyMatchBrandDetailed (idp-reattribution).
    expect(matchBrandToHost("withpersona.okta-linksso.com", okta)).toBe("token");
    expect(matchBrandToHost("okta-acme.com", IDP_BRANDS[3]!)).toBe("token");
    expect(matchBrandToHost("withpersona.okta-linksso.com", persona)).toBe("token"); // canonical owner label
    expect(matchBrandToHost("okta-login-secure.com", okta)).toBe("token");
    expect(matchBrandToHost("personaid.okta-verify.com", IDP_BRANDS[4]!)).toBe("token");
  });

  it("leftover evidence is whole-token only — never a prefix/substring of a longer word", () => {
    const cat: BrandRow[] = [...IDP_BRANDS, m("Author", "author.today", "b_author"), m("Pay", "pay.com", "b_pay")];
    const of = (h: string) => fuzzyMatchBrandDetailed([h], cat);
    expect(of("login.o365.teams-microsoftonline-com-common-oauth2-v2-0-authorize-login.com"))
      .toEqual({ brandId: "b_ms", method: "token", vendorCredit: true });
    // whole token still wins, also after peeling a glued auth word
    expect(of("author-okta.com")?.brandId).toBe("b_author");
    expect(of("acmesecure-okta.com")?.brandId).toBe("b_acme");
    expect(of("payments-okta.com")?.brandId).toBe("b_okta");
  });

  it("login-phrase words that are also brands are lure filler", () => {
    const cat: BrandRow[] = [...IDP_BRANDS, m("Register", "register.com", "b_reg"), m("LogMeIn", "logmein.com", "b_lmi")];
    for (const h of ["register.microsoftonline-p-int.com", "logmein-microsoftonline.com", "signup-okta.com"]) {
      expect(fuzzyMatchBrandDetailed([h], cat)?.brandId, h).toMatch(/^b_(ms|okta)$/);
    }
  });

  it("the same vendor's products keep the vendor credit", () => {
    const cat: BrandRow[] = [...IDP_BRANDS, m("Outlook", "outlook.com", "b_outlook"), m("OneDrive", "onedrive.com", "b_od")];
    for (const h of ["microsoftonline-outlook.live", "com-microsoftonline-ondrive.ca", "teams-microsoftonline.com"]) {
      expect(fuzzyMatchBrandDetailed([h], cat)?.brandId, h).toBe("b_ms");
    }
    // A different vendor's lure beside Outlook: Outlook IS the target.
    expect(fuzzyMatchBrandDetailed(["outlook-okta.com"], cat)?.brandId).toBe("b_outlook");
  });

  it("leftovers credit only in-scope or well-known (tracked + Tranco <= 20000) brands", () => {
    const tracked = (name: string, canonical_domain: string, id: string, rank: number | null): BrandRow =>
      ({ id, name, canonical_domain, tier: "tracked", tranco_rank: rank });
    expect(fuzzyMatchBrand(["zorblax-okta.com"], [...IDP_BRANDS, tracked("Zorblax", "zorblax.io", "b_z", 900000)])).toBe("b_okta");
    expect(fuzzyMatchBrand(["zorblax-okta.com"], [...IDP_BRANDS, tracked("Zorblax", "zorblax.io", "b_z", null)])).toBe("b_okta");
    expect(fuzzyMatchBrand(["zorblax-okta.com"], [...IDP_BRANDS, tracked("Zorblax", "zorblax.io", "b_z", 15000)])).toBe("b_z");
    // the pair validator agrees when it is given the rank
    expect(matchBrandToHost("zorblax-okta.com", tracked("Zorblax", "zorblax.io", "b_z", 15000))).toBe("token");
    // …but the well-known tracked branch never widens non-IdP matching
    expect(fuzzyMatchBrand(["zorblax-login.com"], [tracked("Zorblax", "zorblax.io", "b_z", 15000)])).toBeNull();
    // typo leftovers stay monitored/customer only
    expect(fuzzyMatchBrand(["zorbiax-okta.com"], [...IDP_BRANDS, tracked("Zorblax", "zorblax.io", "b_z", 15000)])).toBe("b_okta");
  });

  it("a generic 'sso' lure alone keeps the ordinary matcher (no vendor to mis-credit)", () => {
    const cat: BrandRow[] = [...IDP_BRANDS, m("PayPal", "paypal.com", "b_paypal"), m("Amazon", "amazon.com", "b_amazon")];
    expect(fuzzyMatchBrandDetailed(["paypa1-sso.com"], cat)).toEqual({ brandId: "b_paypal", method: "levenshtein" });
    expect(fuzzyMatchBrandDetailed(["sso.paypa1-secure.com"], cat)).toEqual({ brandId: "b_paypal", method: "levenshtein" });
    expect(fuzzyMatchBrandDetailed(["amazonprime-sso.com"], cat)).toEqual({ brandId: "b_amazon", method: "substring" });
    expect(fuzzyMatchBrandDetailed(["paypal-sso.com"], cat)).toEqual({ brandId: "b_paypal", method: "token" });
  });

  it("typo'd monitored brand leftovers on a vendor lure still match (whole-token fuzzy)", () => {
    const paypal = m("PayPal", "paypal.com", "b_paypal");
    expect(fuzzyMatchBrandDetailed(["paypa1-okta.com"], [...IDP_BRANDS, paypal]))
      .toEqual({ brandId: "b_paypal", method: "levenshtein" });
    expect(matchBrandToHost("paypa1-okta.com", paypal)).toBe("levenshtein");
  });

  it("peeling only strips phishing words, and peeled tokens match names exactly", () => {
    const cat: BrandRow[] = [...IDP_BRANDS, m("Scout", "scout.com", "b_scout"), m("Desk", "desk.com", "b_desk"),
      m("Chimp", "chimp.io", "b_chimp")];
    for (const h of ["helpscout-okta.com", "helpdesk-okta.com", "mailchimp-okta.com"]) {
      expect(fuzzyMatchBrand([h], cat), h).toBe("b_okta");
    }
    // "withpersona" is Persona's owner LABEL, not its name — no peeled match.
    expect(fuzzyMatchBrand(["securewithpersona-okta.com"], IDP_BRANDS)).toBe("b_okta");
    expect(fuzzyMatchBrand(["securepersona-okta.com"], IDP_BRANDS)).toBe("b_persona");
  });

  it("dictionary-like Microsoft products are exact-only family words", () => {
    const cat: BrandRow[] = [...IDP_BRANDS, m("Hammer", "hammer.com", "b_hammer"), m("Window", "window.com", "b_window"),
      m("Dynamic", "dynamic.com", "b_dynamic")];
    expect(fuzzyMatchBrand(["hammer-microsoftonline.com"], cat)).toBe("b_hammer");
    expect(fuzzyMatchBrand(["window-microsoftonline.com"], cat)).toBe("b_window");
    expect(fuzzyMatchBrand(["dynamic-microsoftonline.com"], cat)).toBe("b_dynamic");
    expect(fuzzyMatchBrand(["yammer-microsoftonline.com"], cat)).toBe("b_ms");
  });

  it("pair validation never invalidates a link the pre-2026-10-12 rules accepted", () => {
    expect(matchBrandToHost("microsoftonline-outlook.live", m("Outlook", "outlook.com", "b_outlook"))).toBe("token");
    expect(matchBrandToHost("login.o365.teams-microsoftonline-com-common-oauth2-v2-0-authorize-login.com",
      m("Author", "author.today", "b_author"))).toBe("substring");
    expect(matchBrandToHost("logmein-microsoftonline.com", m("LogMeIn", "logmein.com", "b_lmi"))).toBe("token");
  });

  it("non-IdP hosts are unaffected", () => {
    expect(brandOf("acme-login.com")).toBe("b_acme");
    expect(brandOf("bbva-entra.com")).toBeNull(); // compound-only lure, no stripping
    expect(keywordMatchesHost("okta", "withpersona.okta-linksso.com")).toBe(false);
    expect(keywordMatchesHost("persona", "withpersona.okta-linksso.com")).toBe(true);
  });
});

describe("free site builders are platform suffixes (chase-login.jimdofree.com is Chase)", () => {
  const mon = (name: string, canonical_domain: string, id: string): BrandRow =>
    ({ id, name, canonical_domain, tier: "monitored" });
  const CAT: BrandRow[] = [
    mon("Jimdofree", "jimdofree.com", "b_jimdofree"), mon("Jimdo", "jimdo.com", "b_jimdo"),
    mon("Tilda", "tilda.ws", "b_tilda"), mon("Chase", "chase.com", "b_chase"),
    mon("Microsoft", "microsoft.com", "b_ms"), mon("Strikingly", "strikingly.com", "b_strk"),
  ];
  const of = (h: string) => fuzzyMatchBrand([h], CAT);

  it.each([
    ["chase-login.jimdofree.com", "b_chase"], ["chase-secure.jimdosite.com", "b_chase"],
    ["microsoft-login.tilda.ws", "b_ms"],
    ["microsoft365.mystrikingly.com", "b_ms"], ["chase-verify.yolasite.com", "b_chase"],
    ["chase.webnode.page", "b_chase"], ["chase-online.site123.me", "b_chase"],
    ["chase-login.framer.website", "b_chase"], ["chase-login.square.site", "b_chase"],
  ])("%s → %s", (host, brand) => {
    expect(of(host)).toBe(brand);
  });

  it("a tenant label that names no brand credits nobody (not the builder)", () => {
    expect(of("xk2-login.jimdofree.com")).toBeNull();
    expect(of("project1234.tilda.ws")).toBeNull();
  });

  it("the builder's own site still matches the builder brand", () => {
    expect(of("jimdofree.com")).toBe("b_jimdofree");
    expect(of("www.jimdo.com")).toBe("b_jimdo");
    expect(of("https://tilda.ws/")).toBe("b_tilda");
  });

  it("jimdo.com is Jimdo's corporate domain, not a free-site host", () => {
    expect(of("help.jimdo.com")).toBe("b_jimdo");
    expect(of("accounts.jimdo.com")).toBe("b_jimdo");
    expect(isPlatformTenantHost("help.jimdo.com")).toBe(false);
    expect(isMultiTenantHost("jimdo.com")).toBe(false);
  });

  it("tenant subdomains are single-tenant platform hosts; the apex is shared", () => {
    expect(isPlatformTenantHost("chase-login.jimdofree.com")).toBe(true);
    expect(isMultiTenantHost("chase-login.jimdofree.com")).toBe(false);
    expect(isMultiTenantHost("jimdofree.com")).toBe(true);
  });

  it("the pair validator no longer accepts the builder brand on a tenant host", () => {
    expect(matchBrandToHost("chase-login.jimdofree.com", CAT[0]!)).toBeNull();
    // IdP lure on a builder: the legacy (old full-host) path is built from the
    // suffix-stripped labels, so it cannot accept Jimdofree either.
    expect(matchBrandToHost("login-microsoftonnline.jimdofree.com", CAT[0]!)).toBeNull();
    expect(matchBrandToHost("login-microsoftonnline.jimdofree.com", CAT[4]!)).toBe("token");
  });
});

// ─── 2026-10-12: generic-word brands credit only their FULL canonical domain ───
describe("generic-word brands (Mail mail.ru, Site site.com, Login login.gov)", () => {
  const mon = (name: string, canonical_domain: string, id: string): BrandRow =>
    ({ id, name, canonical_domain, tier: "monitored", tranco_rank: 11 });
  const MAIL = mon("Mail", "mail.ru", "b_mail");
  const SITE = mon("Site", "site.com", "b_site");
  const LOGIN = mon("Login", "login.gov", "b_login");
  const CAT: BrandRow[] = [MAIL, SITE, LOGIN, mon("PayPal", "paypal.com", "b_paypal"), mon("Xfinity", "xfinity.com", "b_xfinity")];
  const of = (h: string) => fuzzyMatchBrandDetailed([h], CAT);

  // Production hosts (2026-10-12) wrongly linked to the three generic brands.
  it.each([
    "1lookupmails.com", "zs-mail.com", "0v.litemailkit.info", "www.tiktok--mall.xyz",
    "0bmmubit.site-enfejar-ba-zarib-bala.com", "free-5532325.webadorsite.com",
    "x.membersecurelogin.com", "voiceloginqa4.fmr.com", "loginwifi.etisalat.ae",
    "abc.framer.website", "mail-login.framer.website", "rnail.info", "mail.com", "mail.net",
    "secure-mail-login.com", "site-login.com", "my-site.com", "x.site.com.br",
  ])("%s credits none of the generic brands", (host) => {
    for (const brand of [MAIL, SITE, LOGIN]) expect(matchBrandToHost(host, brand), `${host} x ${brand.name}`).toBeNull();
    const hit = of(host);
    expect(["b_mail", "b_site", "b_login"]).not.toContain(hit?.brandId);
  });

  it("a real brand on the same host still wins (xfinitymail97.weebly.com → Xfinity, not Mail)", () => {
    expect(of("xfinitymail97.weebly.com")).toEqual({ brandId: "b_xfinity", method: "substring" });
    expect(of("paypal-mail-login.com")).toEqual({ brandId: "b_paypal", method: "token" });
  });

  it.each([
    ["mail.ru", "b_mail", "canonical"],
    ["www.mail.ru", "b_mail", "canonical"],
    ["mail-ru.com", "b_mail", "token"],
    ["mailru-login.net", "b_mail", "token"],
    ["mymailru.net", "b_mail", "token"],
    ["mail.ru.secure-login.com", "b_mail", "token"],
    ["login.gov.account-verify.us", "b_login", "token"],
    ["mai1.ru", "b_mail", "levenshtein"],
    ["rnail.ru", "b_mail", "levenshtein"],
    ["login-gov.us", "b_login", "token"],
    ["secure-login-gov.com", "b_login", "token"],
    ["site-com.xyz", "b_site", "token"],
    ["s1te.com", "b_site", "levenshtein"],
  ])("%s → %s via %s (full-canonical lookalike)", (host, brandId, method) => {
    expect(of(host)).toEqual({ brandId, method });
    const brand = CAT.find((b) => b.id === brandId)!;
    expect(matchBrandToHost(host, brand)).toBe(method);
  });

  it("a subdomain of the canonical is a valid EXISTING link, but the catalog matcher never creates one", () => {
    expect(matchBrandToHost("e.mail.ru", MAIL)).toBe("canonical");
    expect(of("e.mail.ru")).toBeNull();
    expect(genericBrandHostMatch("e.mail.ru", "mail.ru", { subdomains: false })).toBeNull();
  });

  it("a platform-tenant subdomain is never the generic brand's", () => {
    expect(matchBrandToHost("evil.pages.dev", b("Pages", "pages.dev"))).toBeNull();
  });

  it("tracked generic brands stay canonical-only", () => {
    const tracked: BrandRow = { ...MAIL, tier: "tracked" };
    expect(matchBrandToHost("mail-ru.com", tracked)).toBeNull();
    expect(matchBrandToHost("mail.ru", tracked)).toBe("canonical");
    expect(fuzzyMatchBrand(["mail-ru.com"], [tracked])).toBeNull();
  });

  it("isGenericBrandName / genericBrandDomainKeywords are the shared definition", () => {
    for (const n of ["Mail", "Site", "Login", "One", "Cloud", "Live", "Online", "Web", "App", "Secure",
      "Account", "Bank", "Shop", "Store", "Pay", "Gnu", "1&1"]) {
      expect(isGenericBrandName(n), n).toBe(true);
    }
    for (const n of ["Zoom", "Adobe", "Discord", "PayPal", "Box", "Mail.ru"]) expect(isGenericBrandName(n), n).toBe(false);
    expect(genericBrandDomainKeywords("mail.ru")).toEqual(["mailru", "mail-ru"]);
    expect(genericBrandDomainKeywords("www.login.gov")).toEqual(["logingov", "login-gov"]);
    expect(genericBrandDomainKeywords("www.gov.uk")).toEqual([]); // bare public suffix
    expect(genericBrandDomainKeywords("")).toEqual([]);
  });
});

// ─── 2026-10-12: a 4–5 char brand glued inside one long run-on label ───
describe("glued-substring rule (4–5 char names inside one long token)", () => {
  const mon = (name: string, canonical_domain: string, id: string): BrandRow =>
    ({ id, name, canonical_domain, tier: "monitored" });
  const CAT: BrandRow[] = [
    mon("Zoom", "zoom.us", "b_zoom"), mon("Adobe", "adobe.com", "b_adobe"), mon("PayPal", "paypal.com", "b_paypal"),
    mon("Chase", "chase.com", "b_chase"), mon("Apple", "apple.com", "b_apple"), mon("Scout", "scout.com", "b_scout"),
    mon("Kick", "kick.com", "b_kick"), mon("Citi", "citi.com", "b_citi"),
  ];
  const of = (h: string) => fuzzyMatchBrandDetailed([h], CAT);

  it.each([
    ["invitationlauchjczoommeeting.com", "b_zoom", "substring"],
    ["adobeacrobatdoc.com", "b_adobe", "substring"],
    ["zoommeeting-invite.com", "b_zoom", "substring"],
    ["myadobesign.net", "b_adobe", "substring"],
    ["paypalsecureverify.com", "b_paypal", "substring"], // 6+ chars: the existing substring rule
    ["chaseverifyaccount.com", "b_chase", "substring"], // hazard name anchored at the token start
    ["loginchase.com", "b_chase", "substring"], // …or at its end
  ])("%s → %s", (host, brandId, method) => {
    expect(of(host)).toEqual({ brandId, method });
    expect(matchBrandToHost(host, CAT.find((x) => x.id === brandId)!)).toBe(method);
  });

  it.each([
    "helpscout.net", "kicklogin.com", // short glue (< 10 chars) stays whole-token only
    "purchaseverify.com", "pineapplelogin.com", "citizenlogin.com", // English-word fragments
    "zoomcarrentals.com", "applebeesgrill.com", "santafeadobehomes.com", // no lure word beside the name
    "sonydoctorhouse.com",
  ])("%s → no brand", (host) => {
    expect(of(host)).toBeNull();
    for (const brand of CAT) expect(matchBrandToHost(host, brand), `${host} x ${brand.name}`).toBeNull();
  });

  it("tracked and generic brands never use it", () => {
    expect(matchBrandToHost("invitationlauchjczoommeeting.com", { ...CAT[0]!, tier: "tracked" })).toBeNull();
    expect(matchBrandToHost("mymailmeetinginvite.com", { id: "m", name: "Mail", canonical_domain: "mail.ru", tier: "monitored" }))
      .toBeNull();
  });

  it("an existing rule still wins over the glued rule", () => {
    const cat: BrandRow[] = [...CAT, mon("Meeting Hub", "meetinghub.com", "b_mh")];
    expect(fuzzyMatchBrand(["zoom-login.com"], cat)).toBe("b_zoom"); // token
  });

  it("#1823 negatives stay negative: IdP-lure leftovers remain whole-token only", () => {
    const idp: BrandRow[] = [
      mon("Okta", "okta.com", "b_okta"), mon("Microsoft", "microsoft.com", "b_ms"),
      mon("Author", "author.today", "b_author"), mon("Register", "register.com", "b_reg"), ...CAT,
    ];
    expect(fuzzyMatchBrand(["login.o365.teams-microsoftonline-com-common-oauth2-v2-0-authorize-login.com"], idp)).toBe("b_ms");
    expect(fuzzyMatchBrand(["register.microsoftonline-p-int.com"], idp)).toBe("b_ms");
    expect(fuzzyMatchBrand(["helpscout-okta.com"], idp)).toBe("b_okta");
    // A glued leftover beside an IdP lure is not evidence for the glued rule.
    expect(fuzzyMatchBrand(["invitationzoommeetings-okta.com"], idp)).toBe("b_okta");
  });
});
