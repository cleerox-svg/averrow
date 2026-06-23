import { describe, it, expect } from "vitest";
import {
  evaluateTakedownPolicy,
  DEFAULT_SEMI_AUTO_RULES,
  type SemiAutoRules,
} from "../src/lib/takedown-policy";
import {
  normalizeScope,
  type AuthorizationScope,
} from "../src/lib/takedown-authorizations";

// A fully-populated scope at a given mode. Tests override `mode` /
// `semi_auto_rules` to isolate each gate.
function scope(
  mode: AuthorizationScope["mode"],
  rules: SemiAutoRules = DEFAULT_SEMI_AUTO_RULES,
): AuthorizationScope {
  return normalizeScope({
    modules: ["domain", "social"],
    max_takedowns_per_month: null,
    escalation: "auto_resubmit_on_pivot",
    auto_followup_breached_sla_hours: 72,
    high_risk_requires_per_takedown_approval: mode === "semi_auto",
    mode,
    semi_auto_rules: rules,
  });
}

const lowDomain = { severity: "LOW", target_type: "domain", provider_type: "registrar" };
const critDomain = { severity: "CRITICAL", target_type: "domain", provider_type: "registrar" };

describe("evaluateTakedownPolicy — posture short-circuits", () => {
  it("off never auto-submits, even for human-approved", () => {
    expect(evaluateTakedownPolicy(scope("off"), lowDomain)).toBe("off");
    expect(evaluateTakedownPolicy(scope("off"), { ...critDomain, human_approved: true })).toBe("off");
  });

  it("auto always auto-submits", () => {
    expect(evaluateTakedownPolicy(scope("auto"), lowDomain)).toBe("auto");
    expect(evaluateTakedownPolicy(scope("auto"), critDomain)).toBe("auto");
  });

  it("human-approved (requested) submits in semi_auto regardless of rules", () => {
    // CRITICAL would normally be held under the default rules…
    expect(evaluateTakedownPolicy(scope("semi_auto"), critDomain)).toBe("approval");
    // …but once a human approved it, it submits.
    expect(evaluateTakedownPolicy(scope("semi_auto"), { ...critDomain, human_approved: true })).toBe("auto");
  });
});

describe("evaluateTakedownPolicy — semi_auto severity gate", () => {
  const s = scope("semi_auto"); // default rules: auto LOW/MEDIUM

  it("auto-submits a severity on the allow-list", () => {
    expect(evaluateTakedownPolicy(s, { severity: "LOW", target_type: "domain", provider_type: "hosting" })).toBe("auto");
    expect(evaluateTakedownPolicy(s, { severity: "MEDIUM", target_type: "url", provider_type: "cdn" })).toBe("auto");
  });

  it("holds a severity off the allow-list for approval", () => {
    expect(evaluateTakedownPolicy(s, { severity: "HIGH", target_type: "domain", provider_type: "hosting" })).toBe("approval");
    expect(evaluateTakedownPolicy(s, critDomain)).toBe("approval");
  });

  it("is case-insensitive on severity", () => {
    expect(evaluateTakedownPolicy(s, { severity: "low", target_type: "domain", provider_type: "hosting" })).toBe("auto");
  });

  it("holds unknown / null severity", () => {
    expect(evaluateTakedownPolicy(s, { severity: null, target_type: "domain", provider_type: "hosting" })).toBe("approval");
    expect(evaluateTakedownPolicy(s, { severity: "WAT", target_type: "domain", provider_type: "hosting" })).toBe("approval");
  });
});

describe("evaluateTakedownPolicy — semi_auto target/provider gates", () => {
  it("empty target/provider lists impose no restriction (severity decides)", () => {
    const s = scope("semi_auto", { auto_severities: ["LOW", "MEDIUM", "HIGH", "CRITICAL"], auto_target_types: [], auto_provider_types: [] });
    expect(evaluateTakedownPolicy(s, critDomain)).toBe("auto");
  });

  it("non-empty target list restricts to listed types", () => {
    const s = scope("semi_auto", { auto_severities: ["CRITICAL"], auto_target_types: ["domain"], auto_provider_types: [] });
    expect(evaluateTakedownPolicy(s, critDomain)).toBe("auto");
    expect(evaluateTakedownPolicy(s, { severity: "CRITICAL", target_type: "social_profile", provider_type: "social_platform" })).toBe("approval");
  });

  it("non-empty provider list restricts to listed types", () => {
    const s = scope("semi_auto", { auto_severities: ["CRITICAL"], auto_target_types: [], auto_provider_types: ["registrar"] });
    expect(evaluateTakedownPolicy(s, critDomain)).toBe("auto");
    expect(evaluateTakedownPolicy(s, { severity: "CRITICAL", target_type: "domain", provider_type: "hosting" })).toBe("approval");
  });

  it("all three gates must pass together", () => {
    const s = scope("semi_auto", { auto_severities: ["HIGH"], auto_target_types: ["domain"], auto_provider_types: ["registrar"] });
    expect(evaluateTakedownPolicy(s, { severity: "HIGH", target_type: "domain", provider_type: "registrar" })).toBe("auto");
    expect(evaluateTakedownPolicy(s, { severity: "HIGH", target_type: "domain", provider_type: "hosting" })).toBe("approval");
    expect(evaluateTakedownPolicy(s, { severity: "LOW", target_type: "domain", provider_type: "registrar" })).toBe("approval");
  });
});

describe("normalizeScope — backward compatibility", () => {
  it("derives semi_auto from legacy high_risk=true", () => {
    const s = normalizeScope({
      modules: ["domain"],
      max_takedowns_per_month: 500,
      escalation: "manual_only",
      auto_followup_breached_sla_hours: null,
      high_risk_requires_per_takedown_approval: true,
    });
    expect(s.mode).toBe("semi_auto");
    expect(s.semi_auto_rules).toEqual(DEFAULT_SEMI_AUTO_RULES);
  });

  it("derives auto from legacy high_risk=false", () => {
    const s = normalizeScope({
      modules: ["domain"],
      max_takedowns_per_month: null,
      escalation: "auto_resubmit_on_pivot",
      auto_followup_breached_sla_hours: 48,
      high_risk_requires_per_takedown_approval: false,
    });
    expect(s.mode).toBe("auto");
  });

  it("keeps the legacy boolean coherent with an explicit mode", () => {
    expect(normalizeScope({ mode: "semi_auto" }).high_risk_requires_per_takedown_approval).toBe(true);
    expect(normalizeScope({ mode: "auto" }).high_risk_requires_per_takedown_approval).toBe(false);
    expect(normalizeScope({ mode: "off" }).high_risk_requires_per_takedown_approval).toBe(false);
  });

  it("defaults an empty object to a safe shape", () => {
    const s = normalizeScope({});
    expect(s.modules).toEqual([]);
    expect(s.mode).toBe("semi_auto"); // high_risk defaults true → semi_auto
    expect(s.max_takedowns_per_month).toBeNull();
  });
});
