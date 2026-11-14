/**
 * DMARC RUA row → sending-source class (lib/dmarc-source-classify.ts).
 * Truth table per class, unknown-ASN behaviour, merge precedence.
 */

import { describe, it, expect } from "vitest";
import {
  classifyDmarcSource,
  explainDmarcSource,
  dmarcPassed,
  mergeDmarcSourceClass,
  isBrandRelatedDomain,
  isSharedSendingAsn,
  ESP_SENDER_ASNS,
  DMARC_SOURCE_CLASS_RANK,
  type DmarcRecordEvidence,
  type DmarcSourceClass,
} from "../src/lib/dmarc-source-classify";
import { SINGLE_TENANT_IAAS_ASNS } from "../src/lib/shared-infra-asns";

const VPS = "AS14061"; // DigitalOcean — single-tenant IaaS, never "shared ESP"

function ev(over: Partial<DmarcRecordEvidence> = {}): DmarcRecordEvidence {
  return {
    headerFrom: "acme.com",
    dkimAligned: "fail",
    spfAligned: "fail",
    dkimAuth: [],
    spfAuth: null,
    asn: VPS,
    ...over,
  };
}

describe("dmarcPassed", () => {
  it.each([
    ["pass", "pass", true],
    ["pass", "fail", true],
    ["fail", "pass", true],
    ["fail", "fail", false],
  ] as const)("dkim=%s spf=%s → %s", (d, s, want) => {
    expect(dmarcPassed({ dkimAligned: d, spfAligned: s })).toBe(want);
  });
});

describe("classifyDmarcSource truth table", () => {
  const cases: Array<[string, DmarcRecordEvidence, DmarcSourceClass, string]> = [
    // ── aligned_pass ──
    ["aligned DKIM only", ev({ dkimAligned: "pass", dkimAuth: [{ domain: "acme.com", result: "pass" }] }),
      "aligned_pass", "R1_dmarc_pass"],
    ["aligned SPF only, from a VPS", ev({ spfAligned: "pass", spfAuth: { domain: "acme.com", result: "pass" } }),
      "aligned_pass", "R1_dmarc_pass"],
    ["aligned pass with no ASN", ev({ dkimAligned: "pass", asn: null }), "aligned_pass", "R1_dmarc_pass"],

    // ── forwarder_likely ──
    ["receiver override mailing_list", ev({ overrideReasons: ["mailing_list"] }),
      "forwarder_likely", "R2_receiver_forwarding_override"],
    ["receiver override trusted_forwarder (RFC 9990)", ev({ overrideReasons: ["Trusted_Forwarder"] }),
      "forwarder_likely", "R2_receiver_forwarding_override"],
    ["brand DKIM pass on subdomain, strict alignment", ev({ dkimAuth: [{ domain: "mail.acme.com", result: "pass" }] }),
      "forwarder_likely", "R3_brand_dkim_pass_unaligned"],
    ["brand SPF pass on bounce subdomain, strict aspf", ev({ spfAuth: { domain: "bounce.acme.com", result: "pass" } }),
      "forwarder_likely", "R4_brand_spf_pass_unaligned"],
    ["forward shape: brand sig broken + SRS SPF pass",
      ev({ dkimAuth: [{ domain: "acme.com", result: "fail" }], spfAuth: { domain: "lists.example.org", result: "pass" } }),
      "forwarder_likely", "R5_forwarded_signature_broken"],
    ["forward shape wins over unknown ASN",
      ev({ asn: null, dkimAuth: [{ domain: "acme.com", result: "fail" }], spfAuth: { domain: "srs.fwd.net", result: "pass" } }),
      "forwarder_likely", "R5_forwarded_signature_broken"],

    // ── unaligned_shared_esp ──
    ["SendGrid ASN, sendgrid signature", ev({ asn: "AS11377", dkimAuth: [{ domain: "sendgrid.net", result: "pass" }],
      spfAuth: { domain: "em123.sendgrid.net", result: "pass" } }), "unaligned_shared_esp", "R6_shared_sending_asn"],
    ["Google (multi-tenant) ASN, nothing else", ev({ asn: "AS15169" }), "unaligned_shared_esp", "R6_shared_sending_asn"],
    ["Mailchimp signature, unknown ASN", ev({ asn: null, dkimAuth: [{ domain: "mcsv.net", result: "pass" }] }),
      "unaligned_shared_esp", "R6_esp_dkim_signature"],
    ["M365 default tenant signature on a VPS-looking ASN",
      ev({ dkimAuth: [{ domain: "acmeinc.onmicrosoft.com", result: "pass" }] }),
      "unaligned_shared_esp", "R6_esp_dkim_signature"],

    // ── spoof_candidate ──
    ["bare spoof from VPS", ev({ spfAuth: { domain: "acme.com", result: "fail" } }), "spoof_candidate", "R7_no_legitimacy_evidence"],
    ["spoof with attacker envelope SPF pass, no brand sig", ev({ spfAuth: { domain: "evil-mailer.xyz", result: "pass" } }),
      "spoof_candidate", "R7_no_legitimacy_evidence"],
    ["forged brand sig (permerror) is not evidence",
      ev({ dkimAuth: [{ domain: "acme.com", result: "permerror" }], spfAuth: { domain: "evil.xyz", result: "pass" } }),
      "spoof_candidate", "R7_no_legitimacy_evidence"],
    ["local_policy override is not evidence", ev({ overrideReasons: ["local_policy", "sampled_out"] }),
      "spoof_candidate", "R7_no_legitimacy_evidence"],
    ["lookalike-domain DKIM pass is not brand-related", ev({ dkimAuth: [{ domain: "acme-com.net", result: "pass" }] }),
      "spoof_candidate", "R7_no_legitimacy_evidence"],
    ["ESP signature that failed doesn't count", ev({ dkimAuth: [{ domain: "sendgrid.net", result: "fail" }] }),
      "spoof_candidate", "R7_no_legitimacy_evidence"],
  ];

  it.each(cases)("%s", (_name, e, cls, rule) => {
    expect(classifyDmarcSource(e)).toBe(cls);
    expect(explainDmarcSource(e).rule).toBe(rule);
  });
});

describe("unknown ASN (asn: null)", () => {
  it("bare failing row with no evidence stays spoof_candidate — unknown is not benign", () => {
    expect(classifyDmarcSource(ev({ asn: null }))).toBe("spoof_candidate");
  });
  it("can still reach unaligned_shared_esp via an ESP signing domain", () => {
    expect(classifyDmarcSource(ev({ asn: null, dkimAuth: [{ domain: "x.amazonses.com", result: "pass" }] })))
      .toBe("unaligned_shared_esp");
  });
  it("forwarder rules ignore the ASN", () => {
    expect(classifyDmarcSource(ev({ asn: null, overrideReasons: ["forwarded"] }))).toBe("forwarder_likely");
    expect(classifyDmarcSource(ev({ asn: null, dkimAuth: [{ domain: "acme.com", result: "pass" }] }))).toBe("forwarder_likely");
  });
});

describe("precedence between rules", () => {
  it("brand evidence beats shared-ESP ASN", () => {
    expect(classifyDmarcSource(ev({ asn: "AS11377", dkimAuth: [{ domain: "acme.com", result: "pass" }] })))
      .toBe("forwarder_likely");
  });
  it("single-tenant IaaS is never treated as shared sending", () => {
    for (const a of SINGLE_TENANT_IAAS_ASNS) {
      expect(isSharedSendingAsn(a)).toBe(false);
      expect(ESP_SENDER_ASNS.has(a)).toBe(false);
    }
  });
  it("isSharedSendingAsn accepts raw ASN forms", () => {
    expect(isSharedSendingAsn("11377")).toBe(true);
    expect(isSharedSendingAsn("as396479 Mailgun")).toBe(true);
    expect(isSharedSendingAsn(null)).toBe(false);
  });
});

describe("isBrandRelatedDomain", () => {
  it.each([
    ["acme.com", "acme.com", true],
    ["mail.acme.com", "acme.com", true],
    ["acme.com", "news.acme.com", true],          // parent org signing for a subdomain From
    ["a.acme.com", "b.acme.com", true],           // same org domain
    ["ACME.COM.", "acme.com", true],              // case + trailing dot
    ["acme.co.uk", "shop.acme.co.uk", true],
    ["co.uk", "acme.co.uk", false],               // a public suffix is not the brand
    ["com", "acme.com", false],
    ["other.co.uk", "acme.co.uk", false],
    ["acme.com.evil.net", "acme.com", false],
    ["", "acme.com", false],
  ] as const)("%s vs %s → %s", (d, h, want) => {
    expect(isBrandRelatedDomain(d, h)).toBe(want);
  });
});

describe("mergeDmarcSourceClass", () => {
  const all: DmarcSourceClass[] = ["aligned_pass", "forwarder_likely", "unaligned_shared_esp", "spoof_candidate"];

  it("most suspicious wins", () => {
    expect(mergeDmarcSourceClass("aligned_pass", "spoof_candidate")).toBe("spoof_candidate");
    expect(mergeDmarcSourceClass("forwarder_likely", "unaligned_shared_esp")).toBe("unaligned_shared_esp");
    expect(mergeDmarcSourceClass("aligned_pass", "forwarder_likely")).toBe("forwarder_likely");
    expect(mergeDmarcSourceClass("unaligned_shared_esp", "spoof_candidate")).toBe("spoof_candidate");
  });

  it("is commutative, idempotent and associative (order-independent rollup)", () => {
    for (const a of all) {
      expect(mergeDmarcSourceClass(a, a)).toBe(a);
      for (const b of all) {
        expect(mergeDmarcSourceClass(a, b)).toBe(mergeDmarcSourceClass(b, a));
        for (const c of all) {
          expect(mergeDmarcSourceClass(mergeDmarcSourceClass(a, b), c))
            .toBe(mergeDmarcSourceClass(a, mergeDmarcSourceClass(b, c)));
        }
      }
    }
  });

  it("agrees with MAX(rank) for SQL rollups", () => {
    for (const a of all) for (const b of all) {
      const r = Math.max(DMARC_SOURCE_CLASS_RANK[a], DMARC_SOURCE_CLASS_RANK[b]);
      expect(DMARC_SOURCE_CLASS_RANK[mergeDmarcSourceClass(a, b)]).toBe(r);
    }
  });
});
