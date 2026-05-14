// Averrow — Domain Monitoring tenant module surface
//
// Two endpoints serve the customer-facing Domain Monitoring page:
//
//   GET /api/orgs/:orgId/modules/domain
//     Aggregate: per-brand finding counts (lookalikes by threat
//     level + status; CT certs by suspicious + status). Drives the
//     averrow-tenant module dashboard.
//
//   GET /api/orgs/:orgId/modules/domain/brands/:brandId
//     Per-brand drill-down: lookalike rows + CT cert rows with
//     pagination. Drives the brand detail view.
//
// Both endpoints gate on (a) tenant access to the org, (b) the org's
// `domain` module entitlement (entitlements.requireModule()), and
// for the drill-down (c) the brand belonging to org_brands.
//
// See:
//   - migrations/0031_lookalike_domains.sql
//   - migrations/0032_ct_monitor.sql
//   - lib/entitlements.ts (requireModule guard)

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import { requireModule, ModuleNotEntitledError } from "../lib/entitlements";

// ─── Tenant org-access guard ────────────────────────────────────
function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

interface BrandSummary {
  brand_id:                string;
  brand_name:              string;
  canonical_domain:        string;
  // Lookalike domain counts
  lookalikes_total:        number;
  lookalikes_registered:   number;
  lookalikes_critical:     number;
  lookalikes_high:         number;
  lookalikes_taken_down:   number;
  // CT certificate counts
  certs_total:             number;
  certs_suspicious:        number;
  certs_new:               number;
  certs_malicious:         number;
}

// ─── GET /api/orgs/:orgId/modules/domain ────────────────────────

export async function handleGetDomainModuleSummary(
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

  // Entitlement gate. super_admin bypasses (support flow); members
  // must have the module activated. Per `lib/entitlements.ts`.
  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "domain");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Domain Monitoring isn't enabled for your organization. Contact support@averrow.com.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  // Per-brand aggregate. Single query joining brands + org_brands +
  // lookalike + CT counts via correlated subqueries — D1 cost is
  // O(brands_in_org), which is small (<=10 typical, max ~20).
  const result = await env.DB.prepare(
    `SELECT
       b.id AS brand_id,
       b.name AS brand_name,
       b.canonical_domain,
       (SELECT COUNT(*) FROM lookalike_domains ld WHERE ld.brand_id = b.id) AS lookalikes_total,
       (SELECT COUNT(*) FROM lookalike_domains ld WHERE ld.brand_id = b.id AND ld.registered = 1) AS lookalikes_registered,
       (SELECT COUNT(*) FROM lookalike_domains ld WHERE ld.brand_id = b.id AND LOWER(ld.threat_level) = 'critical') AS lookalikes_critical,
       (SELECT COUNT(*) FROM lookalike_domains ld WHERE ld.brand_id = b.id AND LOWER(ld.threat_level) = 'high') AS lookalikes_high,
       (SELECT COUNT(*) FROM lookalike_domains ld WHERE ld.brand_id = b.id AND ld.status = 'taken_down') AS lookalikes_taken_down,
       (SELECT COUNT(*) FROM ct_certificates ct WHERE ct.brand_id = b.id) AS certs_total,
       (SELECT COUNT(*) FROM ct_certificates ct WHERE ct.brand_id = b.id AND ct.suspicious = 1) AS certs_suspicious,
       (SELECT COUNT(*) FROM ct_certificates ct WHERE ct.brand_id = b.id AND ct.status = 'new') AS certs_new,
       (SELECT COUNT(*) FROM ct_certificates ct WHERE ct.brand_id = b.id AND ct.status = 'malicious') AS certs_malicious
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE ob.org_id = ?
     ORDER BY ob.is_primary DESC, b.name`,
  ).bind(orgIdNum).all<BrandSummary>();

  const brands = result.results ?? [];

  // Roll up totals across brands so the dashboard can show a single
  // "you have X registered lookalikes" headline metric.
  const totals = brands.reduce((acc, b) => ({
    lookalikes_total:      acc.lookalikes_total      + b.lookalikes_total,
    lookalikes_registered: acc.lookalikes_registered + b.lookalikes_registered,
    lookalikes_critical:   acc.lookalikes_critical   + b.lookalikes_critical,
    lookalikes_high:       acc.lookalikes_high       + b.lookalikes_high,
    lookalikes_taken_down: acc.lookalikes_taken_down + b.lookalikes_taken_down,
    certs_total:           acc.certs_total           + b.certs_total,
    certs_suspicious:      acc.certs_suspicious      + b.certs_suspicious,
    certs_new:             acc.certs_new             + b.certs_new,
    certs_malicious:       acc.certs_malicious       + b.certs_malicious,
  }), {
    lookalikes_total:      0,
    lookalikes_registered: 0,
    lookalikes_critical:   0,
    lookalikes_high:       0,
    lookalikes_taken_down: 0,
    certs_total:           0,
    certs_suspicious:      0,
    certs_new:             0,
    certs_malicious:       0,
  });

  return json({
    success: true,
    data: { org_id: orgIdNum, brands, totals },
  }, 200, origin);
}

// ─── GET /api/orgs/:orgId/modules/domain/brands/:brandId ─────────

export interface LookalikeRow {
  id:               string;
  brand_id:         string;
  domain:           string;
  permutation_type: string;
  registered:       number;
  resolves_to:      string | null;
  has_mx:           number;
  has_web:          number;
  first_seen:       string | null;
  last_checked:     string | null;
  threat_level:     string;
  ai_assessment:    string | null;
  status:           string;
  created_at:       string;
}

export interface CertRow {
  id:            string;
  brand_id:      string;
  domain:        string;
  issuer:        string | null;
  suspicious:    number;
  ai_assessment: string | null;
  status:        string;
  created_at:    string;
}

/**
 * Typosquat threats attributed to the brand — sourced from the
 * `threats` table where threat_type='typosquatting' AND
 * target_brand_id matches. Layered onto the GET response so the
 * tenant Domain Findings page can surface the production threat-intel
 * volume (24K+ rows across the platform) alongside the smaller
 * curated lookalike_domains workspace.
 *
 * `takedown_status` is LEFT-JOINed from takedown_requests so the UI
 * can swap the "Request takedown" CTA for a status badge when one
 * is already in-flight.
 */
export interface TyposquatRow {
  id:               string;
  malicious_domain: string;
  source_feed:      string;
  severity:         string;
  status:           string;
  first_seen:       string | null;
  last_seen:        string | null;
  hosting_provider: string | null;
  country_code:     string | null;
  takedown_status:  string | null;
  takedown_id:      string | null;
}

export async function handleGetBrandDomainFindings(
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

  // Entitlement gate.
  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "domain");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Domain Monitoring isn't enabled for your organization.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  // Brand-ownership check via org_brands. super_admin bypasses for
  // support flows.
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

  // Read all three finding types in parallel. Cap at a sensible page
  // size; a future "view all" page can paginate.
  //
  // Typosquats: LEFT JOIN takedown_requests so the UI can render a
  // takedown-status badge when one is already in-flight (and hide the
  // "Request takedown" CTA). Match is by (org_id, target_value=domain)
  // — taking the most recent request if there are multiple historical
  // ones for the same domain.
  const FINDINGS_LIMIT = 100;
  const [lookalikes, certs, typosquats] = await Promise.all([
    env.DB.prepare(
      `SELECT id, brand_id, domain, permutation_type, registered, resolves_to,
              has_mx, has_web, first_seen, last_checked, threat_level,
              ai_assessment, status, created_at
       FROM lookalike_domains
       WHERE brand_id = ?
       ORDER BY registered DESC, threat_level DESC, created_at DESC
       LIMIT ?`,
    ).bind(brandId, FINDINGS_LIMIT).all<LookalikeRow>(),
    env.DB.prepare(
      `SELECT id, brand_id, domain, issuer, suspicious, ai_assessment, status, created_at
       FROM ct_certificates
       WHERE brand_id = ?
       ORDER BY suspicious DESC, created_at DESC
       LIMIT ?`,
    ).bind(brandId, FINDINGS_LIMIT).all<CertRow>(),
    env.DB.prepare(
      `SELECT t.id, t.malicious_domain, t.source_feed, t.severity, t.status,
              t.first_seen, t.last_seen, t.hosting_provider, t.country_code,
              tr.status AS takedown_status, tr.id AS takedown_id
       FROM threats t
       LEFT JOIN takedown_requests tr
         ON tr.source_type = 'threat'
        AND tr.source_id = t.id
        AND tr.org_id = ?
       WHERE t.threat_type = 'typosquatting'
         AND t.target_brand_id = ?
         AND t.status = 'active'
       ORDER BY
         CASE t.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                          WHEN 'medium' THEN 2 ELSE 3 END,
         t.first_seen DESC
       LIMIT ?`,
    ).bind(orgIdNum, brandId, FINDINGS_LIMIT).all<TyposquatRow>(),
  ]);

  return json({
    success: true,
    data: {
      brand_id: brandId,
      lookalikes: lookalikes.results,
      certs: certs.results,
      typosquats: typosquats.results,
      page_size: FINDINGS_LIMIT,
    },
  }, 200, origin);
}
