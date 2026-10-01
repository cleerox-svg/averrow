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
