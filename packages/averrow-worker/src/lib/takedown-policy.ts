// Averrow — takedown automation policy engine.
//
// Pure decision logic that classifies a single candidate takedown into
// one of three outcomes given the org's signed authorization scope:
//
//   'auto'     → submit automatically (subject to the other gates:
//                entitlement, module-in-scope, monthly cap, provider
//                auto_submit_enabled — those live in Sparrow Phase G).
//   'approval' → hold in 'draft' for a human to approve (move to
//                'requested') before it can be submitted.
//   'off'      → do nothing automated; fully manual.
//
// This is the "Semi-Auto" control surface the customer asked for:
//   - off       — Averrow drafts takedowns, submits nothing automatically.
//   - auto      — everything in scope auto-submits.
//   - semi_auto — auto-submit only takedowns whose characteristics
//                 (severity / target type / provider type) match the
//                 signed policy; everything else waits for approval.
//
// The function is intentionally pure (no env, no IO) so it can be unit
// tested exhaustively — see test/takedown-policy.test.ts.

import type { AuthorizationScope } from "./takedown-authorizations";

export type PolicyDecision = "auto" | "approval" | "off";

/** Canonical severity ladder (matches threats / takedown_requests.severity). */
export const POLICY_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type PolicySeverity = (typeof POLICY_SEVERITIES)[number];

/** takedown_requests.target_type domain. */
export const POLICY_TARGET_TYPES = [
  "domain",
  "social_profile",
  "url",
  "email",
  "mobile_app",
] as const;
export type PolicyTargetType = (typeof POLICY_TARGET_TYPES)[number];

/** takedown_providers.provider_type domain. */
export const POLICY_PROVIDER_TYPES = [
  "registrar",
  "hosting",
  "social_platform",
  "cdn",
  "email_provider",
  "reporting",
] as const;
export type PolicyProviderType = (typeof POLICY_PROVIDER_TYPES)[number];

/**
 * The semi-auto criteria. A takedown auto-submits under `semi_auto` only
 * when ALL three dimensional gates pass:
 *
 *   1. severity   ∈ auto_severities                 (required axis —
 *                                                     empty list ⇒ nothing
 *                                                     qualifies for auto)
 *   2. target_type — auto_target_types is empty (no restriction) OR
 *                    target_type ∈ auto_target_types
 *   3. provider_type — auto_provider_types is empty (no restriction) OR
 *                    provider_type ∈ auto_provider_types
 *
 * Anything that fails a gate is held for human approval.
 */
export interface SemiAutoRules {
  /** Severities safe to auto-submit. Typically the lower end (LOW/MEDIUM). */
  auto_severities: string[];
  /** Target types eligible for auto-submit. Empty = all target types pass. */
  auto_target_types: string[];
  /** Provider types eligible for auto-submit. Empty = all provider types pass. */
  auto_provider_types: string[];
}

/**
 * Conservative default applied to legacy authorizations that predate the
 * mode/rules fields, and the seed for a freshly chosen "Semi-Auto" posture
 * in the signing UI: auto-submit routine LOW/MEDIUM takedowns, hold
 * HIGH/CRITICAL for approval; no target/provider restriction.
 */
export const DEFAULT_SEMI_AUTO_RULES: SemiAutoRules = {
  auto_severities: ["LOW", "MEDIUM"],
  auto_target_types: [],
  auto_provider_types: [],
};

export interface TakedownCharacteristics {
  /** takedown_requests.severity (case-insensitive). */
  severity: string | null;
  /** takedown_requests.target_type. */
  target_type: string | null;
  /** takedown_providers.provider_type for the resolved provider. */
  provider_type: string | null;
  /**
   * True when a human has already approved this takedown (status moved to
   * 'requested'). An approved takedown auto-submits in any non-'off'
   * posture regardless of the semi-auto criteria.
   */
  human_approved?: boolean;
}

function matchesSemiAutoRules(
  rules: SemiAutoRules,
  c: TakedownCharacteristics,
): boolean {
  const sev = (c.severity ?? "").toUpperCase();
  // Severity is the required axis. An unknown/empty severity never auto-submits.
  if (!rules.auto_severities.map((s) => s.toUpperCase()).includes(sev)) {
    return false;
  }
  if (
    rules.auto_target_types.length > 0 &&
    !rules.auto_target_types.includes(c.target_type ?? "")
  ) {
    return false;
  }
  if (
    rules.auto_provider_types.length > 0 &&
    !rules.auto_provider_types.includes(c.provider_type ?? "")
  ) {
    return false;
  }
  return true;
}

/**
 * Decide whether a candidate takedown may auto-submit, must wait for
 * approval, or is fully off. Pure — no IO. Gating that requires DB/env
 * (entitlement, monthly cap, provider auto_submit_enabled) is layered on
 * top by the caller (Sparrow Phase G) and is orthogonal to this decision.
 */
export function evaluateTakedownPolicy(
  scope: AuthorizationScope,
  c: TakedownCharacteristics,
): PolicyDecision {
  // Off short-circuits everything — even a human-"approved" draft does not
  // auto-submit; the org has opted into fully-manual operation.
  if (scope.mode === "off") return "off";

  // Human-approved takedowns submit in both auto and semi_auto postures.
  if (c.human_approved) return "auto";

  if (scope.mode === "auto") return "auto";

  // semi_auto — characteristics decide.
  return matchesSemiAutoRules(scope.semi_auto_rules, c) ? "auto" : "approval";
}
