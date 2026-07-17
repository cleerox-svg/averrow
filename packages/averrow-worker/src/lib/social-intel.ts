/**
 * Shared Social Intelligence Data Fetcher
 *
 * Provides a unified interface for all agents to retrieve social monitoring
 * intelligence for a given brand. Queries the social_profiles table and
 * aggregates stats, risk metrics, and impersonation details.
 */

import type { Env } from "../types";

export interface BrandSocialIntel {
  // Summary stats
  totalProfiles: number;
  officialProfiles: number;
  suspiciousProfiles: number;
  impersonationProfiles: number;
  platformsCovered: string[];
  platformsWithImpersonation: string[];

  // Risk metrics
  socialRiskScore: number | null;        // 0-100
  highestSeverity: string | null;        // CRITICAL|HIGH|MEDIUM|LOW
  aiTakedownRecommendations: number;     // count where ai_action = 'takedown'

  // Recent activity
  newProfilesLast24h: number;
  newImpersonationsLast24h: number;
  profilesNeedingReview: number;         // where ai_action = 'review'

  // Detail for AI context
  impersonationSummaries: Array<{
    platform: string;
    handle: string;
    severity: string;
    confidence: number;
    reasoning: string;
    signals: string[];
  }>;

  // Official handles status
  officialHandles: Record<string, string>;
  handlesVerified: Record<string, boolean>;
}

export async function getBrandSocialIntel(
  env: Env,
  brandId: string,
): Promise<BrandSocialIntel> {
  // Default empty result
  const empty: BrandSocialIntel = {
    totalProfiles: 0,
    officialProfiles: 0,
    suspiciousProfiles: 0,
    impersonationProfiles: 0,
    platformsCovered: [],
    platformsWithImpersonation: [],
    socialRiskScore: null,
    highestSeverity: null,
    aiTakedownRecommendations: 0,
    newProfilesLast24h: 0,
    newImpersonationsLast24h: 0,
    profilesNeedingReview: 0,
    impersonationSummaries: [],
    officialHandles: {},
    handlesVerified: {},
  };

  try {
    // 1. Aggregate stats
    const stats = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN classification = 'official' THEN 1 ELSE 0 END) AS official,
        SUM(CASE WHEN classification = 'suspicious' AND status = 'active' THEN 1 ELSE 0 END) AS suspicious,
        SUM(CASE WHEN classification = 'impersonation' AND status = 'active' THEN 1 ELSE 0 END) AS impersonation,
        SUM(CASE WHEN ai_action = 'takedown' AND status = 'active' THEN 1 ELSE 0 END) AS takedown_recommended,
        SUM(CASE WHEN ai_action = 'review' AND status = 'active' THEN 1 ELSE 0 END) AS needs_review,
        SUM(CASE WHEN created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS new_24h,
        SUM(CASE WHEN classification = 'impersonation' AND created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS new_impersonations_24h
      FROM social_profiles
      WHERE brand_id = ?
    `).bind(brandId).first<{
      total: number; official: number; suspicious: number; impersonation: number;
      takedown_recommended: number; needs_review: number; new_24h: number; new_impersonations_24h: number;
    }>();

    if (!stats || stats.total === 0) return empty;

    // 2. Platforms covered
    const platforms = await env.DB.prepare(`
      SELECT DISTINCT platform FROM social_profiles WHERE brand_id = ?
    `).bind(brandId).all<{ platform: string }>();

    const platformsWithImpersonation = await env.DB.prepare(`
      SELECT DISTINCT platform FROM social_profiles
      WHERE brand_id = ? AND classification = 'impersonation' AND status = 'active'
    `).bind(brandId).all<{ platform: string }>();

    // 3. Highest severity
    const highestSev = await env.DB.prepare(`
      SELECT severity FROM social_profiles
      WHERE brand_id = ? AND status = 'active' AND classification IN ('suspicious', 'impersonation')
      ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END
      LIMIT 1
    `).bind(brandId).first<{ severity: string }>();

    // 4. Top impersonation details
    const topImpersonations = await env.DB.prepare(`
      SELECT platform, handle, severity, ai_confidence, classification_reason, impersonation_signals
      FROM social_profiles
      WHERE brand_id = ? AND status = 'active' AND classification IN ('suspicious', 'impersonation')
      ORDER BY
        CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
        ai_confidence DESC
      LIMIT 10
    `).bind(brandId).all<{
      platform: string; handle: string; severity: string;
      ai_confidence: number | null; classification_reason: string | null;
      impersonation_signals: string | null;
    }>();

    // 5. Official handles from brands table
    const brandData = await env.DB.prepare(
      "SELECT official_handles, social_risk_score FROM brands WHERE id = ?"
    ).bind(brandId).first<{ official_handles: string | null; social_risk_score: number | null }>();

    let officialHandles: Record<string, string> = {};
    try {
      officialHandles = brandData?.official_handles ? JSON.parse(brandData.official_handles) : {};
    } catch { /* ignore */ }

    // 6. Check which official handles have matching official profiles
    const handlesVerified: Record<string, boolean> = {};
    for (const platform of Object.keys(officialHandles)) {
      const handle = officialHandles[platform]?.replace(/^@/, '');
      if (!handle) continue;
      const match = await env.DB.prepare(
        "SELECT id FROM social_profiles WHERE brand_id = ? AND platform = ? AND handle = ? AND classification = 'official'"
      ).bind(brandId, platform, handle).first();
      handlesVerified[platform] = !!match;
    }

    return {
      totalProfiles: stats.total,
      officialProfiles: stats.official ?? 0,
      suspiciousProfiles: stats.suspicious ?? 0,
      impersonationProfiles: stats.impersonation ?? 0,
      platformsCovered: platforms.results.map(p => p.platform),
      platformsWithImpersonation: platformsWithImpersonation.results.map(p => p.platform),
      socialRiskScore: brandData?.social_risk_score ?? null,
      highestSeverity: highestSev?.severity ?? null,
      aiTakedownRecommendations: stats.takedown_recommended ?? 0,
      newProfilesLast24h: stats.new_24h ?? 0,
      newImpersonationsLast24h: stats.new_impersonations_24h ?? 0,
      profilesNeedingReview: stats.needs_review ?? 0,
      impersonationSummaries: topImpersonations.results.map(s => {
        let signals: string[] = [];
        try { signals = s.impersonation_signals ? JSON.parse(s.impersonation_signals) : []; } catch { /* ignore */ }
        return {
          platform: s.platform,
          handle: s.handle,
          severity: s.severity,
          confidence: s.ai_confidence ?? 0,
          reasoning: s.classification_reason ?? '',
          signals,
        };
      }),
      officialHandles,
      handlesVerified,
    };
  } catch (err) {
    console.error("[social-intel] Error fetching brand social intel:", err);
    return empty;
  }
}
