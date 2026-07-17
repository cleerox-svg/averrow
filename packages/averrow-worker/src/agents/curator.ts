/**
 * Curator Agent — Platform Hygiene & Data Quality.
 *
 * Triggered weekly by Flight Control (Sunday, low-traffic period).
 * No AI model needed — purely algorithmic (queries + API calls).
 *
 * Tasks:
 *  1. Email security scanning for brands with no grade
 *  2. Safe domain false-positive cleanup
 *  3. Social profile discovery for high-threat brands
 *
 * Outputs: agent_outputs (type: 'hygiene_report')
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { runEmailSecurityScan, saveEmailSecurityScan } from "../email-security";
import { discoverSocialProfiles } from "../lib/social-discovery";

// Known-safe infrastructure domains — threats targeting these are false positives
const SAFE_DOMAINS = [
  'apple.com', 'icloud.com', 'googleapis.com', 'google.com',
  'amazon.com', 'amazonaws.com', 'microsoft.com', 'windows.net',
  'cloudflare.com', 'fastly.net', 'akamai.net', 'akamaitechnologies.com',
];

// Task 1 (email security scan) controls. Prior implementation was an
// unbounded 500-brand serial loop with no per-brand timeout. Per-brand
// cost ceiling is ~20s (4 parallel 5-s DNS lookups + sequential BIMI
// scan with up to three more 5-s ops). With the queue's "easy" brands
// scanned first, the remaining long-tail averaged enough to push the
// whole curator past the 90-min navigator reaper threshold — 0
// successes / 0 records processed across 12 attempts in the 6-h
// window before this fix. New shape: bounded LIMIT, wall-clock
// budget, concurrent waves, per-brand Promise.race.
const TASK1_FETCH_LIMIT = 100;          // brands fetched per curator tick
const TASK1_WALLTIME_MS = 5 * 60_000;   // 5-min cap on Task 1 as a whole
const TASK1_CONCURRENCY = 5;            // brands processed in parallel
const TASK1_PER_BRAND_MS = 25_000;      // hard ceiling per brand

// ─── Agent Module ────────────────────────────────────────────────

export const curatorAgent: AgentModule = {
  name: "curator",
  displayName: "Curator",
  description: "Platform hygiene — email security scanning, safe domain cleanup, social discovery",
  color: "#4ADE80",
  trigger: "event",
  requiresApproval: false,
  stallThresholdMinutes: 1500,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 1_000_000 },
  reads: [
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "social_profiles" },
  ],
  writes: [
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "social_profiles" },
    { kind: "d1_table", name: "threats" },
  ],
  outputs: [],
  status: "active",
  category: "ops",
  pipelinePosition: 10,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const db = env.DB;
    const outputs: AgentOutputEntry[] = [];

    const results = {
      emailScansCompleted: 0,
      falsePositivesRemoved: 0,
      socialProfilesDiscovered: 0,
    };

    // ── TASK 1: Email security scanning ──────────────────────────
    // Find brands with no email_security_grade, scan up to LIMIT
    // per tick. Bounded by TASK1_WALLTIME_MS so a long-tail of
    // slow-DNS brands can't run the whole curator past the
    // 90-min navigator reaper. Concurrent waves of TASK1_CONCURRENCY
    // are race-free because JS is single-threaded between awaits;
    // same pattern as feeds/abuseipdb.ts and agents/sentinel.ts
    // post the diagnostic-driven refactors.
    const unscanned = await db.prepare(`
      SELECT id, canonical_domain, name FROM brands
      WHERE email_security_grade IS NULL
      AND monitoring_tier != 'none'
      ORDER BY threat_count DESC
      LIMIT ?
    `).bind(TASK1_FETCH_LIMIT).all<{ id: number; canonical_domain: string | null; name: string }>();

    const task1Start = Date.now();
    let task1BudgetHit = false;

    const scanOneBrand = async (brand: { id: number; canonical_domain: string | null; name: string }): Promise<void> => {
      try {
        const domain = brand.canonical_domain || brand.name.toLowerCase();
        if (!domain) return;

        // Per-brand wall-clock race. The inner DNS lookups + BIMI
        // HEAD fetches each have their own 5-s AbortSignal.timeout,
        // but those don't compose into a single brand-level ceiling
        // — a brand making all 7 network ops sequentially could run
        // 20+ s legitimately. Race against TASK1_PER_BRAND_MS so any
        // single brand's slow path can't pin the wave.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`brand ${brand.id} email-security scan timed out after ${TASK1_PER_BRAND_MS}ms`)),
            TASK1_PER_BRAND_MS,
          );
        });
        let scanResult;
        try {
          scanResult = await Promise.race([runEmailSecurityScan(domain), timeoutPromise]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        await saveEmailSecurityScan(db, brand.id, scanResult);
        await db.prepare(`
          UPDATE brands
          SET email_security_score = ?, email_security_grade = ?, email_security_scanned_at = datetime('now')
          WHERE id = ?
        `).bind(scanResult.score, scanResult.grade, brand.id).run();

        results.emailScansCompleted++;
      } catch {
        // Silent fail — next run picks up the remainder.
      }
    };

    for (let i = 0; i < unscanned.results.length; i += TASK1_CONCURRENCY) {
      if (Date.now() - task1Start > TASK1_WALLTIME_MS) {
        task1BudgetHit = true;
        break;
      }
      const wave = unscanned.results.slice(i, i + TASK1_CONCURRENCY);
      await Promise.all(wave.map(scanOneBrand));
    }

    // ── TASK 2: Safe domain false-positive cleanup ───────────────
    // Remove threats targeting known-safe infrastructure
    for (const domain of SAFE_DOMAINS) {
      try {
        const removed = await db.prepare(`
          UPDATE threats SET status = 'false_positive'
          WHERE malicious_domain LIKE ?
          AND status = 'active'
          AND threat_score < 30
        `).bind(`%.${domain}`).run();
        results.falsePositivesRemoved += removed.meta?.changes ?? 0;
      } catch {
        // Silent fail
      }
    }

    // ── TASK 3: Social profile discovery (50 brands per run) ─────
    // Find active brands with no recent social profiles
    const brandsNeedingSocial = await db.prepare(`
      SELECT b.id, b.name, b.canonical_domain
      FROM brands b
      LEFT JOIN (
        SELECT brand_id, MAX(last_checked) as last_scan
        FROM social_profiles GROUP BY brand_id
      ) sp ON sp.brand_id = b.id
      WHERE b.threat_count > 10
      AND (sp.last_scan IS NULL OR sp.last_scan < datetime('now', '-30 days'))
      ORDER BY b.threat_count DESC
      LIMIT 50
    `).all<{ id: number; name: string; canonical_domain: string | null }>();

    for (const brand of brandsNeedingSocial.results) {
      try {
        const domain = brand.canonical_domain || brand.name.toLowerCase();
        if (!domain) continue;

        const discovered = await discoverSocialProfiles(`https://${domain}`);
        for (const profile of discovered) {
          await db.prepare(`
            INSERT INTO social_profiles
              (id, brand_id, platform, handle, profile_url, classification,
               classified_by, classification_confidence, last_checked, status)
            VALUES (?, ?, ?, ?, ?, 'official', 'auto_discovery', ?, datetime('now'), 'active')
            ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
              last_checked = datetime('now'),
              profile_url = excluded.profile_url
          `).bind(
            crypto.randomUUID(),
            brand.id,
            profile.platform,
            profile.handle,
            profile.profileUrl,
            profile.confidence,
          ).run();
        }

        if (discovered.length > 0) {
          results.socialProfilesDiscovered++;
        }
      } catch {
        // Silent fail
      }
    }

    // ── Log completion ───────────────────────────────────────────
    const summaryText =
      `Curator weekly hygiene: ` +
      `${results.emailScansCompleted} email scans` +
      (task1BudgetHit ? ` (Task 1 budget hit — remainder deferred)` : '') +
      `, ${results.falsePositivesRemoved} false positives removed, ` +
      `${results.socialProfilesDiscovered} brands with new social profiles`;

    outputs.push({
      type: 'hygiene_report',
      summary: summaryText,
      severity: 'info',
      details: { ...results, task1BudgetHit },
    });

    return {
      itemsProcessed: results.emailScansCompleted + results.socialProfilesDiscovered,
      itemsCreated: results.socialProfilesDiscovered,
      itemsUpdated: results.emailScansCompleted + results.falsePositivesRemoved,
      output: results,
      agentOutputs: outputs,
    };
  },
};
