import { describe, it, expect } from "vitest";
import {
  scoreAbuseHeuristics, suspectPortion, H1_SCORE_THRESHOLD, H1_CONFIDENCE_MAX,
  type HeuristicInput,
} from "../src/lib/abuse-mailbox-heuristics";
import { decideAbuseMailboxRulesVerdict, primaryRuleFromReason, type RulesSnapshot } from "../src/lib/abuse-mailbox-rules";

function input(over: Partial<HeuristicInput> = {}): HeuristicInput {
  return {
    senderEmail: null,
    subject: null,
    bodyText: null,
    urls: [],
    attachments: [],
    brand: null,
    safeDomains: null,
    authResults: null,
    isAttachmentForward: false,
    ...over,
  };
}

const codes = (r: ReturnType<typeof scoreAbuseHeuristics>) => r.signals.map((s) => s.code);

describe("scoreAbuseHeuristics — the 2026-10-03 test lures", () => {
  it("MEGA 'account has been locked' from a non-MEGA sender with an off-brand link", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "support@mega-notice.example",
      subject: "Your MEGA account has been locked",
      bodyText: "We have locked your account due to unusual activity. Verify your account to restore access.",
      urls: [{ url: "https://mega-restore.top/verify", host: "mega-restore.top" }],
      brand: { id: "brand_mega", canonical_domain: "mega.nz" },
    }));
    expect(r.fired).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(["lure_account_locked", "link_abused_tld"]));
  });

  it("'LAST ALERT: your photos and videos will be deleted' storage scam", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "noreply@cloud-alerts.example",
      subject: "LAST ALERT: cleerox, Your Photos and Videos Will Be Deleted",
      bodyText: "Your storage is full. Your photos and videos will be deleted. Upgrade now.",
      urls: [{ url: "https://storage-upgrade.pages.dev/", host: "storage-upgrade.pages.dev" }],
    }));
    expect(r.fired).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(["lure_data_deletion", "lure_urgency", "link_free_hosting"]));
  });

  it("'We've blocked your account' with a raw-IP link", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "alerts@secure-notice.example",
      subject: "We've blocked your account! 🚫",
      urls: [{ url: "http://203.0.113.50/restore", host: "203.0.113.50" }],
    }));
    expect(r.fired).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(["lure_account_locked", "link_raw_ip"]));
  });
});

describe("scoreAbuseHeuristics — gating", () => {
  it("one loud family alone never fires (lure only)", () => {
    const r = scoreAbuseHeuristics(input({
      subject: "URGENT: account suspended, payment failed, verify your password immediately",
    }));
    expect(r.families).toEqual(["lure"]);
    expect(r.fired).toBe(false);
  });

  it("identity + links without any lure or attachment never fires", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "news@acme-billing.example",
      brand: { id: "b", canonical_domain: "acme.com" },
      urls: [{ url: "http://198.51.100.1/x", host: "198.51.100.1" }],
    }));
    expect(r.score).toBeGreaterThanOrEqual(H1_SCORE_THRESHOLD);
    expect(r.families).not.toContain("lure");
    expect(r.fired).toBe(false);
  });

  it("links on the brand's own domain or a safe domain are never signals", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "billing@acme.com",
      subject: "Your payment failed — update your billing details",
      brand: { id: "b", canonical_domain: "acme.com" },
      safeDomains: new Set(["stripe.com", "*.stripe.com"]),
      urls: [
        { url: "https://www.acme.com/billing", host: "www.acme.com" },
        { url: "https://pay.stripe.com/x", host: "pay.stripe.com" },
      ],
    }));
    expect(r.families).toEqual(["lure"]);
    expect(r.fired).toBe(false);
  });

  it("auth failures count only when the headers describe the original sender", () => {
    const auth = { spf: "fail", dkim: "fail", dmarc: "fail" };
    expect(codes(scoreAbuseHeuristics(input({ authResults: auth, isAttachmentForward: false })))).toEqual([]);
    expect(codes(scoreAbuseHeuristics(input({ authResults: auth, isAttachmentForward: true })))).toEqual(["auth_dmarc_fail"]);
  });

  it("an HTML attachment plus a lure fires; executables are left to M4", () => {
    const r = scoreAbuseHeuristics(input({
      subject: "Invoice overdue — payment failed",
      attachments: [{ filename: "Invoice_8812.html" }],
    }));
    expect(codes(r)).toContain("attachment_html");
    expect(r.fired).toBe(true);
    expect(codes(scoreAbuseHeuristics(input({ attachments: [{ filename: "a.exe" }] })))).toEqual([]);
  });

  it("confidence is capped below every evidence rule", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "x@acme-login.top",
      subject: "Final notice: account suspended, payment failed",
      brand: { id: "b", canonical_domain: "acme.com" },
      urls: [{ url: "http://user@203.0.113.9/acme", host: "203.0.113.9" }],
      attachments: [{ filename: "a.svg" }],
      authResults: { spf: "fail", dkim: null, dmarc: "fail" },
      isAttachmentForward: true,
    }));
    expect(r.fired).toBe(true);
    expect(r.confidence).toBeLessThanOrEqual(H1_CONFIDENCE_MAX);
  });
});

describe("decideAbuseMailboxRulesVerdict — H1 tier", () => {
  const base: RulesSnapshot = {
    brand: { id: "brand_mega", canonical_domain: "mega.nz" },
    originalFrom: "support@mega-notice.example",
    subject: "Your MEGA account has been locked",
    bodyText: "Verify your account within 24 hours.",
    urls: [{ url: "https://mega-restore.top/verify", domain: "mega-restore.top" }],
    attachments: [],
    authResults: null,
    isAttachmentForward: false,
    threatCandidates: [],
    namedThreat: null,
    strongNamedThreat: null,
    strongNamedThreatEntry: null,
    deviceCode: { detected: false, technique: null, score: 0, signals: [], legitEndpointUrls: [] },
  };

  it("returns phishing / HIGH / escalate, never promotes, reason parses back to H1", () => {
    const v = decideAbuseMailboxRulesVerdict(base);
    expect(v).toMatchObject({ kind: "malicious", primaryRule: "H1", classification: "phishing", severity: "HIGH", action: "escalate" });
    if (v.kind !== "malicious") throw new Error("unreachable");
    expect(v.promoteUrls).toEqual([]);
    expect(primaryRuleFromReason(v.reasonCodes.join(","))).toBe("H1");
  });

  it("an evidence rule wins over H1 (M4 executable)", () => {
    const v = decideAbuseMailboxRulesVerdict({ ...base, attachments: [{ filename: "x.exe", mime_type: null }] });
    expect(v.kind === "malicious" && v.primaryRule).toBe("M4");
  });

  it("below threshold stays review but records the near-miss score for operators", () => {
    const v = decideAbuseMailboxRulesVerdict({ ...base, originalFrom: null, urls: [], bodyText: null });
    expect(v.kind).toBe("review");
    expect(v.reasonCodes.some((c) => c.startsWith("h1_score:"))).toBe(true);
    expect(primaryRuleFromReason(v.reasonCodes.join(","))).toBe("review");
  });
});

describe("determination email — H1 copy", () => {
  it("says 'Likely phishing', never 'Phishing confirmed', and uses the fixed H1 note", async () => {
    const { vi } = await import("vitest");
    const { sendDetermination, RULES_EMAIL_NOTE } = await import("../src/lib/abuse-mailbox-responder");
    const sent: Array<{ subject: string; html: string; text: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { subject: string; html: string; text: string };
      sent.push(body);
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    });
    try {
      const env = {
        RESEND_API_KEY: "re_test",
        DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      } as unknown as import("../src/types").Env;
      const res = await sendDetermination(env, "reporter@example.org", {
        messageId: "11111111-2222-3333-4444-555555555555",
        inboundAlias: "phishing@averrow.ca",
        originalSubject: "Your MEGA account has been locked",
        classification: "phishing",
        confidence: 66,
        action: "escalate",
        classifiedBy: "rules",
        rulesRule: "H1",
      });
      expect(res.ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toContain("Likely phishing");
      expect(sent[0]!.subject).not.toContain("confirmed");
      expect(sent[0]!.text).toContain(RULES_EMAIL_NOTE.H1);
      expect(sent[0]!.text).not.toMatch(/66%/);   // rules verdicts never show a confidence %
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("scoreAbuseHeuristics — review false-positive cases", () => {
  it("a merchant email with a 'Pay with PayPal' footer link is not a PayPal impostor", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "orders@my-shop.example",
      subject: "Update your payment details",
      bodyText: "Your payment failed. Update your billing details. Pay with PayPal.",
      urls: [{ url: "https://www.paypal.com/checkout", host: "www.paypal.com" }],
      brand: { id: "brand_paypal", canonical_domain: "paypal.com" },
    }));
    expect(codes(r)).not.toContain("sender_not_brand");
    expect(r.fired).toBe(false);
  });

  it("brands' own infrastructure is not a lookalike (amazonaws, microsoftonline)", () => {
    const aws = scoreAbuseHeuristics(input({
      senderEmail: "billing@vendor.example",
      subject: "Invoice: payment failed, update your card",
      urls: [{ url: "https://bucket.s3.amazonaws.com/invoice.pdf", host: "bucket.s3.amazonaws.com" }],
      brand: { id: "brand_amazon", canonical_domain: "amazon.com" },
    }));
    expect(codes(aws)).not.toContain("link_lookalike_domain");
    expect(codes(aws)).not.toContain("link_brand_in_foreign_host");
    expect(codes(aws)).not.toContain("sender_not_brand");
    // A plain invoice notice with an S3 link doesn't fire. (With "payment
    // failed, update your card" it does: lure + anonymous bucket + off-sender
    // link is a real S3-hosted-lure pattern, and it scores exactly 5.)
    const plain = scoreAbuseHeuristics(input({
      senderEmail: "billing@vendor.example",
      subject: "Your invoice is attached",
      urls: [{ url: "https://bucket.s3.amazonaws.com/invoice.pdf", host: "bucket.s3.amazonaws.com" }],
      brand: { id: "brand_amazon", canonical_domain: "amazon.com" },
    }));
    expect(plain.fired).toBe(false);

    const ms = scoreAbuseHeuristics(input({
      senderEmail: "no-reply@microsoftonline.com",
      subject: "New sign-in to your account",
      brand: { id: "brand_ms", canonical_domain: "microsoft.com" },
    }));
    expect(codes(ms)).not.toContain("sender_lookalike_domain");
    expect(ms.fired).toBe(false);
  });

  it("brand-in-foreign-host needs a whole label, not a substring", () => {
    const sub = scoreAbuseHeuristics(input({
      urls: [{ url: "https://purchase.example/x", host: "purchase.example" }],
      brand: { id: "b", canonical_domain: "chase.com" },
    }));
    expect(codes(sub)).not.toContain("link_brand_in_foreign_host");
    const lbl = scoreAbuseHeuristics(input({
      urls: [{ url: "https://chase-verify.example/x", host: "chase-verify.example" }],
      brand: { id: "b", canonical_domain: "chase.com" },
    }));
    expect(codes(lbl)).toContain("link_brand_in_foreign_host");
  });

  it("the reporter's own note above an inline forward is not scored as a lure", () => {
    const r = scoreAbuseHeuristics(input({
      bodyText: [
        "Can you verify this account email is legit? Looks urgent.",
        "",
        "---------- Forwarded message ---------",
        "From: Team <hello@newsletter.example>",
        "Subject: Our autumn newsletter",
        "",
        "Here are this month's product updates.",
      ].join("\n"),
    }));
    expect(r.families).not.toContain("lure");
  });
});

describe("suspectPortion", () => {
  it("cuts at the EARLIEST marker, so a fake marker buried in the phish can't hide its lure", () => {
    const text = [
      "fyi",
      "Begin forwarded message:",
      "Your account is suspended, verify now.",
      "---------- Forwarded message ----------",
      "harmless filler",
    ].join("\n");
    expect(suspectPortion(text)).toContain("Your account is suspended");
  });
});

describe("H1 family points (prod FP 2026-10-03)", () => {
  it("a genuine MEGA notice (mega.nz linking blog.mega.io) does not fire on lure + a lone +1 link signal", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "support@mega.nz",
      subject: "Your MEGA account has been locked",
      bodyText: "We locked your account after suspicious activity. Verify your account to restore access.",
      urls: [{ url: "https://blog.mega.io/what-is-credential-stuffing", host: "blog.mega.io" }],
      brand: { id: "brand_mega", canonical_domain: "mega.nz" },
    }));
    expect(codes(r)).not.toContain("link_brand_in_foreign_host");
    expect(r.families).toEqual(["lure"]);
    expect(r.fired).toBe(false);
  });
});

describe("H1 family points", () => {
  it("a lone +1 link signal is not a second family", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "billing@shop.example",
      subject: "Your account has been suspended — verify your account",
      urls: [{ url: "https://cdn.other.example/x", host: "cdn.other.example" }],
    }));
    expect(codes(r)).toContain("link_sender_mismatch");
    expect(r.score).toBeGreaterThanOrEqual(5);
    expect(r.families).toEqual(["lure"]);
    expect(r.fired).toBe(false);
  });

  it("a spoofer linking the brand's name on another TLD still scores", () => {
    const r = scoreAbuseHeuristics(input({
      senderEmail: "help@secure-notice.example",
      subject: "Your account has been suspended",
      bodyText: "PayPal: verify your account now.",
      urls: [{ url: "https://paypal.help-center.top/x", host: "paypal.help-center.top" }],
      brand: { id: "b", canonical_domain: "paypal.com" },
    }));
    expect(codes(r)).toContain("link_brand_in_foreign_host");
    expect(r.fired).toBe(true);
  });
});
