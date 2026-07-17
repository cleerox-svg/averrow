/**
 * Trademark Monitor — Phase 1 (zero-cost, internal correlation).
 *
 * The trademark module's value is a UNIFIED, mark-centric view of brand
 * misuse. Phase 1 produces that view with NO external dependency or spend:
 *
 *   Assets   — seed each monitored brand's own marks from the `brands`
 *              table: a wordmark (brand name) and, when we already have a
 *              logo perceptual hash (brands.logo_hash), a logo asset.
 *
 *   Findings — correlate the brand's wordmark against signals already
 *              collected by other scanners and surface them as trademark
 *              misuse, tagged by `found_context`:
 *                social      — impersonation/suspicious social profiles
 *                app_store   — impersonation/suspicious app listings
 *                website     — typosquatting threats + registered lookalikes
 *                              (the brand wordmark embedded in a domain)
 *
 * Classification is DERIVED from each source row's own verdict (no AI
 * spend): impersonation -> confirmed, suspicious/high-severity -> likely,
 * else unknown.
 *
 * Phase 2 (logo/image misuse via perceptual-hash crawling + a vision /
 * reverse-image API) is documented in docs/TRADEMARK_MONITORING.md and
 * gated behind paid integrations — deferred until there's customer demand.
 *
 * Scope: org_brands (brands under active tenant monitoring) — trademark is
 * an entitlement-gated tenant module. Set-based INSERT…SELECT keeps this to
 * a handful of statements regardless of brand count; all writes are
 * idempotent (INSERT OR IGNORE on deterministic ids + the dedup unique
 * index), so it is safe to re-run every tick.
 */

import { logger } from "../lib/logger";
import type { Env } from "../types";

// Threat types whose domain embeds the brand wordmark = classic
// trademark/cybersquatting misuse. Other threat types target the brand
// but don't misuse the mark, so they stay out of the trademark view.
const WORDMARK_DOMAIN_THREAT_TYPES = "'typosquatting'";

export interface TrademarkScanResult {
  assets_seeded:   number;
  findings_created: number;
  [key: string]:   number;
}

export async function runTrademarkScanBatch(env: Env): Promise<TrademarkScanResult> {
  let assetsSeeded = 0;
  let findingsCreated = 0;

  // ── 1. Seed baseline assets from the brands table (free, internal) ──
  // Wordmark: one per monitored brand, deterministic id so re-runs no-op.
  const wordmark = await env.DB.prepare(
    `INSERT OR IGNORE INTO trademark_assets
       (id, brand_id, asset_type, asset_name, status, created_by)
     SELECT 'tm-asset-wordmark-' || b.id, b.id, 'wordmark', b.name, 'active', 'system'
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE b.name IS NOT NULL`,
  ).run();
  assetsSeeded += wordmark.meta.changes ?? 0;

  // Logo: only when we already have a perceptual hash for the brand logo.
  const logo = await env.DB.prepare(
    `INSERT OR IGNORE INTO trademark_assets
       (id, brand_id, asset_type, asset_name, asset_url, phash, status, created_by)
     SELECT 'tm-asset-logo-' || b.id, b.id, 'logo', b.name || ' logo',
            b.logo_url, b.logo_hash, 'active', 'system'
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE b.logo_hash IS NOT NULL`,
  ).run();
  assetsSeeded += logo.meta.changes ?? 0;

  // ── 2. Correlate findings from existing signals (free, internal) ──
  // Each finding links to the brand's wordmark asset and carries a derived
  // classification/severity. Dedup is enforced by the deterministic id (PK)
  // and the (brand_id, found_url, asset_id) unique index.

  // Social profile misuse.
  const social = await env.DB.prepare(
    `INSERT OR IGNORE INTO trademark_findings
       (id, brand_id, asset_id, found_url, found_context, found_image_url,
        classification, classified_by, classification_reason, severity, status,
        first_seen, last_seen)
     SELECT 'tm-find-social-' || sp.id, sp.brand_id, 'tm-asset-wordmark-' || sp.brand_id,
            COALESCE(sp.profile_url, sp.platform || ':' || sp.handle), 'social', sp.avatar_url,
            CASE sp.classification WHEN 'impersonation' THEN 'confirmed'
                                   WHEN 'suspicious'    THEN 'likely' ELSE 'unknown' END,
            'system',
            'Brand handle misuse detected by social monitoring (' || sp.classification || ')',
            UPPER(COALESCE(sp.severity, 'LOW')), 'active',
            datetime('now'), datetime('now')
     FROM social_profiles sp
     JOIN org_brands ob ON ob.brand_id = sp.brand_id
     WHERE sp.classification IN ('impersonation', 'suspicious') AND sp.status = 'active'`,
  ).run();
  findingsCreated += social.meta.changes ?? 0;

  // App-store listing misuse.
  const app = await env.DB.prepare(
    `INSERT OR IGNORE INTO trademark_findings
       (id, brand_id, asset_id, found_url, found_context, found_image_url,
        classification, classified_by, classification_reason, severity, status,
        first_seen, last_seen)
     SELECT 'tm-find-app-' || al.id, al.brand_id, 'tm-asset-wordmark-' || al.brand_id,
            COALESCE(al.app_url, al.store || ':' || al.app_id), 'app_store', al.icon_url,
            CASE al.classification WHEN 'impersonation' THEN 'confirmed'
                                   WHEN 'suspicious'    THEN 'likely' ELSE 'unknown' END,
            'system',
            'Brand misuse in app-store listing (' || al.classification || ')',
            UPPER(COALESCE(al.severity, 'LOW')), 'active',
            datetime('now'), datetime('now')
     FROM app_store_listings al
     JOIN org_brands ob ON ob.brand_id = al.brand_id
     WHERE al.classification IN ('impersonation', 'suspicious') AND al.status = 'active'`,
  ).run();
  findingsCreated += app.meta.changes ?? 0;

  // Wordmark embedded in typosquatting domains.
  const typosquat = await env.DB.prepare(
    `INSERT OR IGNORE INTO trademark_findings
       (id, brand_id, asset_id, found_url, found_context,
        classification, classified_by, classification_reason, severity, status,
        first_seen, last_seen)
     SELECT 'tm-find-domain-' || t.id, t.target_brand_id, 'tm-asset-wordmark-' || t.target_brand_id,
            COALESCE(t.malicious_url, t.malicious_domain), 'website',
            CASE WHEN LOWER(t.severity) IN ('critical', 'high') THEN 'likely' ELSE 'unknown' END,
            'system', 'Brand wordmark embedded in typosquatting domain',
            UPPER(COALESCE(t.severity, 'LOW')), 'active',
            datetime('now'), datetime('now')
     FROM threats t
     JOIN org_brands ob ON ob.brand_id = t.target_brand_id
     WHERE t.threat_type IN (${WORDMARK_DOMAIN_THREAT_TYPES})
       AND t.status = 'active'
       AND COALESCE(t.malicious_url, t.malicious_domain) IS NOT NULL`,
  ).run();
  findingsCreated += typosquat.meta.changes ?? 0;

  // Wordmark in registered lookalike domains.
  const lookalike = await env.DB.prepare(
    `INSERT OR IGNORE INTO trademark_findings
       (id, brand_id, asset_id, found_url, found_context,
        classification, classified_by, classification_reason, severity, status,
        first_seen, last_seen)
     SELECT 'tm-find-lookalike-' || ld.id, ld.brand_id, 'tm-asset-wordmark-' || ld.brand_id,
            ld.domain, 'website',
            CASE WHEN LOWER(ld.threat_level) IN ('critical', 'high') THEN 'likely' ELSE 'unknown' END,
            'system', 'Brand wordmark in registered lookalike domain',
            UPPER(COALESCE(ld.threat_level, 'LOW')), 'active',
            datetime('now'), datetime('now')
     FROM lookalike_domains ld
     JOIN org_brands ob ON ob.brand_id = ld.brand_id
     WHERE ld.registered = 1 AND ld.status NOT IN ('benign', 'taken_down')`,
  ).run();
  findingsCreated += lookalike.meta.changes ?? 0;

  logger.info("trademark_scan_complete", { assets_seeded: assetsSeeded, findings_created: findingsCreated });

  return { assets_seeded: assetsSeeded, findings_created: findingsCreated };
}
