// Averrow — Dark Web Monitoring tenant module surface
//
// Mirrors handlers/tenantAppStoreModule.ts for the dark_web_mentions
// table. Two endpoints:
//
//   GET /api/orgs/:orgId/modules/dark-web
//     Per-brand summary across sources (pastebin, telegram, hibp,
//     flare, darkowl, …).
//
//   GET /api/orgs/:orgId/modules/dark-web/brands/:brandId
//     Per-brand drill-down: mentions with classification +
//     severity, ordered by severity → classification → recency.
//
// Phase B sprint 5.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import { requireModule, ModuleNotEntitledError } from "../lib/entitlements";

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

interface DarkWebBrandSummary {
  brand_id:                string;
  brand_name:              string;
  canonical_domain:        string;
  mentions_total:          number;
  mentions_confirmed:      number;
  mentions_suspicious:     number;
  mentions_unknown:        number;
  mentions_false_positive: number;
  mentions_high_critical:  number;
  sources_covered:         number;   // distinct sources for this brand's mentions
}

// ─── GET /api/orgs/:orgId/modules/dark-web ──────────────────────

export async function handleGetDarkWebModuleSummary(
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
      await requireModule(env, orgIdNum, "dark_web");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Dark Web Monitoring isn't enabled for your organization. Contact support@averrow.com.",
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
       (SELECT COUNT(*) FROM dark_web_mentions dwm WHERE dwm.brand_id = b.id AND dwm.status = 'active') AS mentions_total,
       (SELECT COUNT(*) FROM dark_web_mentions dwm WHERE dwm.brand_id = b.id AND dwm.status = 'active' AND dwm.classification = 'confirmed') AS mentions_confirmed,
       (SELECT COUNT(*) FROM dark_web_mentions dwm WHERE dwm.brand_id = b.id AND dwm.status = 'active' AND dwm.classification = 'suspicious') AS mentions_suspicious,
       (SELECT COUNT(*) FROM dark_web_mentions dwm WHERE dwm.brand_id = b.id AND dwm.status = 'active' AND dwm.classification = 'unknown') AS mentions_unknown,
       (SELECT COUNT(*) FROM dark_web_mentions dwm WHERE dwm.brand_id = b.id AND dwm.classification = 'false_positive') AS mentions_false_positive,
       (SELECT COUNT(*) FROM dark_web_mentions dwm WHERE dwm.brand_id = b.id AND dwm.status = 'active' AND LOWER(dwm.severity) IN ('high','critical')) AS mentions_high_critical,
       (SELECT COUNT(DISTINCT dwm.source) FROM dark_web_mentions dwm WHERE dwm.brand_id = b.id AND dwm.status = 'active') AS sources_covered
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE ob.org_id = ?
     ORDER BY ob.is_primary DESC, b.name`,
  ).bind(orgIdNum).all<DarkWebBrandSummary>();

  const brands = result.results ?? [];

  const totals = brands.reduce((acc, b) => ({
    mentions_total:          acc.mentions_total          + b.mentions_total,
    mentions_confirmed:      acc.mentions_confirmed      + b.mentions_confirmed,
    mentions_suspicious:     acc.mentions_suspicious     + b.mentions_suspicious,
    mentions_unknown:        acc.mentions_unknown        + b.mentions_unknown,
    mentions_false_positive: acc.mentions_false_positive + b.mentions_false_positive,
    mentions_high_critical:  acc.mentions_high_critical  + b.mentions_high_critical,
  }), {
    mentions_total: 0, mentions_confirmed: 0, mentions_suspicious: 0,
    mentions_unknown: 0, mentions_false_positive: 0, mentions_high_critical: 0,
  });

  return json({
    success: true,
    data: { org_id: orgIdNum, brands, totals },
  }, 200, origin);
}

// ─── GET /api/orgs/:orgId/modules/dark-web/brands/:brandId ──────

export interface DarkWebMentionRow {
  id:                       string;
  brand_id:                 string;
  source:                   string;
  source_url:               string;
  source_channel:           string | null;
  source_author:            string | null;
  posted_at:                string | null;
  content_snippet:          string | null;
  matched_terms:            string | null;
  match_type:               string | null;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_assessment:            string | null;
  ai_action:                string | null;
  severity:                 string;
  status:                   string;
  first_seen:               string;
  last_seen:                string | null;
}

export async function handleGetBrandDarkWebFindings(
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
      await requireModule(env, orgIdNum, "dark_web");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Dark Web Monitoring isn't enabled for your organization.",
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
  const mentions = await env.DB.prepare(
    `SELECT id, brand_id, source, source_url, source_channel, source_author,
            posted_at, content_snippet, matched_terms, match_type,
            classification, classified_by, classification_confidence,
            classification_reason, ai_assessment, ai_action,
            severity, status, first_seen, last_seen
     FROM dark_web_mentions
     WHERE brand_id = ? AND status != 'resolved'
     ORDER BY
       CASE LOWER(severity) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       CASE classification
         WHEN 'confirmed'      THEN 1
         WHEN 'suspicious'     THEN 2
         WHEN 'unknown'        THEN 3
         WHEN 'false_positive' THEN 4
         ELSE 5
       END,
       COALESCE(posted_at, first_seen) DESC
     LIMIT ?`,
  ).bind(brandId, FINDINGS_LIMIT).all<DarkWebMentionRow>();

  return json({
    success: true,
    data: {
      brand_id:  brandId,
      mentions:  mentions.results,
      page_size: FINDINGS_LIMIT,
    },
  }, 200, origin);
}
