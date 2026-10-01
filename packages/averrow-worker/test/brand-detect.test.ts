import { describe, it, expect } from "vitest";
import {
  fuzzyMatchBrand,
  fuzzyMatchBrandDetailed,
  matchBrandToHost,
  keywordMatchesHost,
  hostOf,
  isGenericBrand,
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
    ["paypalsecure-verify.net", "brand_paypal_com", "token"],
    ["mypaypalcheckout.com", "brand_paypal_com", "substring"],
    ["paypa1-login.com", "brand_paypal_com", "levenshtein"],
    ["docusign-verify.net", "brand_docusign_com", "token"],
    ["docusigm.com", "brand_docusign_com", "levenshtein"],
    ["microsoft365-login.co.uk", "brand_microsoft_com", "substring"],
    ["kick-login.com", "brand_kick_com", "token"],
    ["kicklogin.com", "brand_kick_com", "token"],
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
