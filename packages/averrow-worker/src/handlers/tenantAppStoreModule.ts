// Averrow — App Store Impersonation tenant module surface
//
// Mirrors handlers/tenantSocialModule.ts for the app_store_listings
// table. Two endpoints:
//
//   GET /api/orgs/:orgId/modules/app-store
//     Per-brand summary across stores (ios, google_play, apkpure, …).
//
//   GET /api/orgs/:orgId/modules/app-store/brands/:brandId
//     Per-brand drill-down: app listings with classification +
//     severity, ordered by severity → classification → recency.
//
// Phase B sprint 4.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import { requireModule, ModuleNotEntitledError } from "../lib/entitlements";

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

interface AppStoreBrandSummary {
  brand_id:                string;
  brand_name:              string;
  canonical_domain:        string;
  apps_total:              number;
  apps_official:           number;
  apps_legitimate:         number;
  apps_suspicious:         number;
  apps_impersonation:      number;
  apps_high_critical:      number;
  stores_covered:          number;   // distinct stores for this brand's apps
}

// ─── GET /api/orgs/:orgId/modules/app-store ─────────────────────

export async function handleGetAppStoreModuleSummary(
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
      await requireModule(env, orgIdNum, "app_store");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "App Store Impersonation isn't enabled for your organization. Contact support@averrow.com.",
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
       (SELECT COUNT(*) FROM app_store_listings al WHERE al.brand_id = b.id) AS apps_total,
       (SELECT COUNT(*) FROM app_store_listings al WHERE al.brand_id = b.id AND al.classification = 'official') AS apps_official,
       (SELECT COUNT(*) FROM app_store_listings al WHERE al.brand_id = b.id AND al.classification = 'legitimate') AS apps_legitimate,
       (SELECT COUNT(*) FROM app_store_listings al WHERE al.brand_id = b.id AND al.classification = 'suspicious') AS apps_suspicious,
       (SELECT COUNT(*) FROM app_store_listings al WHERE al.brand_id = b.id AND al.classification = 'impersonation') AS apps_impersonation,
       (SELECT COUNT(*) FROM app_store_listings al WHERE al.brand_id = b.id AND LOWER(al.severity) IN ('high','critical')) AS apps_high_critical,
       (SELECT COUNT(DISTINCT al.store) FROM app_store_listings al WHERE al.brand_id = b.id) AS stores_covered
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE ob.org_id = ?
     ORDER BY ob.is_primary DESC, b.name`,
  ).bind(orgIdNum).all<AppStoreBrandSummary>();

  const brands = result.results ?? [];

  const totals = brands.reduce((acc, b) => ({
    apps_total:         acc.apps_total         + b.apps_total,
    apps_official:      acc.apps_official      + b.apps_official,
    apps_legitimate:    acc.apps_legitimate    + b.apps_legitimate,
    apps_suspicious:    acc.apps_suspicious    + b.apps_suspicious,
    apps_impersonation: acc.apps_impersonation + b.apps_impersonation,
    apps_high_critical: acc.apps_high_critical + b.apps_high_critical,
  }), {
    apps_total: 0, apps_official: 0, apps_legitimate: 0,
    apps_suspicious: 0, apps_impersonation: 0, apps_high_critical: 0,
  });

  return json({
    success: true,
    data: { org_id: orgIdNum, brands, totals },
  }, 200, origin);
}

// ─── GET /api/orgs/:orgId/modules/app-store/brands/:brandId ─────

export interface AppStoreListingRow {
  id:                       string;
  brand_id:                 string;
  store:                    string;
  app_id:                   string;
  bundle_id:                string | null;
  app_name:                 string;
  developer_name:           string | null;
  developer_id:             string | null;
  app_url:                  string | null;
  icon_url:                 string | null;
  rating:                   number | null;
  rating_count:             number | null;
  release_date:             string | null;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_assessment:            string | null;
  impersonation_score:      number;
  severity:                 string;
  status:                   string;
  created_at:               string;
}

export async function handleGetBrandAppStoreFindings(
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
      await requireModule(env, orgIdNum, "app_store");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "App Store Impersonation isn't enabled for your organization.",
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
  const listings = await env.DB.prepare(
    `SELECT id, brand_id, store, app_id, bundle_id, app_name,
            developer_name, developer_id, app_url, icon_url,
            rating, rating_count, release_date,
            classification, classified_by, classification_confidence,
            classification_reason, ai_assessment, impersonation_score,
            severity, status, created_at
     FROM app_store_listings
     WHERE brand_id = ?
     ORDER BY
       CASE LOWER(severity) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       CASE classification
         WHEN 'impersonation' THEN 1
         WHEN 'suspicious'    THEN 2
         WHEN 'legitimate'    THEN 3
         WHEN 'official'      THEN 4
         ELSE 5
       END,
       created_at DESC
     LIMIT ?`,
  ).bind(brandId, FINDINGS_LIMIT).all<AppStoreListingRow>();

  return json({
    success: true,
    data: {
      brand_id:  brandId,
      listings:  listings.results,
      page_size: FINDINGS_LIMIT,
    },
  }, 200, origin);
}
