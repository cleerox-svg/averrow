import { describe, it, expect } from "vitest";
import {
  decideAutoTriage,
  decideSocialImpersonationTriage,
  decideAppStoreImpersonationTriage,
  decideExecutiveImpersonationTriage,
  normalizeCompanyName,
  type ThreatTriageSnapshot,
  type BrandAllowlist,
  type ExecutiveAllowlist,
} from "../src/lib/alert-triage";

// Default snapshot — passes every gate. Each test mutates one field
// to verify the gate fires independently and the conjunction stays
// conservative (any single missing signal keeps the alert open).
const cleanIpSnapshot: ThreatTriageSnapshot = {
  vt_checked: 1,
  vt_malicious: 0,
  gsb_checked: 1,
  gsb_flagged: 0,
  greynoise_classification: 'benign',
  seclookup_risk_score: 5,
  ip_address: '1.2.3.4',
  domain_age_days: null, // unknown age (VT had no creation date) — not an NRD
};

const cleanDomainSnapshot: ThreatTriageSnapshot = {
  vt_checked: 1,
  vt_malicious: 0,
  gsb_checked: 1,
  gsb_flagged: 0,
  greynoise_classification: null, // can't check GN without IP
  seclookup_risk_score: null,
  ip_address: null,
  domain_age_days: null,
};

describe("decideAutoTriage — clean cases dismiss", () => {
  it("dismisses an IP-bearing alert when every signal is clean", () => {
    const d = decideAutoTriage(cleanIpSnapshot);
    expect(d.action).toBe('dismiss');
    expect(d.reason).toContain('clean enrichment');
  });

  it("dismisses a domain-only alert when VT+GSB are clean and seclookup is null", () => {
    const d = decideAutoTriage(cleanDomainSnapshot);
    expect(d.action).toBe('dismiss');
  });

  it("dismisses when seclookup_risk_score is right at the boundary (29)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, seclookup_risk_score: 29 });
    expect(d.action).toBe('dismiss');
  });

  it("dismisses when GreyNoise is null on an IP-bearing threat (not consulted yet)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, greynoise_classification: null });
    expect(d.action).toBe('dismiss');
  });
});

describe("decideAutoTriage — any single signal keeps open", () => {
  it("keeps when VT not checked", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, vt_checked: 0 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('vt_not_checked');
  });

  it("keeps when VT flagged any malicious", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, vt_malicious: 1 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('vt_flagged');
  });

  it("keeps when VT flagged many malicious", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, vt_malicious: 10 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('vt_flagged');
  });

  it("keeps when GSB not checked", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, gsb_checked: 0 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('gsb_not_checked');
  });

  it("keeps when GSB flagged the URL", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, gsb_flagged: 1 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('gsb_flagged');
  });

  it("keeps when GreyNoise classifies the IP as malicious", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, greynoise_classification: 'malicious' });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('greynoise_not_benign');
  });

  it("keeps when GreyNoise classifies the IP as unknown", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, greynoise_classification: 'unknown' });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('greynoise_not_benign');
  });

  it("keeps when seclookup risk score is exactly the cutoff (30)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, seclookup_risk_score: 30 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('seclookup_risk_score_high');
  });

  it("keeps when seclookup risk score is well above the cutoff", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, seclookup_risk_score: 85 });
    expect(d.action).toBe('keep');
  });
});

describe("decideAutoTriage — NRD guard (D4) withholds dismissal", () => {
  // The whole point of D4: a domain that every reputation feed cleared
  // but is only days old must NOT be auto-dismissed — brand-new phishing
  // infra has no reputation yet, so a "clean" reading is expected, not
  // reassuring.
  it("keeps an otherwise-clean IP alert when the domain is a fresh NRD (5d)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, domain_age_days: 5 });
    expect(d.action).toBe('keep');
    expect(d.reason).toContain('newly_registered_domain');
    expect(d.reason).toContain('5d');
  });

  it("keeps an otherwise-clean domain-only alert when the domain is a fresh NRD", () => {
    const d = decideAutoTriage({ ...cleanDomainSnapshot, domain_age_days: 0 });
    expect(d.action).toBe('keep');
    expect(d.reason).toContain('newly_registered_domain');
  });

  it("keeps at the NRD boundary (exactly 30d)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, domain_age_days: 30 });
    expect(d.action).toBe('keep');
    expect(d.reason).toContain('newly_registered_domain');
  });

  it("still dismisses a clean, well-aged domain (31d — just past the window)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, domain_age_days: 31 });
    expect(d.action).toBe('dismiss');
    expect(d.reason).toContain('clean enrichment');
  });

  it("still dismisses when age is unknown (NULL — absence of evidence, not youth)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, domain_age_days: null });
    expect(d.action).toBe('dismiss');
  });

  it("dismisses a long-established clean domain (365d)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, domain_age_days: 365 });
    expect(d.action).toBe('dismiss');
  });

  it("prioritizes a hard reputation signal over the NRD note (VT-flagged NRD keeps as vt_flagged)", () => {
    // A flagged domain should keep for the strongest/earliest reason;
    // the NRD gate is the last resort before dismissal, so it never
    // masks a real reputation hit.
    const d = decideAutoTriage({ ...cleanIpSnapshot, vt_malicious: 4, domain_age_days: 3 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('vt_flagged');
  });
});

describe("decideAutoTriage — domain-only threats", () => {
  it("ignores GreyNoise classification on domain-only threats (no IP)", () => {
    // Even with greynoise_classification = 'malicious' from a stale
    // record, if there's no IP we don't gate on GN. (In practice GN
    // shouldn't be set without an IP; the test exercises that
    // domain-only alerts aren't accidentally kept open by stale GN
    // values.)
    const d = decideAutoTriage({
      ...cleanDomainSnapshot,
      greynoise_classification: 'malicious',
    });
    expect(d.action).toBe('dismiss');
  });

  it("still gates on VT/GSB/SecLookup for domain-only threats", () => {
    const d = decideAutoTriage({ ...cleanDomainSnapshot, vt_malicious: 1 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('vt_flagged');
  });
});

describe("decideAutoTriage — null safety", () => {
  it("treats null vt_malicious as zero (clean) — defensive default", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, vt_malicious: null });
    expect(d.action).toBe('dismiss');
  });

  it("treats null gsb_flagged as zero (clean) — defensive default", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, gsb_flagged: null });
    expect(d.action).toBe('dismiss');
  });
});

// ─── Tier 1.5: Social impersonation ──────────────────────────────

const emptyAllowlist: BrandAllowlist = { name: null, official_handles: null, official_apps: null };

describe("decideSocialImpersonationTriage — Rule B (allowlist match)", () => {
  it("dismisses when handle matches the brand's official handle for the platform", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { twitter: '@acme' },
      official_apps: null,
    };
    const d = decideSocialImpersonationTriage(
      { platform: 'twitter', handle: 'acme', score: 0.95 },
      allow,
    );
    expect(d.action).toBe('dismiss');
    expect(d.reason).toBe('auto: matches brand official handle');
  });

  it("matches case-insensitively + tolerates @ prefix variations", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { instagram: 'AcmeCorp' },
      official_apps: null,
    };
    const d = decideSocialImpersonationTriage(
      { platform: 'INSTAGRAM', handle: '@acmecorp', score: 0.99 },
      allow,
    );
    expect(d.action).toBe('dismiss');
  });

  it("does NOT dismiss when handle differs from official", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { twitter: '@acme' },
      official_apps: null,
    };
    const d = decideSocialImpersonationTriage(
      { platform: 'twitter', handle: 'acme_official', score: 0.99 },
      allow,
    );
    expect(d.action).toBe('keep');
  });

  it("does NOT match across platforms", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { twitter: '@acme' },
      official_apps: null,
    };
    const d = decideSocialImpersonationTriage(
      { platform: 'instagram', handle: 'acme', score: 0.99 },
      allow,
    );
    expect(d.action).toBe('keep');
  });
});

describe("decideSocialImpersonationTriage — Rule B platform-aware dots (bug #22)", () => {
  it("matches a dotted official handle on Instagram (dot preserved)", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { instagram: "jane.doe" },
      official_apps: null,
    };
    const d = decideSocialImpersonationTriage(
      { platform: "instagram", handle: "jane.doe", score: 0.95 },
      allow,
    );
    expect(d.action).toBe("dismiss");
    expect(d.reason).toBe("auto: matches brand official handle");
  });

  it("does NOT spuriously match `janedoe` against official `jane.doe` on Instagram", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { instagram: "jane.doe" },
      official_apps: null,
    };
    // A distinct dot-stripped IG account is a real impostor — must stay open.
    const d = decideSocialImpersonationTriage(
      { platform: "instagram", handle: "janedoe", score: 0.95 },
      allow,
    );
    expect(d.action).toBe("keep");
  });

  it("strips the dot on X so official `jane.doe` matches probed `janedoe`", () => {
    // X forbids dots; both sides collapse to `janedoe`.
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { twitter: "jane.doe" },
      official_apps: null,
    };
    const d = decideSocialImpersonationTriage(
      { platform: "twitter", handle: "janedoe", score: 0.95 },
      allow,
    );
    expect(d.action).toBe("dismiss");
  });

  it("keeps an underscore on Instagram (jane_doe matches jane_doe)", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { instagram: "jane_doe" },
      official_apps: null,
    };
    const d = decideSocialImpersonationTriage(
      { platform: "instagram", handle: "@Jane_Doe", score: 0.9 },
      allow,
    );
    expect(d.action).toBe("dismiss");
  });

  it("strips underscores on GitHub so `jane_doe` and `janedoe` collapse", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { github: "jane_doe" },
      official_apps: null,
    };
    const d = decideSocialImpersonationTriage(
      { platform: "github", handle: "janedoe", score: 0.9 },
      allow,
    );
    expect(d.action).toBe("dismiss");
  });

  it("does NOT auto-dismiss when handle AND official both normalize to '' (empty guard)", () => {
    // On GitHub, an all-dot handle strips to '' on both sides — '' === ''
    // must NOT be treated as an official-handle match. High score → stays open.
    const allow: BrandAllowlist = {
      name: null,
      official_handles: { github: "..." },
      official_apps: null,
    };
    const d = decideSocialImpersonationTriage(
      { platform: "github", handle: "...", score: 0.95 },
      allow,
    );
    expect(d.action).toBe("keep");
    expect(d.reason).toBe("high_impersonation_score");
  });
});

describe("decideSocialImpersonationTriage — Rule A (low score)", () => {
  it("dismisses when score is below the default 0.5 threshold", () => {
    const d = decideSocialImpersonationTriage(
      { platform: 'twitter', handle: 'someone_else', score: 0.42 },
      emptyAllowlist,
    );
    expect(d.action).toBe('dismiss');
    expect(d.reason).toContain('low impersonation score');
  });

  it("keeps when score is at or above the threshold", () => {
    const d = decideSocialImpersonationTriage(
      { platform: 'twitter', handle: 'x', score: 0.5 },
      emptyAllowlist,
    );
    expect(d.action).toBe('keep');
  });

  it("respects a custom threshold", () => {
    const d = decideSocialImpersonationTriage(
      { platform: 'twitter', handle: 'x', score: 0.65 },
      emptyAllowlist,
      0.7,
    );
    expect(d.action).toBe('dismiss');
  });

  it("treats missing score as 1.0 (max suspicion) — keep", () => {
    const d = decideSocialImpersonationTriage(
      { platform: 'twitter', handle: 'x' },
      emptyAllowlist,
    );
    expect(d.action).toBe('keep');
  });

  it("keeps when details are missing entirely", () => {
    const d = decideSocialImpersonationTriage(null, emptyAllowlist);
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('social_details_missing');
  });
});

// ─── Tier 1.5: App store impersonation ───────────────────────────

describe("decideAppStoreImpersonationTriage — Rule B (allowlist match)", () => {
  it("dismisses when bundle_id matches", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: null,
      official_apps: [{ platform: 'ios', bundle_id: 'com.acme.app' }],
    };
    const d = decideAppStoreImpersonationTriage(
      { store: 'ios', bundle_id: 'com.acme.app', impersonation_score: 0.99 },
      allow,
    );
    expect(d.action).toBe('dismiss');
    expect(d.reason).toBe('auto: matches brand official bundle_id');
  });

  it("dismisses when developer_name matches case-insensitively", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: null,
      official_apps: [{ platform: 'ios', developer_name: 'Acme Inc' }],
    };
    const d = decideAppStoreImpersonationTriage(
      { store: 'ios', developer_name: 'ACME INC', impersonation_score: 0.99 },
      allow,
    );
    expect(d.action).toBe('dismiss');
  });

  it("does NOT match when allowlist platform differs from alert store", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: null,
      official_apps: [{ platform: 'google_play', bundle_id: 'com.acme.app' }],
    };
    const d = decideAppStoreImpersonationTriage(
      { store: 'ios', bundle_id: 'com.acme.app', impersonation_score: 0.99 },
      allow,
    );
    expect(d.action).toBe('keep');
  });
});

describe("decideAppStoreImpersonationTriage — Rule A (low score)", () => {
  it("dismisses when impersonation_score below 0.5 default", () => {
    const d = decideAppStoreImpersonationTriage(
      { store: 'ios', impersonation_score: 0.4 },
      emptyAllowlist,
    );
    expect(d.action).toBe('dismiss');
    expect(d.reason).toContain('low impersonation score');
  });

  it("keeps when impersonation_score is at the threshold", () => {
    const d = decideAppStoreImpersonationTriage(
      { store: 'ios', impersonation_score: 0.5 },
      emptyAllowlist,
    );
    expect(d.action).toBe('keep');
  });

  it("keeps when details are missing", () => {
    const d = decideAppStoreImpersonationTriage(null, emptyAllowlist);
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('app_store_details_missing');
  });
});

// ─── Tier 1.6: brand-name developer match (Rule B+) ──────────────

describe("normalizeCompanyName", () => {
  it("strips trailing 'Inc.' suffix", () => {
    expect(normalizeCompanyName("Adobe Inc.")).toBe("adobe");
  });
  it("strips multiple trailing suffixes (Systems, Inc.)", () => {
    expect(normalizeCompanyName("Adobe Systems, Inc.")).toBe("adobe systems");
  });
  it("preserves middle words (does not strip from inside)", () => {
    expect(normalizeCompanyName("Adobe Free Inc.")).toBe("adobe free");
  });
  it("handles 'Corp.', 'Corporation', 'Limited', 'LLC'", () => {
    expect(normalizeCompanyName("Acme Corp.")).toBe("acme");
    expect(normalizeCompanyName("Acme Corporation")).toBe("acme");
    expect(normalizeCompanyName("Acme Limited")).toBe("acme");
    expect(normalizeCompanyName("Acme LLC")).toBe("acme");
  });
  it("handles GmbH / AG / SA international suffixes", () => {
    expect(normalizeCompanyName("Beispiel GmbH")).toBe("beispiel");
    expect(normalizeCompanyName("Industrias S.A.")).toBe("industrias");
  });
  it("collapses extra whitespace and lowercases", () => {
    expect(normalizeCompanyName("  Adobe   Inc.  ")).toBe("adobe");
  });
  it("returns brand-only names unchanged (lowercased)", () => {
    expect(normalizeCompanyName("Adobe")).toBe("adobe");
  });
});

describe("decideAppStoreImpersonationTriage — Rule B+ (brand-name developer match)", () => {
  it("dismisses when developer_name normalizes to brand.name", () => {
    const allow: BrandAllowlist = {
      name: 'Adobe',
      official_handles: null,
      official_apps: null,
    };
    const d = decideAppStoreImpersonationTriage(
      {
        store: 'ios',
        developer_name: 'Adobe Inc.',
        impersonation_score: 0.93,
      },
      allow,
    );
    expect(d.action).toBe('dismiss');
    expect(d.reason).toContain('developer name matches brand name');
  });

  it("dismisses when both have suffixes that normalize away (Adobe Systems, Inc. vs Adobe Systems)", () => {
    const allow: BrandAllowlist = {
      name: 'Adobe Systems',
      official_handles: null,
      official_apps: null,
    };
    const d = decideAppStoreImpersonationTriage(
      {
        store: 'ios',
        developer_name: 'Adobe Systems, Inc.',
        impersonation_score: 0.95,
      },
      allow,
    );
    expect(d.action).toBe('dismiss');
  });

  it("does NOT dismiss when normalized names differ (Adobe Free Inc. vs Adobe)", () => {
    const allow: BrandAllowlist = {
      name: 'Adobe',
      official_handles: null,
      official_apps: null,
    };
    const d = decideAppStoreImpersonationTriage(
      {
        store: 'ios',
        developer_name: 'Adobe Free Inc.',
        impersonation_score: 0.95,
      },
      allow,
    );
    expect(d.action).toBe('keep');
  });

  it("falls through to score gate when no name match (high score keeps)", () => {
    const allow: BrandAllowlist = {
      name: 'Adobe',
      official_handles: null,
      official_apps: null,
    };
    const d = decideAppStoreImpersonationTriage(
      {
        store: 'ios',
        developer_name: 'Phisher Co.',
        impersonation_score: 0.85,
      },
      allow,
    );
    expect(d.action).toBe('keep');
  });

  it("does not fire Rule B+ when allowlist.name is null (no brand context)", () => {
    const allow: BrandAllowlist = {
      name: null,
      official_handles: null,
      official_apps: null,
    };
    const d = decideAppStoreImpersonationTriage(
      {
        store: 'ios',
        developer_name: 'Adobe Inc.',
        impersonation_score: 0.93,
      },
      allow,
    );
    expect(d.action).toBe('keep');
  });

  it("does not fire Rule B+ when developer_name is missing", () => {
    const allow: BrandAllowlist = {
      name: 'Adobe',
      official_handles: null,
      official_apps: null,
    };
    const d = decideAppStoreImpersonationTriage(
      {
        store: 'ios',
        impersonation_score: 0.93,
      },
      allow,
    );
    expect(d.action).toBe('keep');
  });
});

// ─── Tier 1.5: Executive impersonation ───────────────────────────

const emptyExecAllowlist: ExecutiveAllowlist = { full_name: null, official_handles: null };

describe("decideExecutiveImpersonationTriage — Rule B (exec official-handle match)", () => {
  it("dismisses when handle matches the exec's official handle for the platform", () => {
    const allow: ExecutiveAllowlist = {
      full_name: 'Jane Doe',
      official_handles: { twitter: '@janedoe' },
    };
    const d = decideExecutiveImpersonationTriage(
      { platform: 'twitter', handle: 'janedoe', score: 0.95 },
      allow,
    );
    expect(d.action).toBe('dismiss');
    expect(d.reason).toBe('auto: matches executive official handle');
  });

  it("matches case-insensitively + tolerates @ prefix variations", () => {
    const allow: ExecutiveAllowlist = {
      full_name: 'Jane Doe',
      official_handles: { linkedin: 'Jane-Doe' },
    };
    const d = decideExecutiveImpersonationTriage(
      { platform: 'LINKEDIN', handle: '@jane-doe', score: 0.99 },
      allow,
    );
    expect(d.action).toBe('dismiss');
  });

  it("does NOT dismiss when handle differs from the exec's official handle", () => {
    const allow: ExecutiveAllowlist = {
      full_name: 'Jane Doe',
      official_handles: { twitter: '@janedoe' },
    };
    const d = decideExecutiveImpersonationTriage(
      { platform: 'twitter', handle: 'realjanedoe', score: 0.9 },
      allow,
    );
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('high_impersonation_score');
  });

  it("does NOT match an official handle across platforms", () => {
    const allow: ExecutiveAllowlist = {
      full_name: 'Jane Doe',
      official_handles: { twitter: '@janedoe' },
    };
    const d = decideExecutiveImpersonationTriage(
      { platform: 'instagram', handle: 'janedoe', score: 0.9 },
      allow,
    );
    expect(d.action).toBe('keep');
  });

  it("uses the EXEC allowlist, not a brand allowlist — brand handles are irrelevant", () => {
    // No official handle for the exec on this platform → Rule B can't fire;
    // high score → keep. (Ensures we don't accidentally read brand handles.)
    const allow: ExecutiveAllowlist = {
      full_name: 'Jane Doe',
      official_handles: { linkedin: 'jane-doe' },
    };
    const d = decideExecutiveImpersonationTriage(
      { platform: 'twitter', handle: 'janedoe', score: 0.85 },
      allow,
    );
    expect(d.action).toBe('keep');
  });
});

describe("decideExecutiveImpersonationTriage — Rule B platform-aware dots (bug #22)", () => {
  it("matches a dotted exec official handle on TikTok (dot preserved)", () => {
    const allow: ExecutiveAllowlist = {
      full_name: "Jane Doe",
      official_handles: { tiktok: "jane.doe" },
    };
    const d = decideExecutiveImpersonationTriage(
      { platform: "tiktok", handle: "@jane.doe", score: 0.9 },
      allow,
    );
    expect(d.action).toBe("dismiss");
    expect(d.reason).toBe("auto: matches executive official handle");
  });

  it("does NOT dismiss a dot-stripped impostor against the dotted exec handle on TikTok", () => {
    const allow: ExecutiveAllowlist = {
      full_name: "Jane Doe",
      official_handles: { tiktok: "jane.doe" },
    };
    const d = decideExecutiveImpersonationTriage(
      { platform: "tiktok", handle: "janedoe", score: 0.9 },
      allow,
    );
    expect(d.action).toBe("keep");
  });

  it("does NOT auto-dismiss when handle AND official both normalize to '' (empty guard)", () => {
    const allow: ExecutiveAllowlist = {
      full_name: "Jane Doe",
      official_handles: { github: "___" },
    };
    const d = decideExecutiveImpersonationTriage(
      { platform: "github", handle: "___", score: 0.95 },
      allow,
    );
    expect(d.action).toBe("keep");
    expect(d.reason).toBe("high_impersonation_score");
  });
});

describe("decideExecutiveImpersonationTriage — Rule A (low score)", () => {
  it("dismisses when score is below the default 0.5 threshold", () => {
    const d = decideExecutiveImpersonationTriage(
      { platform: 'twitter', handle: 'someone_else', score: 0.42 },
      emptyExecAllowlist,
    );
    expect(d.action).toBe('dismiss');
    expect(d.reason).toContain('low impersonation score');
  });

  it("keeps when score is at or above the threshold", () => {
    const d = decideExecutiveImpersonationTriage(
      { platform: 'twitter', handle: 'x', score: 0.5 },
      emptyExecAllowlist,
    );
    expect(d.action).toBe('keep');
  });

  it("respects a custom (tighter) threshold", () => {
    const d = decideExecutiveImpersonationTriage(
      { platform: 'twitter', handle: 'x', score: 0.65 },
      emptyExecAllowlist,
      0.7,
    );
    expect(d.action).toBe('dismiss');
  });

  it("treats missing score as 1.0 (max suspicion) — keep", () => {
    const d = decideExecutiveImpersonationTriage(
      { platform: 'twitter', handle: 'x' },
      emptyExecAllowlist,
    );
    expect(d.action).toBe('keep');
  });

  it("keeps when details are missing entirely", () => {
    const d = decideExecutiveImpersonationTriage(null, emptyExecAllowlist);
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('executive_details_missing');
  });

  it("Rule B wins over a high score (dismiss beats keep)", () => {
    const allow: ExecutiveAllowlist = {
      full_name: 'Jane Doe',
      official_handles: { twitter: '@janedoe' },
    };
    // Score alone would keep, but the official-handle match dismisses.
    const d = decideExecutiveImpersonationTriage(
      { platform: 'twitter', handle: '@JaneDoe', score: 0.99 },
      allow,
    );
    expect(d.action).toBe('dismiss');
  });
});

// ─── Page-content credential-harvest guard (D6 / S2.4) ────────────

describe("decideAutoTriage — page credential-harvest guard", () => {
  it("keeps an otherwise-clean alert when a credential-harvest page is detected", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, page_credential_harvest: 1 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('page_credential_harvest_detected');
  });

  it("still dismisses a clean alert when the page flag is 0 (no harvest)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, page_credential_harvest: 0 });
    expect(d.action).toBe('dismiss');
  });

  it("still dismisses when the page flag is null/absent (threat-sourced, no page data)", () => {
    const d = decideAutoTriage({ ...cleanIpSnapshot, page_credential_harvest: null });
    expect(d.action).toBe('dismiss');
    const d2 = decideAutoTriage(cleanIpSnapshot); // field omitted entirely
    expect(d2.action).toBe('dismiss');
  });

  it("the guard only flips dismiss→keep — a keep decision is unaffected", () => {
    // VT flagged → keep regardless of the page flag (no severity change,
    // reason stays the reputation reason, not the page reason).
    const d = decideAutoTriage({ ...cleanIpSnapshot, vt_malicious: 3, page_credential_harvest: 1 });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('vt_flagged');
  });
});
