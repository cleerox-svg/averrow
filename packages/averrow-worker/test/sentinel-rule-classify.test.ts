/**
 * Sentinel's sole classifier after AI_STRATEGY_2026-10 Phase 1 (Batch B):
 * `ruleBasedClassify`. Pure function — confidence by source feed, severity
 * by threat type, plus the credential-path escalation for brand-matched
 * URLs.
 */
import { describe, it, expect } from "vitest";
import {
  ruleBasedClassify, hasCredentialPathToken, urlPathAndQuery, CREDENTIAL_PATH_TOKENS,
} from "../src/agents/sentinel";

describe("ruleBasedClassify — confidence by source_feed", () => {
  it.each([
    ["phishtank", 90], ["threatfox", 90], ["feodo", 90], ["sslbl", 90], ["malwarebazaar", 90], ["cisa_iran_iocs", 90],
    ["urlhaus", 80], ["openphish", 80], ["phishing_database", 80], ["phishstats", 80],
    ["tweetfeed", 70], ["mastodon_ioc", 70], ["otx_alienvault", 70], ["digitalside_osint", 70], ["circl_osint", 70], ["urlscanio", 70],
    ["ct_logs", 50], ["typosquat_scanner", 50], ["nrd_hagezi", 50],
    ["dshield", 60], ["blocklist_de", 60], ["some_new_feed", 60],
  ])("%s with a known type → %i", (feed, expected) => {
    expect(ruleBasedClassify({ sourceFeed: feed, threatType: "phishing" }).confidence).toBe(expected);
  });

  it.each([
    ["phishtank", null, 80],
    ["phishtank", "unknown", 80],
    ["some_new_feed", "unknown", 50],
    // −10 would take these to 40; the floor is 40 so they land exactly on it.
    ["ct_logs", null, 40],
    ["nrd_hagezi", "unknown", 40],
  ] as const)("%s / threat_type=%s → %i (−10 for an unknown type, floor 40)", (feed, type, expected) => {
    expect(ruleBasedClassify({ sourceFeed: feed, threatType: type }).confidence).toBe(expected);
  });

  it("never drops below the floor", () => {
    for (const feed of ["ct_logs", "typosquat_scanner", "nrd_hagezi", "x"]) {
      expect(ruleBasedClassify({ sourceFeed: feed, threatType: null }).confidence).toBeGreaterThanOrEqual(40);
    }
  });
});

describe("ruleBasedClassify — severity by threat_type", () => {
  it.each([
    ["c2", "critical"], ["botnet", "critical"],
    ["malware_distribution", "high"], ["credential_harvesting", "high"],
    ["phishing", "medium"], ["impersonation", "medium"], ["typosquatting", "medium"],
    ["malicious_ip", "low"], ["scanning", "low"],
    ["unknown", "medium"], [null, "medium"], ["something_else", "medium"],
  ] as const)("%s → %s", (type, expected) => {
    expect(ruleBasedClassify({ sourceFeed: "urlhaus", threatType: type }).severity).toBe(expected);
  });

  it("feodo is critical whatever the type says", () => {
    expect(ruleBasedClassify({ sourceFeed: "feodo", threatType: "malicious_ip" }).severity).toBe("critical");
    expect(ruleBasedClassify({ sourceFeed: "feodo", threatType: null }).severity).toBe("critical");
  });
});

describe("ruleBasedClassify — credential-path escalation", () => {
  const phish = (url: string | null, brandMatched: boolean) =>
    ruleBasedClassify({ sourceFeed: "openphish", threatType: "phishing", maliciousUrl: url, brandMatched });

  it.each([...CREDENTIAL_PATH_TOKENS])("token %s in the path of a brand-matched URL raises medium → high", (token) => {
    const r = phish(`https://paypa1-help.com/${token}/step1`, true);
    expect(r.severity).toBe("high");
    expect(r.credentialPathEscalated).toBe(true);
  });

  it("matches in the query string and is case-insensitive", () => {
    expect(phish("https://evil.example/index.php?next=SignIn", true).severity).toBe("high");
    expect(phish("https://evil.example/CONFIRM?step=Verify", true).severity).toBe("high");
  });

  it("handles scheme-less URLs", () => {
    expect(phish("evil.example/wallet/connect", true).severity).toBe("high");
  });

  it("does NOT fire without a brand match", () => {
    const r = phish("https://evil.example/login", false);
    expect(r.severity).toBe("medium");
    expect(r.credentialPathEscalated).toBe(false);
  });

  it("does NOT fire when the token is only in the hostname", () => {
    const r = phish("https://secure-login-paypal.example/", true);
    expect(r.severity).toBe("medium");
    expect(r.credentialPathEscalated).toBe(false);
  });

  it("does NOT fire with no URL or a path without tokens", () => {
    expect(phish(null, true).severity).toBe("medium");
    expect(phish("https://evil.example/download/invoice.pdf", true).severity).toBe("medium");
  });

  it("raises low → high too, but never lowers critical and does not count as an escalation when already high", () => {
    const low = ruleBasedClassify({ sourceFeed: "dshield", threatType: "scanning", maliciousUrl: "http://1.2.3.4/login", brandMatched: true });
    expect(low).toMatchObject({ severity: "high", credentialPathEscalated: true });

    const crit = ruleBasedClassify({ sourceFeed: "threatfox", threatType: "c2", maliciousUrl: "http://evil.example/login", brandMatched: true });
    expect(crit).toMatchObject({ severity: "critical", credentialPathEscalated: false });

    const high = ruleBasedClassify({ sourceFeed: "urlhaus", threatType: "credential_harvesting", maliciousUrl: "http://evil.example/login", brandMatched: true });
    expect(high).toMatchObject({ severity: "high", credentialPathEscalated: false });
  });

  it("leaves confidence untouched", () => {
    expect(phish("https://evil.example/login", true).confidence).toBe(80);
  });
});

describe("urlPathAndQuery / hasCredentialPathToken", () => {
  it("returns only the lowercased path + query", () => {
    expect(urlPathAndQuery("https://Secure.Example/A/B?C=D")).toBe("/a/b?c=d");
    expect(urlPathAndQuery("example.com/x")).toBe("/x");
    expect(urlPathAndQuery("example.com")).toBe("/");
  });

  it("returns empty for an unparseable value", () => {
    expect(urlPathAndQuery("http://")).toBe("");
    expect(hasCredentialPathToken("http://")).toBe(false);
    expect(hasCredentialPathToken(undefined)).toBe(false);
    expect(hasCredentialPathToken("")).toBe(false);
  });
});
