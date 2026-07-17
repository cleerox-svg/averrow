import { describe, it, expect } from "vitest";
import {
  sanitizeExternalNarrative,
  parseDeepAnalysisOutput,
  buildPrompt,
  resolveAttribution,
  type DeepAnalysisInputs,
  type DeepAnalysisAttribution,
} from "../src/lib/abuse-mailbox-deep-analyzer";
import { sanitizeForExternalEmail } from "../src/lib/abuse-mailbox-responder";
import type { Env } from "../src/types";

// ─── sanitizers ─────────────────────────────────────────────────

describe("sanitizeExternalNarrative + sanitizeForExternalEmail", () => {
  // Both pass through the same regex set — exercise both names.
  const sanitizers = [
    { name: "sanitizeExternalNarrative", fn: sanitizeExternalNarrative },
    { name: "sanitizeForExternalEmail",  fn: (s: string) => sanitizeForExternalEmail(s) ?? "" },
  ];

  for (const { name, fn } of sanitizers) {
    describe(name, () => {
      it("replaces IPv4 addresses with [ip]", () => {
        const out = fn("The attacker IP 203.0.113.7 is hosted by OVH.");
        expect(out).toContain("[ip]");
        expect(out).not.toContain("203.0.113.7");
      });

      it("replaces IPv6 addresses with [ip]", () => {
        const out = fn("Sender IPv6 2001:db8:abcd::1234 was used.");
        expect(out).toContain("[ip]");
        expect(out).not.toContain("2001:db8");
      });

      it("replaces full URLs with [link]", () => {
        const out = fn("The phishing URL https://bad-acme.example/login was flagged.");
        expect(out).toContain("[link]");
        expect(out).not.toContain("bad-acme.example");
      });

      it("replaces email addresses with [sender]", () => {
        const out = fn("From phisher@bad.example you got the message.");
        expect(out).toContain("[sender]");
        expect(out).not.toContain("phisher@bad.example");
      });

      it("collapses multiple sanitized tokens in one sentence", () => {
        const out = fn("Phishing from phisher@bad.example via https://bad.example/login originating at 1.2.3.4.");
        expect(out).toContain("[sender]");
        expect(out).toContain("[link]");
        expect(out).toContain("[ip]");
        expect(out).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      });

      it("leaves benign sentences unchanged", () => {
        const out = fn("This appears to be part of an ongoing campaign hosted at OVH in France.");
        expect(out).toBe("This appears to be part of an ongoing campaign hosted at OVH in France.");
      });

      it("compresses internal double-spaces left after substitutions", () => {
        const out = fn("Before  the substitution  there were  double spaces");
        expect(out).not.toContain("  ");
      });
    });
  }

  it("sanitizeForExternalEmail handles null/empty input", () => {
    expect(sanitizeForExternalEmail(null)).toBeNull();
    expect(sanitizeForExternalEmail(undefined)).toBeNull();
    expect(sanitizeForExternalEmail("")).toBeNull();
    expect(sanitizeForExternalEmail("   ")).toBeNull();
  });
});

// ─── parser ─────────────────────────────────────────────────────

describe("parseDeepAnalysisOutput", () => {
  it("accepts a valid shape", () => {
    const out = parseDeepAnalysisOutput({
      internal_narrative: "Full narrative with IP 1.2.3.4",
      external_narrative: "Sanitized narrative",
      recommended_action: {
        category: "takedown",
        target: "abuse@hostingco.com",
        details: "Send a takedown notice",
      },
    });
    expect(out?.recommended_action.category).toBe("takedown");
    expect(out?.recommended_action.target).toBe("abuse@hostingco.com");
  });

  it("rejects unknown action categories", () => {
    const out = parseDeepAnalysisOutput({
      internal_narrative: "x",
      external_narrative: "y",
      recommended_action: { category: "nuke-from-orbit", target: null, details: "z" },
    });
    expect(out).toBeNull();
  });

  it("rejects when narratives are missing or empty", () => {
    expect(parseDeepAnalysisOutput({
      internal_narrative: "",
      external_narrative: "y",
      recommended_action: { category: "monitor", target: null, details: "z" },
    })).toBeNull();
    expect(parseDeepAnalysisOutput({
      internal_narrative: "x",
      external_narrative: "",
      recommended_action: { category: "monitor", target: null, details: "z" },
    })).toBeNull();
  });

  it("rejects null target with type coercion (must be string or null)", () => {
    const out = parseDeepAnalysisOutput({
      internal_narrative: "x",
      external_narrative: "y",
      recommended_action: { category: "monitor", target: null, details: "z" },
    });
    expect(out?.recommended_action.target).toBeNull();
  });

  it("rejects entirely garbage input", () => {
    expect(parseDeepAnalysisOutput(null)).toBeNull();
    expect(parseDeepAnalysisOutput("not an object")).toBeNull();
    expect(parseDeepAnalysisOutput({ random: "stuff" })).toBeNull();
  });

  it("accepts all five valid action categories", () => {
    for (const cat of ["takedown", "abuse_report", "block", "monitor", "none"] as const) {
      const out = parseDeepAnalysisOutput({
        internal_narrative: "x",
        external_narrative: "y",
        recommended_action: { category: cat, target: null, details: "z" },
      });
      expect(out?.recommended_action.category).toBe(cat);
    }
  });
});

// ─── buildPrompt ────────────────────────────────────────────────

const baseInputs: DeepAnalysisInputs = {
  message_id: "msg-1",
  classification: "phishing",
  confidence: 92,
  brand_name: "Acme",
  brand_domain: "acme.com",
  original_from: "phisher@bad.example",
  original_subject: "URGENT",
  body_snippet: "Click here to verify your password",
  url_list: [{ url: "https://bad.example/login", domain: "bad.example", count: 2 }],
  attachment_list: [{ filename: "invoice.pdf", mime_type: "application/pdf" }],
  auth_results: { spf: "fail", dkim: "fail", dmarc: "fail" },
  sender_ip: "203.0.113.7",
  correlated_threat_ids: ["thr-a", "thr-b"],
};

const baseAttribution: DeepAnalysisAttribution = {
  hosting_provider: "OVH SAS",
  hosting_country: "France",
  sender_asn: "AS16276",
  correlated_campaigns: [],
};

describe("buildPrompt", () => {
  it("includes the verdict + confidence at the top", () => {
    const p = buildPrompt(baseInputs, baseAttribution);
    expect(p).toContain("First-pass verdict: phishing @ 92% confidence");
  });

  it("includes attribution when present", () => {
    const p = buildPrompt(baseInputs, baseAttribution);
    expect(p).toContain("OVH SAS");
    expect(p).toContain("France");
    expect(p).toContain("AS16276");
  });

  it("lists URLs + attachments + auth verdicts", () => {
    const p = buildPrompt(baseInputs, baseAttribution);
    expect(p).toContain("bad.example/login");
    expect(p).toContain("invoice.pdf");
    expect(p).toContain("SPF=fail");
    expect(p).toContain("DKIM=fail");
    expect(p).toContain("DMARC=fail");
  });

  it("surfaces correlated campaigns when present", () => {
    const p = buildPrompt(baseInputs, {
      ...baseAttribution,
      correlated_campaigns: [
        { id: "camp-1", name: "JuneFinance2026", first_seen: "2026-04-15" },
      ],
    });
    expect(p).toContain("JuneFinance2026");
    expect(p).toContain("camp-1");
  });

  it("falls back to platform-correlation line when threat IDs exist but no campaigns", () => {
    const p = buildPrompt(baseInputs, { ...baseAttribution, correlated_campaigns: [] });
    expect(p).toContain("Platform correlation: 2 URL/domain");
  });
});

// ─── resolveAttribution — in-memory D1 stub ─────────────────────

function mkEnv(opts: {
  geoip?: { asn: string | null; asnOrg: string | null; countryName: string | null; countryCode: string | null } | null;
  providerByAsn?: { name: string } | null;
  campaigns?: Array<{ id: string; name: string | null; first_seen: string }>;
}): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind: () => ({
          async first<T>(): Promise<T | null> {
            if (sql.includes("FROM hosting_providers")) {
              return (opts.providerByAsn ?? null) as T | null;
            }
            return null;
          },
          async all<T>(): Promise<{ results: T[] }> {
            if (sql.includes("FROM campaigns")) {
              return { results: (opts.campaigns ?? []) as T[] };
            }
            return { results: [] };
          },
        }),
      };
    },
  };
  return {
    DB: db,
    GEOIP_DB: opts.geoip
      ? {
          prepare: () => ({
            bind: () => ({
              async first() {
                return {
                  asn: opts.geoip!.asn,
                  asn_org: opts.geoip!.asnOrg,
                  country_name: opts.geoip!.countryName,
                  country_code: opts.geoip!.countryCode,
                  region: null, city: null, postal_code: null, lat: null, lng: null,
                  source: "stub",
                };
              },
            }),
          }),
        }
      : undefined,
  } as unknown as Env;
}

describe("resolveAttribution", () => {
  it("returns all-nulls + empty campaigns when no sender IP and no correlations", async () => {
    const env = mkEnv({});
    const out = await resolveAttribution(env, null, []);
    expect(out).toEqual({
      hosting_provider: null,
      hosting_country: null,
      sender_asn: null,
      correlated_campaigns: [],
    });
  });

  it("returns null hosting when geoip lookup yields nothing", async () => {
    const env = mkEnv({ geoip: null });
    const out = await resolveAttribution(env, "203.0.113.7", []);
    expect(out.hosting_provider).toBeNull();
    expect(out.sender_asn).toBeNull();
  });
});
