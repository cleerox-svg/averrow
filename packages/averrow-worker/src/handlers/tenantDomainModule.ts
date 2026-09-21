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
import { verifyOrgAccess } from "../middleware/auth";
import type { AuthContext } from "../middleware/auth";
import { requireModule, ModuleNotEntitledError } from "../lib/entitlements";

// All threat_type values in the `threats` table are malicious-domain/URL
// threats, so the Domain module surfaces every type — not just
// typosquatting. Static literals (no user input) — safe to inline in SQL.
const DOMAIN_THREAT_TYPES =
  "'phishing','typosquatting','impersonation','malware_distribution','credential_harvesting','c2'";

// ─── Tenant org-access guard ────────────────────────────────────
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
  // Production threat-intel volume (threats table) attributed to the brand
  malicious_threats_total: number;
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
       (SELECT COUNT(*) FROM ct_certificates ct WHERE ct.brand_id = b.id AND ct.status = 'malicious') AS certs_malicious,
       (SELECT COUNT(*) FROM threats t WHERE t.target_brand_id = b.id AND t.status = 'active' AND t.threat_type IN (${DOMAIN_THREAT_TYPES})) AS malicious_threats_total
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
    malicious_threats_total: acc.malicious_threats_total + b.malicious_threats_total,
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
    malicious_threats_total: 0,
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

  // ── Page-content analysis (Wave 3 + Lane 3 / migration 0264) ─────
  // Read-only evidence produced by the deterministic page scorer
  // (`lib/page-phishing-scorer.ts`) via `scanners/lookalike-page-analysis.ts`.
  // Surfacing only — Lane 3 Phase 3 promotes nothing: the shadow fields
  // (`page_ai_signals` / `page_score_delta` / `page_generator` /
  // `page_exfil_sink*`) still do NOT move `page_phishing_score`,
  // `threat_level`, triage or escalation.
  //
  // NOT exposed: `page_evidence`. It stores a matched literal lifted
  // verbatim from attacker-controlled page content and is the one field
  // with no closed vocabulary. It stays staff-only (the staff handler's
  // `SELECT *` at `handlers/lookalikeDomains.ts:85` already carries it)
  // because a customer surface fans out to non-React sinks — CSV export,
  // email digests — where an unescaped attacker literal is a
  // content-injection hazard.
  /** ISO timestamp of the last fetch attempt; null = never scanned. */
  page_fetched_at:     string | null;
  page_http_status:    number | null;
  /** 0-100 deterministic score. Null when the page was never scored. */
  page_phishing_score: number | null;
  /** JSON array of fired scored-signal keys (closed vocabulary). */
  page_signals:        string | null;
  /** `turnstile|recaptcha|hcaptcha|cf_challenge|js_challenge` or null. */
  page_anti_bot_wall:  string | null;
  /** JSON array of fired Lane 3 shadow-signal keys (closed vocabulary). */
  page_ai_signals:     string | null;
  /** Shadow-only would-be contribution. NEVER added to page_phishing_score. */
  page_score_delta:    number | null;
  /** `<meta name="generator">` value — grouping dimension, weight 0. */
  page_generator:      string | null;
  /**
   * Host of the covert credential-exfil sink (attacker-controlled,
   * bounded to 253 chars at the extractor).
   *
   * SECURITY — MUST be defanged at every render site (e.g.
   * `t[.]me/…`) and MUST NEVER be rendered as a clickable link or
   * auto-linkified. Clicking it issues a live request to attacker C2
   * from an operator's or customer's corporate network. Same rule for
   * any CSV/email export that carries this field.
   */
  page_exfil_sink:     string | null;
  /** Telegram bot id / Discord webhook id from that sink — the pivot key. */
  page_exfil_sink_id:  string | null;
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
 * Malicious domain/URL threats attributed to the brand — sourced from
 * the `threats` table across all threat types (phishing, typosquatting,
 * impersonation, malware_distribution, credential_harvesting, c2) where
 * target_brand_id matches. Layered onto the GET response so the tenant
 * Domain Findings page surfaces the production threat-intel volume
 * (hundreds of K rows across the platform) alongside the smaller curated
 * lookalike_domains workspace.
 *
 * `takedown_status` is LEFT-JOINed from takedown_requests so the UI
 * can swap the "Request takedown" CTA for a status badge when one
 * is already in-flight.
 */
export interface MaliciousDomainRow {
  id:               string;
  threat_type:      string;
  malicious_domain: string | null;
  malicious_url:    string | null;
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
  // size; the dedicated Threats page (/tenant/threats) paginates the
  // full per-brand volume.
  //
  // Malicious domains/URLs: LEFT JOIN takedown_requests so the UI can
  // render a takedown-status badge when one is already in-flight (and
  // hide the "Request takedown" CTA). Match is by (org_id,
  // source_id=threat.id), taking the most recent request.
  const FINDINGS_LIMIT = 100;
  const [lookalikes, certs, maliciousDomains] = await Promise.all([
    env.DB.prepare(
      // Page-analysis evidence columns are appended to the explicit list
      // (Lane 3 Phase 3 step 15). Additive only — same WHERE, same
      // brand-scoped predicate, so this gains no cross-org reach: the
      // handler is already past verifyOrgAccess + requireModule + the
      // org_brands ownership check above, and `brandId` is bound, not
      // interpolated.
      //
      // `page_evidence` is DELIBERATELY ABSENT — attacker-controlled free
      // text with no closed vocabulary; staff-only. See LookalikeRow.
      //
      // SECURITY — `page_exfil_sink` is an attacker-controlled hostname.
      // It must be DEFANGED at every render site and MUST NEVER be a
      // clickable link (or auto-linkified in a CSV/email export): a click
      // requests live attacker C2 from the viewer's network.
      `SELECT id, brand_id, domain, permutation_type, registered, resolves_to,
              has_mx, has_web, first_seen, last_checked, threat_level,
              ai_assessment, status, created_at,
              page_fetched_at, page_http_status, page_phishing_score,
              page_signals, page_anti_bot_wall,
              page_ai_signals, page_score_delta, page_generator,
              page_exfil_sink, page_exfil_sink_id
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
      `SELECT t.id, t.threat_type, t.malicious_domain, t.malicious_url,
              t.source_feed, t.severity, t.status,
              t.first_seen, t.last_seen, hp.name AS hosting_provider, t.country_code,
              tr.status AS takedown_status, tr.id AS takedown_id
       FROM threats t
       LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
       LEFT JOIN takedown_requests tr
         ON tr.source_type = 'threat'
        AND tr.source_id = t.id
        AND tr.org_id = ?
       WHERE t.threat_type IN (${DOMAIN_THREAT_TYPES})
         AND t.target_brand_id = ?
         AND t.status = 'active'
       ORDER BY
         CASE t.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                          WHEN 'medium' THEN 2 ELSE 3 END,
         t.last_seen DESC
       LIMIT ?`,
    ).bind(orgIdNum, brandId, FINDINGS_LIMIT).all<MaliciousDomainRow>(),
  ]);

  return json({
    success: true,
    data: {
      brand_id: brandId,
      lookalikes: lookalikes.results,
      certs: certs.results,
      malicious_domains: maliciousDomains.results,
      page_size: FINDINGS_LIMIT,
    },
  }, 200, origin);
}
