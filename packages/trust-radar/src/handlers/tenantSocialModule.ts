// Averrow — Social Media Impersonation tenant module surface
//
// Mirrors handlers/tenantDomainModule.ts. Two endpoints:
//
//   GET /api/orgs/:orgId/modules/social
//     Per-brand summary: classification rollups across all brands
//     in the org (official, legitimate, suspicious, impersonation,
//     parked) + severity (HIGH+CRITICAL) counts.
//
//   GET /api/orgs/:orgId/modules/social/brands/:brandId
//     Per-brand drill-down: social_profiles rows with handle,
//     platform, classification, severity, AI assessment.
//
// Gates: org access + requireModule('social') + brand-membership
// via org_brands. super_admin bypasses for support flows.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import { requireModule, ModuleNotEntitledError } from "../lib/entitlements";

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

interface SocialBrandSummary {
  brand_id:               string;
  brand_name:             string;
  canonical_domain:       string;
  profiles_total:         number;
  profiles_official:      number;
  profiles_legitimate:    number;
  profiles_suspicious:    number;
  profiles_impersonation: number;
  profiles_parked:        number;
  profiles_high_critical: number;   // severity in (HIGH, CRITICAL)
}

// ─── GET /api/orgs/:orgId/modules/social ────────────────────────

export async function handleGetSocialModuleSummary(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "social");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Social Media Impersonation isn't enabled for your organization. Contact support@averrow.com.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  const result = await env.DB.prepare(
    `SELECT
       b.id AS brand_id,
       b.name AS brand_name,
       b.canonical_domain,
       (SELECT COUNT(*) FROM social_profiles sp WHERE sp.brand_id = b.id) AS profiles_total,
       (SELECT COUNT(*) FROM social_profiles sp WHERE sp.brand_id = b.id AND sp.classification = 'official') AS profiles_official,
       (SELECT COUNT(*) FROM social_profiles sp WHERE sp.brand_id = b.id AND sp.classification = 'legitimate') AS profiles_legitimate,
       (SELECT COUNT(*) FROM social_profiles sp WHERE sp.brand_id = b.id AND sp.classification = 'suspicious') AS profiles_suspicious,
       (SELECT COUNT(*) FROM social_profiles sp WHERE sp.brand_id = b.id AND sp.classification = 'impersonation') AS profiles_impersonation,
       (SELECT COUNT(*) FROM social_profiles sp WHERE sp.brand_id = b.id AND sp.classification = 'parked') AS profiles_parked,
       (SELECT COUNT(*) FROM social_profiles sp WHERE sp.brand_id = b.id AND sp.severity IN ('HIGH','CRITICAL')) AS profiles_high_critical
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE ob.org_id = ?
     ORDER BY ob.is_primary DESC, b.name`,
  ).bind(orgIdNum).all<SocialBrandSummary>();

  const brands = result.results ?? [];

  const totals = brands.reduce((acc, b) => ({
    profiles_total:         acc.profiles_total         + b.profiles_total,
    profiles_official:      acc.profiles_official      + b.profiles_official,
    profiles_legitimate:    acc.profiles_legitimate    + b.profiles_legitimate,
    profiles_suspicious:    acc.profiles_suspicious    + b.profiles_suspicious,
    profiles_impersonation: acc.profiles_impersonation + b.profiles_impersonation,
    profiles_parked:        acc.profiles_parked        + b.profiles_parked,
    profiles_high_critical: acc.profiles_high_critical + b.profiles_high_critical,
  }), {
    profiles_total: 0, profiles_official: 0, profiles_legitimate: 0,
    profiles_suspicious: 0, profiles_impersonation: 0, profiles_parked: 0,
    profiles_high_critical: 0,
  });

  return json({
    success: true,
    data: { org_id: orgIdNum, brands, totals },
  }, 200, origin);
}

// ─── GET /api/orgs/:orgId/modules/social/brands/:brandId ────────

export interface SocialProfileRow {
  id:                       string;
  brand_id:                 string;
  platform:                 string;
  handle:                   string;
  profile_url:              string | null;
  display_name:             string | null;
  bio:                      string | null;
  avatar_url:               string | null;
  followers_count:          number | null;
  verified:                 number;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_assessment:            string | null;
  impersonation_score:      number;
  impersonation_signals:    string | null;
  severity:                 string;
  status:                   string;
  created_at:               string;
}

export async function handleGetBrandSocialFindings(
  request: Request,
  env:     Env,
  orgId:   string,
  brandId: string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "social");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Social Media Impersonation isn't enabled for your organization.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  // Brand-ownership check via org_brands. super_admin bypasses.
  let brandOk: { id: string } | null = null;
  if (ctx.role === "super_admin") {
    brandOk = await env.DB.prepare(
      "SELECT id FROM brands WHERE id = ?",
    ).bind(brandId).first<{ id: string }>();
  } else {
    brandOk = await env.DB.prepare(
      `SELECT b.id FROM brands b
       JOIN org_brands ob ON ob.brand_id = b.id
       WHERE b.id = ? AND ob.org_id = ?`,
    ).bind(brandId, orgIdNum).first<{ id: string }>();
  }
  if (!brandOk) {
    return json({ success: false, error: "Brand not found" }, 404, origin);
  }

  const FINDINGS_LIMIT = 100;
  const profiles = await env.DB.prepare(
    `SELECT id, brand_id, platform, handle, profile_url, display_name,
            bio, avatar_url, followers_count, verified,
            classification, classified_by, classification_confidence,
            classification_reason, ai_assessment, impersonation_score,
            impersonation_signals, severity, status, created_at
     FROM social_profiles
     WHERE brand_id = ?
     ORDER BY
       CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
       CASE classification
         WHEN 'impersonation' THEN 1
         WHEN 'suspicious'    THEN 2
         WHEN 'parked'        THEN 3
         WHEN 'legitimate'    THEN 4
         WHEN 'official'      THEN 5
         ELSE 6
       END,
       created_at DESC
     LIMIT ?`,
  ).bind(brandId, FINDINGS_LIMIT).all<SocialProfileRow>();

  return json({
    success: true,
    data: {
      brand_id:  brandId,
      profiles:  profiles.results,
      page_size: FINDINGS_LIMIT,
    },
  }, 200, origin);
}
