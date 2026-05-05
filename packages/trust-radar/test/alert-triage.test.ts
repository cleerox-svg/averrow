import { describe, it, expect } from "vitest";
import { decideAutoTriage, type ThreatTriageSnapshot } from "../src/lib/alert-triage";

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
