/**
 * Lookalike Domain Scanner — Continuous monitoring for brand-impersonating domains.
 *
 * Generates permutations via dnstwist.ts, stores them in D1, and periodically
 * re-checks registration status via Cloudflare DoH. Newly registered domains
 * trigger AI assessment and alert creation.
 */

import { generatePermutations } from '../lib/dnstwist';
import { createAlert } from '../lib/alerts';
import { analyzeWithHaiku } from '../lib/haiku';
import { checkBIMIExists } from '../email-security';
import { checkDomain } from '../lib/domain-checker';
import { logger } from '../lib/logger';
import { DEFAULT_DEADLINE_MS } from '../lib/page-fetch';
import { escalateThreatLevelForPage } from '../lib/page-phishing-scorer';
import { runPageAnalysisForDomain } from './lookalike-page-analysis';
import type { Env } from '../types';

// Inline page-analysis budget for the newly-registered compositor. The
// broader re-check set is handled by analyzeLookalikePages (throttled);
// here we only fetch a bounded number of just-registered has_web domains
// per tick so a backfill surge can't blow the tick's wall-clock budget.
const INLINE_PAGE_FETCH_CAP = 10;
const INLINE_PAGE_BUDGET_MS = 60_000;

// ─── Generate & Store ────────────────────────────────────────────

/**
 * Generate domain permutations for a brand and store them in the
 * lookalike_domains table. Uses INSERT OR IGNORE to avoid duplicates.
 * Returns the count of newly inserted permutations.
 */
export async function generateAndStoreLookalikes(
  env: Env,
  brandId: string,
  domain: string,
): Promise<number> {
  const permutations = generatePermutations(domain);
  if (permutations.length === 0) return 0;

  let inserted = 0;

  // Batch insert in groups of 10 to stay within D1 limits
  const BATCH = 10;
  for (let i = 0; i < permutations.length; i += BATCH) {
    const batch = permutations.slice(i, i + BATCH);
    const stmts = batch.map((perm) => {
      const id = crypto.randomUUID();
      return env.DB.prepare(
        `INSERT OR IGNORE INTO lookalike_domains (id, brand_id, domain, permutation_type, unicode_domain)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(id, brandId, perm.domain, perm.type, perm.display ?? null);
    });

    const results = await env.DB.batch(stmts);
    for (const r of results) {
      if ((r.meta.changes ?? 0) > 0) inserted++;
    }
  }

  logger.info('lookalike_generate', {
    brand_id: brandId,
    domain,
    total_permutations: permutations.length,
    new_stored: inserted,
  });

  return inserted;
}

/**
 * Seed lookalike candidates for tenant-monitored brands that don't have
 * any yet. Without this, generateAndStoreLookalikes only ran via the
 * on-demand API handler, so the cron checker (checkLookalikeBatch) had an
 * empty candidate pool for nearly every brand and produced no findings.
 *
 * Generation is cheap (permutation inserts only — DNS/AI happens later in
 * the throttled checker), and org_brands is a small set, so we seed up to
 * `brandLimit` un-seeded brands per tick. Returns brands + candidates seeded.
 */
export async function seedLookalikesForOrgBrands(
  env: Env,
  brandLimit = 10,
): Promise<{ brands_seeded: number; candidates_created: number }> {
  const brands = await env.DB.prepare(
    `SELECT DISTINCT b.id AS brand_id, b.canonical_domain AS domain
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE b.canonical_domain IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lookalike_domains ld WHERE ld.brand_id = b.id)
     LIMIT ?`,
  ).bind(brandLimit).all<{ brand_id: string; domain: string }>();

  let brandsSeeded = 0;
  let candidatesCreated = 0;
  for (const b of brands.results) {
    const created = await generateAndStoreLookalikes(env, b.brand_id, b.domain);
    candidatesCreated += created;
    brandsSeeded++;
  }

  if (brandsSeeded > 0) {
    logger.info('lookalike_seed_org_brands', { brands_seeded: brandsSeeded, candidates_created: candidatesCreated });
  }

  return { brands_seeded: brandsSeeded, candidates_created: candidatesCreated };
}

// ─── Batch Check (called by cron) ────────────────────────────────

/**
 * Check a batch of lookalike domains for registration changes.
 * Called by the cron orchestrator every hour.
 *
 * 1. Queries domains that haven't been checked in 24 hours (LIMIT 50).
 * 2. For each, checks A record, MX record, and web availability.
 * 3. For newly registered domains, requests AI assessment and creates alerts.
 */
export async function checkLookalikeBatch(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT ld.id, ld.brand_id, ld.domain, ld.permutation_type, ld.registered, ld.unicode_domain
     FROM lookalike_domains ld
     WHERE ld.last_checked IS NULL
        OR ld.last_checked < datetime('now', '-24 hours')
     ORDER BY ld.last_checked ASC NULLS FIRST
     LIMIT 50`,
  ).all<{
    id: string;
    brand_id: string;
    domain: string;
    permutation_type: string;
    registered: number;
    unicode_domain: string | null;
  }>();

  if (rows.results.length === 0) {
    logger.info('lookalike_check', { message: 'no domains to check' });
    return;
  }

  let newRegistrations = 0;
  let totalChecked = 0;

  // Shared inline page-fetch budget across the whole tick (JS is single-
  // threaded between awaits, so the synchronous `remaining--` before each
  // fetch is race-free even under the concurrency below).
  const inlinePageBudget = { remaining: INLINE_PAGE_FETCH_CAP, runStart: Date.now() };

  // Process in batches of 5 concurrent checks
  const CONCURRENCY = 5;
  for (let i = 0; i < rows.results.length; i += CONCURRENCY) {
    const batch = rows.results.slice(i, i + CONCURRENCY);
    const checks = batch.map(async (row) => {
      totalChecked++;
      const result = await checkDomain(row.domain);

      // Update the record
      await env.DB.prepare(
        `UPDATE lookalike_domains
         SET registered = ?,
             resolves_to = ?,
             has_mx = ?,
             has_web = ?,
             last_checked = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(
        result.registered ? 1 : 0,
        result.ip ?? null,
        result.hasMx ? 1 : 0,
        result.hasWeb ? 1 : 0,
        row.id,
      ).run();

      // Detect NEWLY registered domains (was 0, now resolves)
      if (result.registered && row.registered === 0) {
        newRegistrations++;

        // Set first_seen
        await env.DB.prepare(
          `UPDATE lookalike_domains
           SET first_seen = datetime('now')
           WHERE id = ? AND first_seen IS NULL`,
        ).bind(row.id).run();

        // R7 (2026-05-07): brand_profiles retired. Pull brand context
        // straight from `brands`. user_id-as-owner is dead; alerts
        // attribute to 'system' (read-side scoping is via brand_id →
        // org_brands, not user_id).
        const brandRow = await env.DB.prepare(
          `SELECT name AS brand_name, canonical_domain AS domain
           FROM brands
           WHERE id = ?`,
        ).bind(row.brand_id).first<{
          brand_name: string;
          domain: string;
        }>();

        if (!brandRow) return;
        const brand = { ...brandRow, user_id: 'system' };

        // Request AI assessment
        let threatLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM';
        let aiAssessment = '';

        try {
          const aiResult = await analyzeWithHaiku(env, { agentId: "lookalike_scanner", runId: null },
            `Assess the threat level of this newly registered lookalike domain. Is it likely malicious brand impersonation or benign?
             Respond with JSON: {"threat_level": "LOW|MEDIUM|HIGH|CRITICAL", "assessment": "brief explanation", "indicators": ["list of suspicious indicators"]}`,
            {
              lookalike_domain: row.domain,
              original_domain: brand.domain,
              brand_name: brand.brand_name,
              permutation_type: row.permutation_type,
              resolves_to_ip: result.ip,
              has_mx_records: result.hasMx,
              has_web_server: result.hasWeb,
            },
          );

          if (aiResult.success && aiResult.data) {
            const structured = aiResult.data.structured as {
              threat_level?: string;
              assessment?: string;
            } | undefined;
            const responseText = aiResult.data.response ?? '';

            // Try to extract threat_level from structured data or response
            if (structured?.threat_level) {
              const level = structured.threat_level.toUpperCase();
              if (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(level)) {
                threatLevel = level as typeof threatLevel;
              }
            }
            aiAssessment = structured?.assessment ?? responseText;
          }
        } catch (err) {
          logger.error('lookalike_ai_assessment_error', {
            domain: row.domain,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Boost threat level based on infrastructure signals
        if (result.hasMx && result.hasWeb && threatLevel === 'MEDIUM') {
          threatLevel = 'HIGH';
        }

        // BIMI on a lookalike domain is extremely suspicious
        let hasBIMI = false;
        try {
          hasBIMI = await checkBIMIExists(row.domain);
          if (hasBIMI && threatLevel === 'MEDIUM') {
            threatLevel = 'HIGH';
          }
        } catch {
          // BIMI check failed — non-blocking
        }

        // Deterministic page-content analysis (D6 / S2.4). Slots the
        // page phishing score into this same threat_level compositor: a
        // credential-form-off-domain page escalates MEDIUM→HIGH/CRITICAL
        // (monotonic — never downgrades). Inline only for newly-
        // registered has_web domains and capped per tick; the throttled
        // analyzeLookalikePages pass re-checks the broader registered set.
        // All fetches funnel through the SSRF-safe fetchSuspectPage.
        if (
          result.hasWeb &&
          inlinePageBudget.remaining > 0 &&
          Date.now() - inlinePageBudget.runStart < INLINE_PAGE_BUDGET_MS
        ) {
          inlinePageBudget.remaining -= 1;
          try {
            const { phishing } = await runPageAnalysisForDomain(
              env,
              { id: row.id, domain: row.domain, brand_name: brand.brand_name, brand_domain: brand.domain },
              Date.now() + DEFAULT_DEADLINE_MS,
            );
            if (phishing) {
              threatLevel = escalateThreatLevelForPage(threatLevel, phishing);
            }
          } catch (err) {
            logger.error('lookalike_inline_page_error', {
              domain: row.domain,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Update threat level and AI assessment
        await env.DB.prepare(
          `UPDATE lookalike_domains
           SET threat_level = ?,
               ai_assessment = ?,
               updated_at = datetime('now')
           WHERE id = ?`,
        ).bind(threatLevel, aiAssessment, row.id).run();

        // Create alert via alerts pipeline. For IDN homoglyph variants the
        // stored `domain` is punycode (xn--…); surface the human-readable
        // unicode form (`аpple.com`) in the title so alerts aren't hostile.
        const displayDomain = row.unicode_domain ?? row.domain;
        const severity = threatLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
        const alertId = await createAlert(env.DB, {
          brandId: row.brand_id,
          userId: brand.user_id,
          alertType: 'lookalike_domain_active',
          severity,
          title: `Lookalike domain registered: ${displayDomain}`,
          summary: `A domain similar to ${brand.domain} (${row.permutation_type} variant) has been registered and is now active. ${result.hasWeb ? 'It has a web server.' : ''} ${result.hasMx ? 'It has MX records configured for email.' : ''}`.trim(),
          details: {
            lookalike_domain: row.domain,
            unicode_domain: row.unicode_domain ?? undefined,
            original_domain: brand.domain,
            permutation_type: row.permutation_type,
            resolves_to: result.ip,
            has_mx: result.hasMx,
            has_web: result.hasWeb,
          },
          sourceType: 'lookalike_scanner',
          sourceId: row.id,
          aiAssessment: aiAssessment || undefined,
          aiRecommendations: (['CRITICAL', 'HIGH'] as string[]).includes(threatLevel)
            ? [
                'Investigate the domain for brand impersonation content',
                'Consider filing a UDRP complaint or takedown request',
                'Monitor for phishing emails from this domain',
                'Alert customers if the domain is actively being used for phishing',
              ]
            : [
                'Continue monitoring for content changes',
                'Check periodically for brand impersonation',
              ],
        });

        // Link the alert back to the lookalike record
        await env.DB.prepare(
          `UPDATE lookalike_domains SET alert_id = ? WHERE id = ?`,
        ).bind(alertId, row.id).run();

        // Additional alert if lookalike has BIMI
        if (hasBIMI) {
          await createAlert(env.DB, {
            brandId: row.brand_id,
            userId: brand.user_id,
            alertType: 'typosquat_bimi',
            severity: 'HIGH',
            title: `Lookalike domain has BIMI record: ${displayDomain}`,
            summary: `The lookalike domain ${displayDomain} has published a BIMI ` +
              `record, suggesting it is attempting to display a trusted logo in email clients. ` +
              `This indicates a sophisticated phishing operation.`,
            details: {
              domain: row.domain,
              brand_domain: brand.domain,
              permutation_type: row.permutation_type,
            },
            sourceType: 'lookalike_scanner',
            sourceId: row.id,
          });
        }
      }
    });

    await Promise.all(checks);
  }

  logger.info('lookalike_check', {
    checked: totalChecked,
    new_registrations: newRegistrations,
  });
}

// checkDomain() moved to lib/domain-checker.ts for shared use with Sparrow Phase F
