import { describe, it, expect } from "vitest";
import {
  decideAutoTriage,
  decideSocialImpersonationTriage,
  decideAppStoreImpersonationTriage,
  normalizeHandle,
  normalizeCompanyName,
  type ThreatTriageSnapshot,
  type BrandAllowlist,
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
};

const cleanDomainSnapshot: ThreatTriageSnapshot = {
  vt_checked: 1,
  vt_malicious: 0,
  gsb_checked: 1,
  gsb_flagged: 0,
  greynoise_classification: null, // can't check GN without IP
  seclookup_risk_score: null,
  ip_address: null,
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

describe("normalizeHandle", () => {
  it("strips leading @ and lowercases", () => {
    expect(normalizeHandle('@Acme')).toBe('acme');
    expect(normalizeHandle('acme')).toBe('acme');
    expect(normalizeHandle('@ACME')).toBe('acme');
  });
  it("trims whitespace", () => {
    expect(normalizeHandle('  @AcmeCorp  ')).toBe('acmecorp');
  });
});

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
