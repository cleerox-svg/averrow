/**
 * Social Brand Monitoring Pipeline
 *
 * Scans social media platforms for handle squatting and impersonation
 * of monitored brands. Runs on a cron schedule (every 6 hours) and
 * can be triggered on-demand per brand.
 *
 * Unified model: operates on brands.id and writes to social_profiles table.
 */

import type { Env } from '../types';
import { checkSocialHandles, type SocialCheckResult } from '../lib/social-check';
import { normalizeHandleForPlatform } from '../lib/handle-normalize';
import { generateHandlePermutations } from '../lib/handle-permutations';
import { scoreImpersonation, nameSimilarity, type ImpersonationSignals } from './impersonation-scorer';
import { createAlert } from '../lib/alerts';
import { emitOrgEvent } from '../lib/org-events';
import { logger } from '../lib/logger';
import { discoverSocialProfiles } from '../lib/social-discovery';
import { runSyncAgent } from '../lib/agentRunner';
import {
  socialAiAssessorAgent,
  type SocialAiAssessorInput,
  type SocialAiAssessorOutput,
} from '../agents/social-ai-assessor';
import { computeBrandExposureScore } from '../lib/brand-scoring';

// ─── Types ──────────────────────────────────────────────────────

export interface SocialMonitorResult {
  brandId: string;
  platform: string;
  checkType: 'handle_check' | 'impersonation_scan';
  handleChecked: string;
  handleAvailable: boolean | null;
  suspiciousAccountUrl?: string;
  suspiciousAccountName?: string;
  impersonationScore: number;  // 0.0-1.0
  impersonationSignals: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export const SUPPORTED_PLATFORMS = ['twitter', 'linkedin', 'instagram', 'tiktok', 'github', 'youtube'] as const;

export const PLATFORM_URL_TEMPLATES: Record<string, (handle: string) => string> = {
  twitter: (h) => `https://x.com/${h}`,
  instagram: (h) => `https://www.instagram.com/${h}/`,
  linkedin: (h) => `https://www.linkedin.com/company/${h}`,
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  github: (h) => `https://github.com/${h}`,
  youtube: (h) => `https://www.youtube.com/@${h}`,
};

/** Maximum permutations to check per platform per brand to avoid rate limiting */
const MAX_PERMUTATIONS_PER_PLATFORM = 10;

// ─── Single Brand Monitor ───────────────────────────────────────

/**
 * Run social monitoring for a single brand.
 * Accepts brands.id as the brand identifier.
 * Checks official handle status and scans for impersonation via permutations.
 */
export async function runSocialMonitorForBrand(
  env: Env,
  brand: { id: string; brand_name: string; domain: string; official_handles: string },
): Promise<SocialMonitorResult[]> {
  const results: SocialMonitorResult[] = [];

  // Re-discover social links from website (catches new profiles added since last scan)
  if (brand.domain) {
    try {
      const discovered = await discoverSocialProfiles(`https://${brand.domain}`);
      for (const profile of discovered) {
        // Upsert — don't overwrite existing manual classifications
        await env.DB.prepare(`
          INSERT INTO social_profiles
            (id, brand_id, platform, handle, profile_url, classification,
             classified_by, classification_confidence, last_checked, status)
          VALUES (?, ?, ?, ?, ?, 'official', 'auto_discovery', ?, ?, 'active')
          ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
            last_checked = excluded.last_checked,
            profile_url = excluded.profile_url
        `).bind(crypto.randomUUID(), brand.id, profile.platform, profile.handle,
                profile.profileUrl, profile.confidence, new Date().toISOString()).run();
      }
    } catch {
      // Non-fatal — continue with existing handles
    }
  }

  // Parse official handles
  let officialHandles: Record<string, string> = {};
  try {
    officialHandles = brand.official_handles ? JSON.parse(brand.official_handles) : {};
  } catch {
    officialHandles = {};
  }

  // Generate permutations from the brand name
  const permutations = generateHandlePermutations(brand.brand_name);
  const permsToCheck = permutations.slice(0, MAX_PERMUTATIONS_PER_PLATFORM);

  // Extract brand keywords for impersonation signal detection
  const brandKeywords = [
    brand.brand_name.toLowerCase(),
    brand.domain.split('.')[0]!.toLowerCase(),
    brand.brand_name.toLowerCase().replace(/\s+/g, ''),
  ];

  // ─── Batch + dedupe network checks ───────────────────────────────
  // checkSocialHandles internally does 6 platforms in parallel (each
  // with its own 2s timeout, see lib/social-check.ts). Previously this
  // was called 6 × (1 + N permutations) = 66 times per brand because
  // the outer platform loop re-invoked it per platform and threw away
  // 5/6 of each result via .find(). That made worst-case wall-clock
  // 132s/brand, which at the previous BATCH_LIMIT=50 blew past the
  // Workers cron 15-min CPU ceiling — runs were killed mid-execution
  // and stuck at status='partial' (see Bug B writeup).
  //
  // Now we collect the unique handles ONCE, do one network call per
  // handle (which already covers all 6 platforms), then build the
  // results array from the cached lookup. ~16 calls per brand instead
  // of 66 — same exact result shape and scoring as before.
  const officialByPlatform: Record<string, string | null> = {};
  const uniqueHandles = new Set<string>();
  for (const platform of SUPPORTED_PLATFORMS) {
    const oh = officialHandles[platform]?.replace(/^@/, '') ?? null;
    officialByPlatform[platform] = oh;
    if (oh) uniqueHandles.add(oh);
  }
  for (const perm of permsToCheck) {
    uniqueHandles.add(perm.handle);
  }

  const handleResultsByHandle = new Map<string, SocialCheckResult[]>();
  for (const handle of uniqueHandles) {
    const result = await checkSocialHandles(handle);
    handleResultsByHandle.set(handle.toLowerCase(), result);
  }

  for (const platform of SUPPORTED_PLATFORMS) {
    const officialHandle = officialByPlatform[platform];

    // 1. Check official handle status
    if (officialHandle) {
      const platformResult = handleResultsByHandle.get(officialHandle.toLowerCase())
        ?.find((r) => r.platform === platform);

      if (platformResult) {
        results.push({
          brandId: brand.id,
          platform,
          checkType: 'handle_check',
          handleChecked: officialHandle,
          handleAvailable: platformResult.available,
          impersonationScore: 0,
          impersonationSignals: [],
          severity: platformResult.available === true ? 'HIGH' : 'LOW',
        });
      }
    }

    // The handle actually probed for the official account on THIS platform,
    // normalized per the platform's rules (bug #22) — used to skip permutations
    // that collapse to the same account.
    const officialForPlatform = officialHandle
      ? normalizeHandleForPlatform(officialHandle, platform)
      : null;

    // Dedup: distinct permutations can collapse to the SAME probed handle on a
    // given platform (e.g. `jane.doe` and `janedoe` both probe `janedoe` on X).
    const emittedOnPlatform = new Set<string>();

    // 2. Check top permutations for squatting / impersonation
    for (const perm of permsToCheck) {
      const platformResult = handleResultsByHandle.get(perm.handle.toLowerCase())
        ?.find((r) => r.platform === platform);

      if (!platformResult || platformResult.available !== false) {
        // Handle is available or couldn't check — not a threat
        continue;
      }

      // The handle the probe ACTUALLY resolved for this platform (dots kept on
      // Instagram/TikTok/YouTube, stripped on X/GitHub). This is the account
      // identity, the URL, and the string we score against.
      const probedHandle = platformResult.handle;
      if (!probedHandle || probedHandle.length < 2) continue;

      // Skip if this permutation IS the official handle for this platform.
      if (officialForPlatform && probedHandle === officialForPlatform) {
        continue;
      }

      // Collapse duplicate permutations that map to the same probed account.
      if (emittedOnPlatform.has(probedHandle)) continue;

      // Handle exists — score impersonation risk
      const signals: ImpersonationSignals = {
        name_similarity: nameSimilarity(brand.brand_name, probedHandle),
        uses_brand_keywords: brandKeywords.some((kw) => probedHandle.toLowerCase().includes(kw)),
        account_age_suspicious: false,  // Cannot determine from HEAD request
        low_followers: false,           // Cannot determine from HEAD request
        verified: false,               // Assume not verified (conservative)
        handle_is_permutation: true,    // By definition
      };

      const impersonationResult = scoreImpersonation(signals);

      // Only report if score indicates at least MEDIUM risk
      if (impersonationResult.score >= 0.3) {
        emittedOnPlatform.add(probedHandle);
        results.push({
          brandId: brand.id,
          platform,
          checkType: 'impersonation_scan',
          handleChecked: probedHandle,
          handleAvailable: false,
          suspiciousAccountUrl: platformResult.url,
          suspiciousAccountName: probedHandle,
          impersonationScore: impersonationResult.score,
          impersonationSignals: impersonationResult.reasons,
          severity: impersonationResult.severity,
        });
      }
    }
  }

  return results;
}

// ─── Social Discovery Batch (Cron) ──────────────────────────────

/**
 * Discover social profiles for brands that don't have official_handles configured.
 * Processes a small batch per cycle, prioritizing brands with the most threats.
 * Called by the cron orchestrator every 6 hours, before runSocialMonitorBatch.
 */
export async function runSocialDiscoveryBatch(env: Env, limit: number = 10): Promise<{
  brands_processed: number;
  profiles_found: number;
  schedules_created: number;
}> {
  const effectiveLimit = Math.min(Math.max(limit, 1), 50);

  // Query brands with no official_handles, ordered by threat_count DESC
  const brands = await env.DB.prepare(`
    SELECT id, name, canonical_domain, threat_count
    FROM brands
    WHERE (official_handles IS NULL OR official_handles = '{}' OR official_handles = '')
      AND canonical_domain IS NOT NULL
      AND canonical_domain NOT LIKE '%.%.%.%'
      AND (last_social_scan IS NULL OR last_social_scan < datetime('now', '-7 days'))
    ORDER BY threat_count DESC
    LIMIT ?
  `).bind(effectiveLimit).all<{
    id: string;
    name: string;
    canonical_domain: string;
    threat_count: number;
  }>();

  if (brands.results.length === 0) {
    logger.info('social_discovery_batch', { message: 'No brands need social discovery' });
    return { brands_processed: 0, profiles_found: 0, schedules_created: 0 };
  }

  logger.info('social_discovery_batch_start', { brands_count: brands.results.length });

  let brandsProcessed = 0;
  let profilesFound = 0;
  let schedulesCreated = 0;

  for (const brand of brands.results) {
    try {
      const discovered = await discoverSocialProfiles(`https://${brand.canonical_domain}`);

      if (discovered.length > 0) {
        const handles: Record<string, string> = {};

        for (const profile of discovered) {
          // Upsert into social_profiles as official
          await env.DB.prepare(`
            INSERT INTO social_profiles
              (id, brand_id, platform, handle, profile_url, classification,
               classified_by, classification_confidence, last_checked, status)
            VALUES (?, ?, ?, ?, ?, 'official', 'auto_discovery', ?, datetime('now'), 'active')
            ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
              classification = CASE
                WHEN classified_by = 'manual' THEN classification
                ELSE 'official'
              END,
              classified_by = CASE
                WHEN classified_by = 'manual' THEN classified_by
                ELSE 'auto_discovery'
              END,
              classification_confidence = CASE
                WHEN classified_by = 'manual' THEN classification_confidence
                ELSE excluded.classification_confidence
              END,
              profile_url = excluded.profile_url,
              last_checked = datetime('now'),
              updated_at = datetime('now')
          `).bind(
            crypto.randomUUID(), brand.id, profile.platform, profile.handle,
            profile.profileUrl, profile.confidence,
          ).run();

          // Track handle per platform (keep highest confidence)
          if (!handles[profile.platform] || profile.confidence > 0.5) {
            handles[profile.platform] = profile.handle;
          }

          // Create brand_monitor_schedule entry for this platform
          await env.DB.prepare(`
            INSERT INTO brand_monitor_schedule
              (id, brand_id, monitor_type, platform, check_interval_hours, enabled, next_check)
            VALUES (?, ?, 'social', ?, 24, 1, datetime('now'))
            ON CONFLICT (brand_id, monitor_type, platform) DO NOTHING
          `).bind(crypto.randomUUID(), brand.id, profile.platform).run();

          schedulesCreated++;
          profilesFound++;
        }

        // Update brands.official_handles with discovered handles
        await env.DB.prepare(
          "UPDATE brands SET official_handles = ? WHERE id = ?"
        ).bind(JSON.stringify(handles), brand.id).run();
      }

      // Always update last_social_scan so we don't re-scan every cycle
      await env.DB.prepare(
        "UPDATE brands SET last_social_scan = datetime('now') WHERE id = ?"
      ).bind(brand.id).run();

      brandsProcessed++;
    } catch (err) {
      logger.error('social_discovery_brand_error', {
        brand_id: brand.id,
        brand_name: brand.name,
        canonical_domain: brand.canonical_domain,
        error: err instanceof Error ? err.message : String(err),
      });

      // Still mark last_social_scan to avoid retrying a broken domain every cycle
      await env.DB.prepare(
        "UPDATE brands SET last_social_scan = datetime('now') WHERE id = ?"
      ).bind(brand.id).run().catch(() => {});
    }
  }

  logger.info('social_discovery_batch', {
    brands_processed: brandsProcessed,
    profiles_found: profilesFound,
    schedules_created: schedulesCreated,
  });

  return { brands_processed: brandsProcessed, profiles_found: profilesFound, schedules_created: schedulesCreated };
}

// ─── Batch Monitor (Cron) ───────────────────────────────────────

/**
 * Run social monitoring for all brands due for a check.
 * Called by the cron orchestrator every 6 hours.
 * Now queries from brands + brand_monitor_schedule instead of brand_profiles.
 */
export async function runSocialMonitorBatch(env: Env): Promise<{
  brands_processed: number;
  total_results: number;
  total_alerts: number;
}> {
  const now = new Date().toISOString();

  // 1. Query brands that are due for social monitoring via brand_monitor_schedule.
  //
  // BATCH_LIMIT=10 (was 50). Even after the dedupe in runSocialMonitorForBrand,
  // each brand is ~16 sequential checkSocialHandles calls × up to 2s timeout
  // = ~32s wall-clock worst case. 10 brands = ~5min wall clock — comfortable
  // headroom under Workers' 15-min cron CPU ceiling for the social_monitor
  // agent. Larger batches risked the run getting killed mid-execution before
  // any schedule rows were updated.
  const brands = await env.DB.prepare(`
    SELECT DISTINCT b.id, b.name AS brand_name, b.canonical_domain AS domain,
           b.official_handles
    FROM brands b
    INNER JOIN brand_monitor_schedule bms ON bms.brand_id = b.id
    WHERE bms.monitor_type = 'social'
      AND bms.enabled = 1
      AND (bms.next_check IS NULL OR bms.next_check <= ?)
      AND b.official_handles IS NOT NULL
    ORDER BY bms.next_check ASC
    LIMIT 10
  `).bind(now).all<{
    id: string;
    brand_name: string;
    domain: string;
    official_handles: string;
  }>();

  if (brands.results.length === 0) {
    logger.info('social_monitor_batch', { message: 'No brands due for monitoring', checked_at: now });
    return { brands_processed: 0, total_results: 0, total_alerts: 0 };
  }

  logger.info('social_monitor_batch_start', { brands_count: brands.results.length });

  let totalResults = 0;
  let totalAlerts = 0;
  let brandsProcessed = 0;

  for (const brand of brands.results) {
    try {
      // 2. Run monitoring for this brand (brands.id)
      const results = await runSocialMonitorForBrand(env, {
        id: brand.id,
        brand_name: brand.brand_name,
        domain: brand.domain,
        official_handles: brand.official_handles,
      });

      // 3. Store results in social_profiles (upsert)
      for (const result of results) {
        const profileId = crypto.randomUUID();
        const handle = result.handleChecked.replace(/^@/, '');

        if (result.checkType === 'handle_check') {
          await env.DB.prepare(`
            INSERT INTO social_profiles
              (id, brand_id, platform, handle, profile_url, classification, classified_by,
               impersonation_score, impersonation_signals, severity, status, last_checked)
            VALUES (?, ?, ?, ?, ?, 'official', 'system', 0, '[]', 'LOW', 'active', datetime('now'))
            ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
              last_checked = datetime('now'),
              updated_at = datetime('now')
          `).bind(
            profileId, result.brandId, result.platform, handle,
            result.suspiciousAccountUrl ?? null,
          ).run();
        } else {
          const classification = result.impersonationScore >= 0.7 ? 'impersonation' : 'suspicious';
          await env.DB.prepare(`
            INSERT INTO social_profiles
              (id, brand_id, platform, handle, profile_url, display_name,
               classification, classified_by, classification_confidence,
               impersonation_score, impersonation_signals, severity, status, last_checked)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?, 'active', datetime('now'))
            ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
              impersonation_score = excluded.impersonation_score,
              impersonation_signals = excluded.impersonation_signals,
              severity = excluded.severity,
              classification = excluded.classification,
              classification_confidence = excluded.classification_confidence,
              last_checked = datetime('now'),
              updated_at = datetime('now')
          `).bind(
            profileId, result.brandId, result.platform, handle,
            result.suspiciousAccountUrl ?? null,
            result.suspiciousAccountName ?? null,
            classification,
            result.impersonationScore,
            result.impersonationScore,
            JSON.stringify(result.impersonationSignals),
            result.severity,
          ).run();
        }

        // 4. Create alerts for HIGH/CRITICAL severity
        if (result.severity === 'HIGH' || result.severity === 'CRITICAL') {
          try {
            // Find the user who monitors this brand for alert routing
            const monitoredBy = await env.DB.prepare(
              "SELECT added_by FROM monitored_brands WHERE brand_id = ? LIMIT 1"
            ).bind(brand.id).first<{ added_by: string }>();

            if (monitoredBy) {
              const alertId = await createAlert(env.DB, {
                brandId: brand.id,
                userId: monitoredBy.added_by,
                alertType: 'social_impersonation',
                severity: result.severity,
                title: `${result.severity === 'CRITICAL' ? 'Likely' : 'Possible'} impersonation on ${result.platform}: @${result.handleChecked}`,
                summary: `A ${result.platform} account "${result.handleChecked}" was detected that may be impersonating ${brand.brand_name}. Impersonation score: ${(result.impersonationScore * 100).toFixed(0)}%.`,
                details: {
                  platform: result.platform,
                  handle: result.handleChecked,
                  url: result.suspiciousAccountUrl,
                  score: result.impersonationScore,
                  signals: result.impersonationSignals,
                  check_type: result.checkType,
                },
                sourceType: 'social_monitor',
                sourceId: profileId,
              });
              totalAlerts++;

              // Fire webhook: alert.created for org that owns this brand
              const orgBrand = await env.DB.prepare(
                "SELECT ob.org_id, b.name AS brand_name, b.canonical_domain FROM org_brands ob JOIN brands b ON b.id = ob.brand_id WHERE ob.brand_id = ? LIMIT 1",
              ).bind(brand.id).first<{ org_id: number; brand_name: string; canonical_domain: string }>();
              if (orgBrand) {
                emitOrgEvent(env, orgBrand.org_id, 'alert.created', {
                  alert_id: alertId,
                  brand_name: orgBrand.brand_name,
                  brand_domain: orgBrand.canonical_domain,
                  severity: result.severity,
                  title: `${result.severity === 'CRITICAL' ? 'Likely' : 'Possible'} impersonation on ${result.platform}: @${result.handleChecked}`,
                  alert_type: 'social_impersonation',
                  platform: result.platform,
                  handle: result.handleChecked,
                  impersonation_score: result.impersonationScore,
                }).catch(() => {});
              }
            }
          } catch (alertErr) {
            logger.error('social_monitor_alert_error', {
              brand_id: brand.id,
              error: alertErr instanceof Error ? alertErr.message : String(alertErr),
            });
          }
        }

        totalResults++;
      }

      // 4b. AI assessment for profiles that need it
      const profilesToAssess = results.filter(r =>
        r.impersonationScore >= 0.3 || r.checkType === 'handle_check'
      );

      for (const profile of profilesToAssess) {
        try {
          const handle = profile.handleChecked.replace(/^@/, '');

          // Gather cross-reference data
          const threats = await env.DB.prepare(
            "SELECT malicious_url, threat_type FROM threats WHERE target_brand_id = ? AND status = 'active' LIMIT 5"
          ).bind(brand.id).all<{ malicious_url: string; threat_type: string }>();

          const emailGrade = await env.DB.prepare(
            "SELECT grade FROM email_security_posture WHERE domain = ? ORDER BY scanned_at DESC LIMIT 1"
          ).bind(brand.domain).first<{ grade: string }>();

          const campaigns = await env.DB.prepare(
            "SELECT c.name FROM campaigns c JOIN threats t ON t.campaign_id = c.id WHERE t.target_brand_id = ? AND c.status = 'active' LIMIT 3"
          ).bind(brand.id).all<{ name: string }>();

          const lookalikes = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM lookalike_domains WHERE brand_id = ? AND status = 'active'"
          ).bind(brand.id).first<{ n: number }>();

          const otherSuspicious = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM social_profiles WHERE brand_id = ? AND classification IN ('suspicious','impersonation') AND status = 'active'"
          ).bind(brand.id).first<{ n: number }>();

          let brandAliases: string[] = [];
          let brandKeywords: string[] = [];
          try {
            const brandData = await env.DB.prepare(
              "SELECT aliases, brand_keywords FROM brands WHERE id = ?"
            ).bind(brand.id).first<{ aliases: string | null; brand_keywords: string | null }>();
            if (brandData?.aliases) brandAliases = JSON.parse(brandData.aliases);
            if (brandData?.brand_keywords) brandKeywords = JSON.parse(brandData.brand_keywords);
          } catch { /* non-fatal */ }

          let officialHandles: Record<string, string> = {};
          try {
            officialHandles = brand.official_handles ? JSON.parse(brand.official_handles) : {};
          } catch { /* non-fatal */ }

          const agentInput: SocialAiAssessorInput = {
            brandName: brand.brand_name,
            brandDomain: brand.domain,
            brandAliases,
            brandKeywords,
            officialHandles,
            platform: profile.platform,
            handle,
            profileUrl: profile.suspiciousAccountUrl || '',
            displayName: profile.suspiciousAccountName || null,
            bio: null,
            followersCount: null,
            verified: false,
            accountCreated: null,
            existingThreats: threats.results.map(t => `${t.threat_type}: ${t.malicious_url}`).slice(0, 10),
            emailSecurityGrade: emailGrade?.grade || null,
            activeCampaigns: campaigns.results.map(c => c.name).slice(0, 10),
            lookalikeDomainsFound: lookalikes?.n || 0,
            otherImpersonationProfiles: otherSuspicious?.n || 0,
          };

          // Each per-profile assessment is its own social_ai_assessor
          // sync run nested inside this social_monitor scheduled run.
          // budget_ledger attribution lands on social_ai_assessor; the
          // parent scanner keeps its own agent_runs row covering the loop.
          const { data: assessment } = await runSyncAgent<SocialAiAssessorOutput>(env, socialAiAssessorAgent, agentInput);
          if (!assessment) continue;

          const now2 = new Date().toISOString();
          await env.DB.prepare(`
            UPDATE social_profiles SET
              ai_assessment = ?,
              ai_confidence = ?,
              ai_action = ?,
              ai_evidence_draft = ?,
              classification = CASE
                WHEN classified_by = 'manual' THEN classification
                ELSE ?
              END,
              classification_confidence = CASE
                WHEN classified_by = 'manual' THEN classification_confidence
                ELSE ?
              END,
              classification_reason = ?,
              impersonation_signals = ?,
              severity = CASE
                WHEN ? >= 0.9 THEN 'CRITICAL'
                WHEN ? >= 0.7 THEN 'HIGH'
                WHEN ? >= 0.4 THEN 'MEDIUM'
                ELSE 'LOW'
              END,
              ai_assessed_at = ?,
              updated_at = ?
            WHERE brand_id = ? AND platform = ? AND handle = ?
          `).bind(
            assessment.reasoning,
            assessment.confidence,
            assessment.action,
            assessment.evidenceDraft,
            assessment.classification,
            assessment.confidence,
            assessment.reasoning,
            JSON.stringify([...assessment.signals, ...assessment.crossCorrelations]),
            assessment.confidence, assessment.confidence, assessment.confidence,
            now2,
            now2,
            brand.id, profile.platform, handle,
          ).run();
        } catch (aiErr) {
          logger.warn("social_ai_assessment_error", {
            brand_id: brand.id,
            platform: profile.platform,
            handle: profile.handleChecked,
            error: aiErr instanceof Error ? aiErr.message : String(aiErr),
          });
        }
      }

      // 5. Recompute brand exposure score after social scan
      try {
        await computeBrandExposureScore(env, brand.id);
      } catch (scoreErr) {
        logger.warn('social_monitor_score_error', {
          brand_id: brand.id,
          error: scoreErr instanceof Error ? scoreErr.message : String(scoreErr),
        });
      }

      // 6. Update schedule: set last_checked and compute next_check
      await env.DB.prepare(`
        UPDATE brand_monitor_schedule
        SET last_checked = ?,
            next_check = datetime(?, '+' || check_interval_hours || ' hours')
        WHERE brand_id = ? AND monitor_type = 'social' AND enabled = 1
      `).bind(now, now, brand.id).run();

      // Update brand's last_social_scan
      await env.DB.prepare(
        "UPDATE brands SET last_social_scan = ? WHERE id = ?"
      ).bind(now, brand.id).run();

      brandsProcessed++;
    } catch (brandErr) {
      logger.error('social_monitor_brand_error', {
        brand_id: brand.id,
        brand_name: brand.brand_name,
        error: brandErr instanceof Error ? brandErr.message : String(brandErr),
      });
    }
  }

  logger.info('social_monitor_batch_complete', {
    brands_processed: brandsProcessed,
    total_results: totalResults,
    total_alerts: totalAlerts,
  });

  return { brands_processed: brandsProcessed, total_results: totalResults, total_alerts: totalAlerts };
}
