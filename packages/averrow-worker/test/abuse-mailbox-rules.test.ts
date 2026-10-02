import { describe, it, expect } from "vitest";
import {
  decideAbuseMailboxRulesVerdict,
  primaryRuleFromReason,
  isSharedHost,
  attachmentExtension,
  RULES_PROMOTE_CAP,
  type RulesSnapshot,
  type RulesThreatCandidate,
} from "../src/lib/abuse-mailbox-rules";
import type { NamedThreatEntry, NamedThreatMatch } from "../src/lib/named-threat-matcher";
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
    namedThreatEntry: null,
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
    id: "nt_kali365", name: "Kali365", category: "phishing_kit",
    technique: "device_code_phishing", severity: "critical", score: 1, reasons, ...over,
  };
}

function entry(over: Partial<NamedThreatEntry> = {}): NamedThreatEntry {
  return {
    id: "nt_kali365", name: "Kali365", aliases: [], category: "phishing_kit",
    technique: "device_code_phishing", severity: "critical",
    keyword_signatures: [], regex_signatures: [],
    ioc_domains: [], ioc_urls: [], ioc_ips: [], ...over,
  };
}

describe("decideAbuseMailboxRulesVerdict — M1 intel correlation", () => {
  it("domain match from a curated feed → phishing HIGH takedown @90 (brand-bound)", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ threatCandidates: [threat()] }));
    expect(v.kind).toBe("malicious");
    if (v.kind !== "malicious") return;
    expect(v).toMatchObject({
      primaryRule: "M1", classification: "phishing", severity: "HIGH",
      action: "takedown", confidence: 90,
    });
    expect(v.qualifyingThreatIds).toEqual(["t1"]);
    expect(v.reasonCodes[0]).toBe("m1_intel_correlation:1");
    expect(v.promoteUrls).toEqual(["https://evil-login.example/verify"]);
  });

  it("escalates (not takedown) when the message is not brand-bound", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ brand: null, threatCandidates: [threat()] }));
    expect(v.kind === "malicious" && v.action).toBe("escalate");
  });

  it("domain match corroborated by VT or GSB from a non-curated feed qualifies", () => {
    for (const t of [threat({ source_feed: "ct_logs", vt_malicious: 3 }), threat({ source_feed: "ct_logs", gsb_flagged: 1 })]) {
      expect(decideAbuseMailboxRulesVerdict(snap({ threatCandidates: [t] })).kind).toBe("malicious");
    }
  });

  it("uncorroborated domain match (non-curated feed, no VT/GSB) → review", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ threatCandidates: [threat({ source_feed: "ct_logs" })] }));
    expect(v.kind).toBe("review");
    expect(v.reasonCodes).toContain("intel_match_unqualified");
  });

  it("exact URL match qualifies even without corroboration", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      threatCandidates: [threat({ source_feed: "ct_logs", malicious_url: "https://evil-login.example/verify" })],
    }));
    expect(v.kind).toBe("malicious");
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
    // a tenant subdomain of a platform suffix is shared hosting too
    expect(isSharedHost("victim-login.github.io")).toBe(true);
    expect(isSharedHost("pages.dev")).toBe(true);
    expect(isSharedHost("evil-login.example")).toBe(false);
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

  it("promotes only URLs on matched domains and caps at RULES_PROMOTE_CAP", () => {
    const urls = [
      { url: "https://unrelated.example/x", domain: "unrelated.example" },
      ...Array.from({ length: 30 }, (_, i) => ({ url: `https://evil-login.example/p${i}`, domain: "evil-login.example" })),
    ];
    const v = decideAbuseMailboxRulesVerdict(snap({ urls, threatCandidates: [threat()] }));
    if (v.kind !== "malicious") throw new Error("expected malicious");
    expect(v.promoteUrls).toHaveLength(RULES_PROMOTE_CAP);
    expect(v.promoteUrls.every((u) => u.startsWith("https://evil-login.example/"))).toBe(true);
  });
});

describe("decideAbuseMailboxRulesVerdict — M2 named threat", () => {
  it("IOC-domain named match → phishing HIGH escalate, promotes the IOC-domain URLs", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      urls: [
        { url: "https://kali-relay.example/a", domain: "kali-relay.example" },
        { url: "https://other.example/b", domain: "other.example" },
      ],
      namedThreat: named(["ioc_domain:kali-relay.example"]),
      namedThreatEntry: entry({ ioc_domains: ["kali-relay.example"] }),
    }));
    expect(v.kind).toBe("malicious");
    if (v.kind !== "malicious") return;
    expect(v).toMatchObject({ primaryRule: "M2", classification: "phishing", severity: "HIGH", action: "escalate" });
    expect(v.promoteUrls).toEqual(["https://kali-relay.example/a"]);
  });

  it("regex signature match qualifies", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({ namedThreat: named(["regex"]), namedThreatEntry: entry() }));
    expect(v.kind === "malicious" && v.primaryRule).toBe("M2");
  });

  it("NEGATIVE: keyword-only (technique + keywords) named match → review", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      namedThreat: named(["technique:device_code_phishing", "keyword:kali", "keyword:365"]),
      namedThreatEntry: entry(),
    }));
    expect(v.kind).toBe("review");
    expect(v.reasonCodes).toContain("named_threat_weak");
  });
});

describe("decideAbuseMailboxRulesVerdict — M3 device code", () => {
  const dc = (score: number): DeviceCodeResult => ({
    detected: true, technique: "device_code_phishing", score,
    signals: ["device_login_endpoint"], legitEndpointUrls: ["https://microsoft.com/devicelogin"],
  });

  it("score >= 0.85 → phishing HIGH; never promotes the legit Microsoft endpoint", () => {
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

  it("NEGATIVE: documents and forwarded .eml do not fire", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      attachments: [{ filename: "report.pdf", mime_type: "application/pdf" }, { filename: "forwarded-message-1.eml", mime_type: "message/rfc822" }],
    }));
    expect(v.kind).toBe("review");
  });

  it("M4 leads when combined with M1, but M1 still drives takedown + promotion", () => {
    const v = decideAbuseMailboxRulesVerdict(snap({
      attachments: [{ filename: "a.scr", mime_type: null }],
      threatCandidates: [threat()],
    }));
    if (v.kind !== "malicious") throw new Error("expected malicious");
    expect(v.primaryRule).toBe("M4");
    expect(v.firedRules).toEqual(["M4", "M1"]);
    expect(v.action).toBe("takedown");
    expect(v.promoteUrls).toHaveLength(1);
    expect(primaryRuleFromReason(v.reasonCodes.join(","))).toBe("M4");
  });
});

describe("decideAbuseMailboxRulesVerdict — review", () => {
  it("no evidence → ambiguous / MEDIUM / review with fixed codes; never benign or spam", () => {
    const v = decideAbuseMailboxRulesVerdict(snap());
    expect(v).toMatchObject({ kind: "review", classification: "ambiguous", severity: "MEDIUM", action: "review" });
    expect(v.reasonCodes).toContain("no_intel_match");
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
