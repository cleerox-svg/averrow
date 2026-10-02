import { describe, it, expect } from "vitest";
import {
  decideAbuseMailboxRulesVerdict,
  primaryRuleFromReason,
  isSharedHost,
  attachmentExtension,
  unwrapRedirectorUrl,
  normalizeMessageUrls,
  runContentDetectors,
  RULES_PROMOTE_CAP,
  type RulesSnapshot,
  type RulesThreatCandidate,
} from "../src/lib/abuse-mailbox-rules";
import {
  matchNamedThreat, matchStrongestNamedThreat,
  type NamedThreatEntry, type NamedThreatMatch,
} from "../src/lib/named-threat-matcher";
import { isSharedHostingHost, isMultiTenantHost, isPlatformTenantHost } from "../src/lib/brandDetect";
import type { DeviceCodeResult } from "../src/lib/device-code-detector";

const NO_DEVICE: DeviceCodeResult = {
  detected: false, technique: null, score: 0, signals: [], legitEndpointUrls: [],
};

function snap(over: Partial<RulesSnapshot> = {}): RulesSnapshot {
  return {
    brand: { id: "brand_acme", canonical_domain: "acme.com" },
    originalFrom: "notify@bad-acme.example",
    urls: [{ url: "https://evil-login.example/verify", domain: "evil-login.example" }],
    attachments: [],
    authResults: null,
    isAttachmentForward: false,
    threatCandidates: [],
    namedThreat: null,
    strongNamedThreat: null,
    strongNamedThreatEntry: null,
    deviceCode: NO_DEVICE,
    ...over,
  };
}

function threat(over: Partial<RulesThreatCandidate> = {}): RulesThreatCandidate {
  return {
    id: "t1",
    malicious_url: "https://evil-login.example/other-path",
    malicious_domain: "evil-login.example",
    source_feed: "openphish",
    status: "active",
    vt_malicious: 0,
    gsb_flagged: 0,
    ...over,
  };
}

function named(reasons: string[], over: Partial<NamedThreatMatch> = {}): NamedThreatMatch {
  return {
    id: "nt_kit", name: "Kit", category: "phaas",
    technique: "aitm_phishing", severity: "high", score: 1, reasons, ...over,
  };
}

function entry(over: Partial<NamedThreatEntry> = {}): NamedThreatEntry {
  return {
    id: "nt_kit", name: "Kit", aliases: [], category: "phaas",
    technique: "aitm_phishing", severity: "high",
    keyword_signatures: [], regex_signatures: [],
    ioc_domains: [], ioc_urls: [], ioc_ips: [], ...over,
  };
}

/** The real seeded Kali365 entry shape (migration 0204). */
const KALI365: NamedThreatEntry = entry({
  id: "nt_kali365", name: "Kali365", technique: "device_code_phishing",
  keyword_signatures: ["device code", "devicelogin", "microsoft 365", "office 365", "enter the code", "outlook", "teams"],
  regex_signatures: [/microsoft\.com\/devicelogin/i, /aka\.ms\/devicelogin/i],
});

describe("decideAbuseMailboxRulesVerdict — M1 intel correlation", () => {
  it("domain listed by a domain-level phishing feed → phishing HIGH takedown @90; domain match never promotes", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ threatCandidates: [threat()] }));
    expect(v.kind).toBe("malicious");
    if (v.kind !== "malicious") return;
    expect(v).toMatchObject({
      primaryRule: "M1", classification: "phishing", severity: "HIGH",
      action: "takedown", confidence: 90,
    });
    expect(v.qualifyingThreatIds).toEqual(["t1"]);
    expect(v.reasonCodes[0]).toBe("m1_intel_correlation:1");
    expect(v.promoteUrls).toEqual([]);
  });

  it("escalates (not takedown) when the message is not brand-bound", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ brand: null, threatCandidates: [threat()] }));
    expect(v.kind === "malicious" && v.action).toBe("escalate");
  });

  it("domain match corroborated by VT or GSB from a non-phishing feed qualifies", () => {
    for (const t of [threat({ source_feed: "ct_logs", vt_malicious: 3 }), threat({ source_feed: "ct_logs", gsb_flagged: 1 })]) {
      expect(decideAbuseMailboxRulesVerdict(snap({ threatCandidates: [t] })).kind).toBe("malicious");
    }
  });

  it("uncorroborated domain match → review with exactly one intel code", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ threatCandidates: [threat({ source_feed: "ct_logs" })] }));
    expect(v.kind).toBe("review");
    expect(v.reasonCodes).toContain("intel_match_unqualified");
    expect(v.reasonCodes).not.toContain("no_intel_match");
  });

  it("NEGATIVE: urlhaus / threatfox never count at domain level", () => {
    for (const feed of ["urlhaus", "threatfox"]) {
      const v = decideAbuseMailboxRulesVerdict(snap({ threatCandidates: [threat({ source_feed: feed })] }));
      expect(v.kind).toBe("review");
    }
  });

  it("exact urlhaus URL → M1 and promotes exactly that URL only", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [
        { url: "https://evil-login.example/verify", domain: "evil-login.example" },
        { url: "https://evil-login.example/other", domain: "evil-login.example" },
        { url: "https://unrelated.example/x", domain: "unrelated.example" },
      ],
      threatCandidates: [threat({ source_feed: "urlhaus", malicious_url: "https://evil-login.example/verify" })],
    }));
    expect(v.kind).toBe("malicious");
    if (v.kind !== "malicious") return;
    expect(v.primaryRule).toBe("M1");
    expect(v.promoteUrls).toEqual(["https://evil-login.example/verify"]);
  });

  it("NEGATIVE: github.com link + urlhaus domain row → review, no promotion", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [{ url: "https://github.com/someone/project", domain: "github.com" }],
      threatCandidates: [threat({
        source_feed: "urlhaus", malicious_domain: "github.com",
        malicious_url: "https://github.com/attacker/payload/releases/download/x.exe",
      })],
    }));
    expect(v.kind).toBe("review");
    // even an openphish / VT-corroborated row on github.com stays review
    const v2 = decideAbuseMailboxRulesVerdict(snap({
      urls: [{ url: "https://github.com/someone/project", domain: "github.com" }],
      threatCandidates: [threat({ source_feed: "openphish", malicious_domain: "github.com",
        malicious_url: "https://github.com/attacker/kit", vt_malicious: 4 })],
    }));
    expect(v2.kind).toBe("review");
  });

  it("platform TENANT subdomain listed by openphish (x.pages.dev) → M1", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [{ url: "https://acme-login.pages.dev/session", domain: "acme-login.pages.dev" }],
      threatCandidates: [threat({
        malicious_domain: "acme-login.pages.dev", malicious_url: "https://acme-login.pages.dev/",
      })],
    }));
    expect(v.kind === "malicious" && v.primaryRule).toBe("M1");
  });

  it("NEGATIVE: an abuse_mailbox-sourced threat never counts (no self-reinforcement)", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      threatCandidates: [threat({ source_feed: "abuse_mailbox", malicious_url: "https://evil-login.example/verify" })],
    }));
    expect(v.kind).toBe("review");
  });

  it("NEGATIVE: an inactive threat never counts", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ threatCandidates: [threat({ status: "down" })] }));
    expect(v.kind).toBe("review");
  });

  it("NEGATIVE: domain-level match on shared hosting never counts", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [{ url: "https://docs.google.com/forms/d/legit", domain: "docs.google.com" }],
      threatCandidates: [threat({
        malicious_domain: "docs.google.com",
        malicious_url: "https://docs.google.com/forms/d/attacker",
        vt_malicious: 9,
      })],
    }));
    expect(v.kind).toBe("review");
  });

  it("an exact URL match on shared hosting still counts, and promotes only that URL", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [
        { url: "https://docs.google.com/forms/d/attacker", domain: "docs.google.com" },
        { url: "https://docs.google.com/forms/d/innocent", domain: "docs.google.com" },
      ],
      threatCandidates: [threat({
        malicious_domain: "docs.google.com",
        malicious_url: "https://docs.google.com/forms/d/attacker",
      })],
    }));
    expect(v.kind).toBe("malicious");
    if (v.kind !== "malicious") return;
    expect(v.promoteUrls).toEqual(["https://docs.google.com/forms/d/attacker"]);
  });

  it("NEGATIVE: the brand's own canonical domain never counts", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [{ url: "https://login.acme.com/reset", domain: "login.acme.com" }],
      threatCandidates: [threat({
        malicious_domain: "login.acme.com",
        malicious_url: "https://login.acme.com/reset",
        vt_malicious: 5,
      })],
    }));
    expect(v.kind).toBe("review");
  });

  it("NEGATIVE: a brand safe domain (lib/safeDomains wildcard) never counts and is never promoted", () => {
    const safe = new Set(["*.acme-cdn.example"]);
    const v = decideAbuseMailboxRulesVerdict(snap({
      safeDomains: safe,
      urls: [{ url: "https://img.acme-cdn.example/a.png", domain: "img.acme-cdn.example" }],
      threatCandidates: [threat({
        malicious_domain: "img.acme-cdn.example", malicious_url: "https://img.acme-cdn.example/a.png",
      })],
    }));
    expect(v.kind).toBe("review");
  });

  it("safelinks-wrapped URL is unwrapped before exact matching and promotion", () => {
    const wrapped = "https://nam12.safelinks.protection.outlook.com/?url=" +
      encodeURIComponent("https://evil-login.example/verify") + "&data=05%7C02&reserved=0";
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [{ url: wrapped, domain: "nam12.safelinks.protection.outlook.com" }],
      threatCandidates: [threat({ source_feed: "urlhaus", malicious_url: "https://evil-login.example/verify" })],
    }));
    expect(v.kind).toBe("malicious");
    if (v.kind !== "malicious") return;
    expect(v.promoteUrls).toEqual(["https://evil-login.example/verify"]);
  });

  it("caps promotion at RULES_PROMOTE_CAP and promotes only exact matches", () => {
    const urls = [
      { url: "https://unrelated.example/x", domain: "unrelated.example" },
      ...Array.from({ length: 30 }, (_, i) => ({ url: `https://evil-login.example/p${i}`, domain: "evil-login.example" })),
    ];
    const threatCandidates = Array.from({ length: 30 }, (_, i) =>
      threat({ id: `t${i}`, source_feed: "urlhaus", malicious_url: `https://evil-login.example/p${i}` }));
    const v = decideAbuseMailboxRulesVerdict(snap({ urls, threatCandidates }));
    if (v.kind !== "malicious") throw new Error("expected malicious");
    expect(v.promoteUrls).toHaveLength(RULES_PROMOTE_CAP);
    expect(v.promoteUrls.every((u) => u.startsWith("https://evil-login.example/p"))).toBe(true);
  });
});

describe("unwrapRedirectorUrl / normalizeMessageUrls", () => {
  it("unwraps Outlook safelinks, Proofpoint v2/v3, google.com/url, l.facebook.com", () => {
    const target = "https://evil-login.example/verify?a=1";
    expect(unwrapRedirectorUrl(
      `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(target)}&data=x`)).toBe(target);
    expect(unwrapRedirectorUrl(
      "https://urldefense.proofpoint.com/v2/url?u=https-3A__evil-2Dlogin.example_verify&d=DwM&c=x")).toBe(
      "https://evil-login.example/verify");
    expect(unwrapRedirectorUrl(
      "https://urldefense.com/v3/__https://evil-login.example/verify__;!!ABC!xyz$")).toBe(
      "https://evil-login.example/verify");
    expect(unwrapRedirectorUrl(`https://www.google.com/url?q=${encodeURIComponent(target)}&sa=D`)).toBe(target);
    expect(unwrapRedirectorUrl(`https://l.facebook.com/l.php?u=${encodeURIComponent(target)}&h=x`)).toBe(target);
  });
  it("leaves non-wrappers and non-http targets alone", () => {
    expect(unwrapRedirectorUrl("https://evil-login.example/x")).toBe("https://evil-login.example/x");
    expect(unwrapRedirectorUrl("https://www.google.com/url?q=javascript:alert(1)")).toBe(
      "https://www.google.com/url?q=javascript:alert(1)");
  });
  it("recomputes the host of an unwrapped URL and dedupes", () => {
    const wrapped = `https://x.safelinks.protection.outlook.com/?url=${encodeURIComponent("https://evil.example/a")}`;
    expect(normalizeMessageUrls([
      { url: wrapped, domain: "x.safelinks.protection.outlook.com" },
      { url: "https://evil.example/a", domain: "evil.example" },
    ])).toEqual([{ url: "https://evil.example/a", domain: "evil.example" }]);
  });
});

describe("shared-host semantics (brandDetect)", () => {
  it("platform TENANT subdomains are not shared; the platform apex is", () => {
    for (const h of ["x.pages.dev", "x.workers.dev", "x.netlify.app", "x.web.app", "x.duckdns.org", "victim-login.github.io", "bucket.s3.amazonaws.com"]) {
      expect(isPlatformTenantHost(h)).toBe(true);
      expect(isSharedHostingHost(h)).toBe(false);
      expect(isSharedHost(h)).toBe(false);
    }
    for (const h of ["pages.dev", "workers.dev", "duckdns.org", "s3.amazonaws.com", "ipfs.io"]) {
      expect(isSharedHostingHost(h)).toBe(true);
      expect(isSharedHost(h)).toBe(true);
    }
  });
  it("multi-tenant / redirector hosts (and subdomains) are shared", () => {
    for (const h of [
      "github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "gist.github.com",
      "gitlab.com", "bitbucket.org", "cdn.discordapp.com", "media.discordapp.net", "mediafire.com",
      "pastebin.com", "nam12.safelinks.protection.outlook.com", "urldefense.com",
      "urldefense.proofpoint.com", "l.facebook.com", "lm.facebook.com", "t.co", "lnkd.in",
      "google.com", "www.google.com", "drive.google.com", "x.sharepoint.com",
    ]) {
      expect(isMultiTenantHost(h)).toBe(true);
    }
    expect(isSharedHost("evil-login.example")).toBe(false);
  });
});

describe("decideAbuseMailboxRulesVerdict — M2 named threat", () => {
  it("IOC-domain strong match → phishing HIGH escalate; a domain IOC never promotes", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [
        { url: "https://kit-relay.example/a", domain: "kit-relay.example" },
        { url: "https://other.example/b", domain: "other.example" },
      ],
      strongNamedThreat: named(["ioc_domain:kit-relay.example"]),
      strongNamedThreatEntry: entry({ ioc_domains: ["kit-relay.example"] }),
    }));
    expect(v.kind).toBe("malicious");
    if (v.kind !== "malicious") return;
    expect(v).toMatchObject({ primaryRule: "M2", classification: "phishing", severity: "HIGH", action: "escalate" });
    expect(v.promoteUrls).toEqual([]);
  });

  it("IOC-url strong match promotes exactly that URL", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [{ url: "https://kit-relay.example/a", domain: "kit-relay.example" }],
      strongNamedThreat: named(["ioc_url"]),
      strongNamedThreatEntry: entry({ ioc_urls: ["https://kit-relay.example/a"] }),
    }));
    expect(v.kind === "malicious" && v.promoteUrls).toEqual(["https://kit-relay.example/a"]);
  });

  it("regex signature on a non-device-code entry qualifies", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ strongNamedThreat: named(["regex"]), strongNamedThreatEntry: entry() }));
    expect(v.kind === "malicious" && v.primaryRule).toBe("M2");
  });

  it("NEGATIVE: regex on a device_code_phishing entry does not count for M2", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      strongNamedThreat: named(["regex"], { id: "nt_kali365", technique: "device_code_phishing" }),
      strongNamedThreatEntry: KALI365,
    }));
    expect(v.kind).toBe("review");
  });

  it("NEGATIVE: IP-only IOC hit does not qualify", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      strongNamedThreat: named(["ioc_ip:203.0.113.9"]), strongNamedThreatEntry: entry({ ioc_ips: ["203.0.113.9"] }),
    }));
    expect(v.kind).toBe("review");
  });

  it("NEGATIVE: keyword-only (technique + keywords) named match → review", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      namedThreat: named(["technique:device_code_phishing", "keyword:kali", "keyword:365"]),
    }));
    expect(v.kind).toBe("review");
    expect(v.reasonCodes).toContain("named_threat_weak");
  });

  it("microsoft.com/devicelogin endpoint-only message via the REAL detectors → review", () => {
    const urls = [{ url: "https://microsoft.com/devicelogin", domain: "microsoft.com" }];
    const det = runContentDetectors([KALI365], {
      subject: "Shared document from Teams",
      body: "Open https://microsoft.com/devicelogin to view the file in Microsoft 365.",
      urls,
      senderIp: null,
    });
    expect(det.namedThreat?.id).toBe("nt_kali365");       // telemetry still names it
    expect(det.strongNamedThreat).toBeNull();               // but not as strong evidence
    const v = decideAbuseMailboxRulesVerdict(snap({ urls, ...det }));
    expect(v.kind).toBe("review");
    if (v.kind !== "review") return;
    expect(v.reasonCodes).toContain("named_threat_weak");
  });
});

describe("matchStrongestNamedThreat", () => {
  const keywordHeavy = entry({
    id: "nt_kw", name: "Keywordy", technique: "device_code_phishing",
    keyword_signatures: ["device code", "enter the code", "microsoft 365", "outlook", "teams", "onedrive"],
  });
  const iocEntry = entry({ id: "nt_ioc", name: "IocKit", ioc_domains: ["kit-relay.example"] });
  const candidate = {
    subject: "Enter the code — Microsoft 365 / Outlook / Teams / OneDrive device code",
    body: "Use https://kit-relay.example/a",
    urls: [{ url: "https://kit-relay.example/a", domain: "kit-relay.example" }],
    ips: ["203.0.113.9"],
    technique: "device_code_phishing",
  };

  it("ranks an IOC entry ahead of a keyword-heavy entry (matchNamedThreat behaviour unchanged)", () => {
    expect(matchStrongestNamedThreat([keywordHeavy, iocEntry], candidate)?.id).toBe("nt_ioc");
    // the general matcher still scores by raw total; unchanged for other callers
    expect(matchNamedThreat([keywordHeavy, iocEntry], candidate)?.id).toBe("nt_ioc");
  });

  it("ignores IP-only hits, device-code regex hits, and ignored (multi-tenant) domains", () => {
    expect(matchStrongestNamedThreat([entry({ ioc_ips: ["203.0.113.9"] })], candidate)).toBeNull();
    expect(matchStrongestNamedThreat([KALI365], { body: "go to microsoft.com/devicelogin" })).toBeNull();
    expect(matchStrongestNamedThreat(
      [entry({ ioc_domains: ["github.com"] })],
      { urls: [{ url: "https://github.com/x", domain: "github.com" }] },
      { ignoreDomain: isSharedHost },
    )).toBeNull();
  });
});

describe("decideAbuseMailboxRulesVerdict — M3 device code", () => {
  const dc = (score: number): DeviceCodeResult => ({
    detected: true, technique: "device_code_phishing", score,
    signals: ["device_login_endpoint"], legitEndpointUrls: ["https://microsoft.com/devicelogin"],
  });

  it("score >= 0.85 → phishing HIGH; never promotes (incl. the legit Microsoft endpoint)", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [{ url: "https://microsoft.com/devicelogin", domain: "microsoft.com" }],
      deviceCode: dc(0.9),
    }));
    expect(v.kind).toBe("malicious");
    if (v.kind !== "malicious") return;
    expect(v).toMatchObject({ primaryRule: "M3", classification: "phishing", severity: "HIGH" });
    expect(v.promoteUrls).toEqual([]);
  });

  it("NEGATIVE: the softer 0.6 fallback → review", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ deviceCode: dc(0.6) }));
    expect(v.kind).toBe("review");
    expect(v.reasonCodes).toContain("device_code_weak");
  });
});

describe("decideAbuseMailboxRulesVerdict — M4 attachments", () => {
  it.each([".exe", ".iso", ".lnk", ".js", ".vhdx", ".ps1"])("%s → malware CRITICAL", (ext) => {
    const v = decideAbuseMailboxRulesVerdict(snap({ attachments: [{ filename: `invoice${ext}`, mime_type: null }] }));
    expect(v.kind).toBe("malicious");
    if (v.kind !== "malicious") return;
    expect(v).toMatchObject({ primaryRule: "M4", classification: "malware", severity: "CRITICAL" });
    expect(v.promoteUrls).toEqual([]); // attachment alone says nothing about the links
  });

  it("double extension resolves to the last one", () => {
    expect(attachmentExtension("Invoice.PDF.exe")).toBe(".exe");
    const v = decideAbuseMailboxRulesVerdict(snap({ attachments: [{ filename: "Invoice.PDF.exe", mime_type: null }] }));
    expect(v.kind).toBe("malicious");
  });

  it("NEGATIVE: documents, forwarded .eml and '.com'-ending filenames do not fire", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      attachments: [
        { filename: "report.pdf", mime_type: "application/pdf" },
        { filename: "forwarded-message-1.eml", mime_type: "message/rfc822" },
        { filename: "Your order from amazon.com", mime_type: "text/html" },
      ],
    }));
    expect(v.kind).toBe("review");
  });

  it("M4 leads when combined with exact-URL M1; M1 still drives takedown + promotion", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      attachments: [{ filename: "a.scr", mime_type: null }],
      threatCandidates: [threat({ source_feed: "urlhaus", malicious_url: "https://evil-login.example/verify" })],
    }));
    if (v.kind !== "malicious") throw new Error("expected malicious");
    expect(v.primaryRule).toBe("M4");
    expect(v.firedRules).toEqual(["M4", "M1"]);
    expect(v.action).toBe("takedown");
    expect(v.promoteUrls).toEqual(["https://evil-login.example/verify"]);
    expect(primaryRuleFromReason(v.reasonCodes.join(","))).toBe("M4");
  });
});

describe("decideAbuseMailboxRulesVerdict — review", () => {
  it("no evidence → ambiguous / MEDIUM / review with fixed codes; never benign or spam", () => {
    const v = decideAbuseMailboxRulesVerdict(snap());
    expect(v).toMatchObject({ kind: "review", classification: "ambiguous", severity: "MEDIUM", action: "review" });
    expect(v.reasonCodes).toContain("no_intel_match");
    expect(v.reasonCodes).not.toContain("intel_match_unqualified");
    expect(primaryRuleFromReason(v.reasonCodes.join(","))).toBe("review");
  });

  it("never emits benign/spam across a sweep of inputs", () => {
    const inputs: Partial<RulesSnapshot>[] = [
      {}, { urls: [] }, { brand: null },
      { authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, isAttachmentForward: true },
      { threatCandidates: [threat({ status: "down" })] },
    ];
    for (const i of inputs) {
      const v = decideAbuseMailboxRulesVerdict(snap(i));
      expect(["phishing", "malware", "ambiguous"]).toContain(v.classification);
    }
  });

  it("auth failure only counts on a forward-as-attachment, and only pushes to review", () => {
    const failing = { spf: "fail", dkim: "fail", dmarc: "fail" };
    const inline = decideAbuseMailboxRulesVerdict(snap({ authResults: failing, isAttachmentForward: false }));
    expect(inline.reasonCodes).not.toContain("dmarc_fail");
    const attached = decideAbuseMailboxRulesVerdict(snap({ authResults: failing, isAttachmentForward: true }));
    expect(attached.kind).toBe("review");
    expect(attached.reasonCodes).toEqual(expect.arrayContaining(["dmarc_fail", "spf_fail", "dkim_fail"]));
  });

  it("from-domain typosquat of the brand is a review reason code", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ originalFrom: "billing@acme-secure-update.com" }));
    expect(v.kind).toBe("review");
    expect(v.reasonCodes).toContain("from_typosquat:brand_acme");
  });
});
