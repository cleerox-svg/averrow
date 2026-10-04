// Averrow — Admin handlers: backfills
// Split from handlers/admin.ts (S3.4a). Behavior-preserving move.

import { z } from "zod";
import { json, corsHeaders } from "../../lib/cors";
import { audit } from "../../lib/audit";
import type { Env, UserRole, UserStatus } from "../../types";
import { runSyncAgent } from "../../lib/agentRunner";
import { adminClassifyAgent, type AdminClassifyOutput } from "../../agents/admin-classify";
import { enrichThreatsGeo, PRIVATE_IP_SQL_FILTER } from "../../lib/geoip";
import { fuzzyMatchBrandDetailed } from "../../lib/brandDetect";
import { cachedCount } from "../../lib/cached-count";
import { cachedValue } from "../../lib/cached-value";
import { getReadSession, getDbContext } from "../../lib/db";
import { computeFeedSeverity } from "../../lib/feed-severity";
import type { AuthContext } from "../../middleware/auth";
import { classifySaasTechnique } from "../../lib/saas-classifier";
import { BudgetManager, type BudgetStatus } from "../../lib/budgetManager";
import {
  buildGeoCubeForHour,
  buildProviderCubeForHour,
  buildBrandCubeForHour,
  buildStatusCubeForHour,
  buildArcsCubeForHour,
  countGeoCubeForHour,
  countProviderCubeForHour,
  countBrandCubeForHour,
  countStatusCubeForHour,
  countArcsCubeForHour,
} from "../../lib/cube-builder";


// ─── Backfill: Classify all unclassified threats ────────────────

export async function handleBackfillClassifications(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const total = await cachedCount(env, 'count.threats.null_confidence', 60, async () => {
      const totalRow = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM threats WHERE confidence_score IS NULL"
      ).first<{ n: number }>();
      return totalRow?.n ?? 0;
    });

    if (total === 0) {
      return json({ success: true, data: { message: "No unclassified threats", total: 0, classified: 0 } }, 200, origin);
    }

    let classified = 0;
    let failed = 0;
    let batchNum = 0;
    const BATCH_SIZE = 50;

    while (true) {
      batchNum++;
      const batch = await env.DB.prepare(
        `SELECT id, malicious_url, malicious_domain, ip_address, source_feed, ioc_value, threat_type
         FROM threats WHERE confidence_score IS NULL
         ORDER BY created_at DESC LIMIT ?`
      ).bind(BATCH_SIZE).all<{
        id: string; malicious_url: string | null; malicious_domain: string | null;
        ip_address: string | null; source_feed: string; ioc_value: string | null;
        threat_type: string;
      }>();

      if (batch.results.length === 0) break;

      // Hand the entire batch to the admin_classify sync agent — one
      // agent_runs row per batch, N internal AI calls. The agent owns
      // input/output schema validation + rule-based fallback.
      const { data: agentData } = await runSyncAgent<AdminClassifyOutput>(env, adminClassifyAgent, {
        threats: batch.results.map((t) => ({
          id: t.id,
          malicious_url: t.malicious_url,
          malicious_domain: t.malicious_domain,
          ip_address: t.ip_address,
          source_feed: t.source_feed,
          ioc_value: t.ioc_value,
          threat_type: t.threat_type,
        })),
      });

      const classifications = agentData?.classifications ?? [];
      failed += (agentData?.aiAttempted ?? 0) - (agentData?.aiParsed ?? 0);

      for (const c of classifications) {
        try {
          await env.DB.prepare(
            "UPDATE threats SET confidence_score = ?, severity = COALESCE(severity, ?) WHERE id = ?"
          ).bind(c.confidence, c.severity, c.id).run();
          classified++;
        } catch (err) {
          console.error(`[backfill-classify] update failed for ${c.id}:`, err);
        }
      }

      // 1-second delay between batches to avoid API rate limits
      if (batch.results.length === BATCH_SIZE) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return json({
      success: true,
      data: { total, classified, haikuFailures: failed, batches: batchNum },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Backfill: SaaS attack technique classification ────────────
// POST /api/admin/backfill-saas-techniques
// Classifies up to 5000 unclassified threats per call using the
// PushSecurity saas-attacks taxonomy (rule-based, no AI cost).
export async function handleBackfillSaasTechniques(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const totalPending = await cachedCount(env, 'count.threats.null_saas_technique', 60, async () => {
      const totalRow = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM threats WHERE saas_technique_id IS NULL"
      ).first<{ n: number }>();
      return totalRow?.n ?? 0;
    });

    if (totalPending === 0) {
      return json({
        success: true,
        data: { message: "No threats need SaaS technique classification", total: 0, classified: 0 },
      }, 200, origin);
    }

    const batch = await env.DB.prepare(
      `SELECT id, threat_type, malicious_domain, malicious_url, source_feed
         FROM threats
        WHERE saas_technique_id IS NULL
        ORDER BY created_at DESC
        LIMIT 5000`
    ).all<{
      id:                string;
      threat_type:       string | null;
      malicious_domain:  string | null;
      malicious_url:     string | null;
      source_feed:       string | null;
    }>();

    let classified = 0;
    for (const threat of batch.results) {
      const techniqueId = classifySaasTechnique(threat);
      if (!techniqueId) continue;
      try {
        await env.DB.prepare(
          "UPDATE threats SET saas_technique_id = ? WHERE id = ?"
        ).bind(techniqueId, threat.id).run();
        classified++;
      } catch (err) {
        console.error(`[backfill-saas-techniques] update failed for ${threat.id}:`, err);
      }
    }

    return json({
      success: true,
      data: {
        totalPending,
        processed:  batch.results.length,
        classified,
        remaining:  Math.max(0, totalPending - classified),
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Backfill: Geo-enrich all threats with IP but no lat/lng ────

export async function handleBackfillGeo(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // Count total pending before starting. cachedCount @ 60s so
    // an operator mashing "Refresh" on the backfill page doesn't
    // burn 230K rows × clicks.
    const totalPending = await cachedCount(env, 'count.threats.null_country_with_ip', 60, async () => {
      const totalRow = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM threats WHERE ip_address IS NOT NULL AND country_code IS NULL ${PRIVATE_IP_SQL_FILTER}`
      ).first<{ n: number }>();
      return totalRow?.n ?? 0;
    });

    if (totalPending === 0) {
      return json({ success: true, data: { message: "No threats need geo enrichment", total: 0, enriched: 0, remaining: 0 } }, 200, origin);
    }

    // Call the SAME enrichThreatsGeo function the Navigator uses.
    // Each call processes up to 10 threats (5 actual IP lookups due to ipinfo cap).
    // Loop multiple rounds to make meaningful progress per click.
    let totalEnriched = 0;
    let totalSkippedPrivate = 0;
    let totalSkippedNoResult = 0;
    const allErrors: string[] = [];
    const sampleIps: string[] = [];
    const MAX_ROUNDS = 20;  // 20 rounds × 5 IPs = up to 100 IPs per click

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const result = await enrichThreatsGeo(env.DB, env.CACHE, env.IPINFO_TOKEN);

      totalEnriched += result.enriched;
      totalSkippedPrivate += result.skippedPrivate;
      totalSkippedNoResult += result.skippedNoResult;
      allErrors.push(...result.errors);

      // Collect sample IPs from first round for debugging
      if (round === 1 && result.total === 0) {
        break;
      }

      if (result.total === 0) break; // No more threats to process

      // Rate-limit pause between rounds
      if (round < MAX_ROUNDS) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Sync provider counts after backfill (change-guarded shared helper —
    // only writes providers whose counts actually moved).
    try {
      const { syncHostingProviderCounts } = await import("../../lib/provider-counts");
      await syncHostingProviderCounts(env);
    } catch { /* non-critical */ }
    try {
      const { syncBrandActiveThreatCounts } = await import("../../lib/brand-active-counts");
      await syncBrandActiveThreatCounts(env);
    } catch { /* non-critical */ }

    const remaining = Math.max(0, totalPending - totalEnriched - totalSkippedPrivate - totalSkippedNoResult);
    return json({
      success: true,
      data: {
        total: totalPending,
        enriched: totalEnriched,
        remaining,
        skippedPrivate: totalSkippedPrivate,
        skippedNoResult: totalSkippedNoResult,
        errors: allErrors.length > 0 ? allErrors.slice(0, 20) : undefined,
      },
    }, 200, origin);
  } catch (err) {
    console.error(`[backfill-geo] Fatal error:`, err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Backfill: Resolve malicious domains → IP → geo + hosting provider ────
//
// POST /api/admin/backfill-domain-geo
//
// 91K+ threats have a malicious_domain but no ip_address. This endpoint
// resolves up to 250 unique unresolved domains per call via Cloudflare DoH
// (1.1.1.1), geo-enriches the resulting IPs via the existing ipinfo pipeline,
// then bulk-updates every threat sharing each domain.
//
// Core batch logic lives in lib/dns-backfill.ts (shared with Navigator cron).
// The frontend loops this endpoint until remaining === 0.
export async function handleBackfillDomainGeo(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // Count remaining unresolved domains.
    //
    // PR-4: reads from dns_queue (DNS_QUEUE_DB) — the source of
    // truth for cooldown + attempts state after cleanup. PK on
    // malicious_domain means no DISTINCT needed; partial index on
    // attempts < 8 means no domain-format filters needed (reconciler
    // already gates those on insert). Falls back to threats-side
    // count when DNS_QUEUE_DB is unbound (dev), preserving the
    // admin button's contract even on environments that haven't
    // rolled out the queue split.
    const totalPending = await cachedCount(env, 'count.dns_queue.backlog', 60, async () => {
      if (env.DNS_QUEUE_DB) {
        try {
          const row = await env.DNS_QUEUE_DB.prepare(
            `SELECT COUNT(*) AS n FROM dns_queue WHERE enrichment_attempts < 8`
          ).first<{ n: number }>();
          return row?.n ?? 0;
        } catch {
          // Fall through to threats-side query
        }
      }
      const row = await env.DB.prepare(`
        SELECT COUNT(DISTINCT malicious_domain) AS n
        FROM threats
        WHERE ip_address IS NULL
          AND status = 'active'
          AND dns_exhausted_at IS NULL
          AND COALESCE(enrichment_attempts, 0) < 8
          AND malicious_domain IS NOT NULL
          AND malicious_domain != ''
          AND malicious_domain NOT LIKE '*%'
          AND malicious_domain LIKE '%.%'
      `).first<{ n: number }>();
      return row?.n ?? 0;
    });

    if (totalPending === 0) {
      return json({
        success: true,
        data: {
          message: "No domains pending resolution",
          processed: 0,
          resolved: 0,
          enriched: 0,
          remaining: 0,
        },
      }, 200, origin);
    }

    // Admin endpoint uses 250 batch (matches original behaviour).
    // No hard timeout — the admin endpoint runs under the 15-min CPU ceiling.
    const { runDomainGeoBackfillBatch } = await import('../../lib/dns-backfill');
    const result = await runDomainGeoBackfillBatch(env, { batchSize: 250, timeoutMs: 60_000 });

    return json({
      success: true,
      data: {
        processed: result.processed,
        resolved: result.resolved,
        enriched: result.enriched,
        remaining: Math.max(0, totalPending - result.processed),
      },
    }, 200, origin);
  } catch (err) {
    console.error(`[backfill-domain-geo] Fatal error:`, err);
    return json({
      success: false,
      error: err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}

// POST /api/admin/backfill-brand-enrichment
// Populates logo_url, website_url, hq_lat, hq_lng, hq_country
// for brands that haven't been enriched yet.
// Processes 50 brands per call (logo HEAD + DNS + ipinfo = 3 subrequests each max).
export async function handleBackfillBrandEnrichment(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const { enrichBrand } = await import("../../lib/brand-enricher");

    // Count remaining (skip rows that have already failed 5 times)
    const totalRow = await env.DB.prepare(`
      SELECT COUNT(*) as n FROM brands
      WHERE enriched_at IS NULL
        AND COALESCE(enrich_attempts, 0) < 5
        AND canonical_domain IS NOT NULL
        AND canonical_domain != ''
    `).first<{ n: number }>();
    const totalPending = totalRow?.n ?? 0;

    if (totalPending === 0) {
      return json({
        success: true,
        data: {
          message: "All brands enriched",
          processed: 0,
          enriched: 0,
          remaining: 0,
        },
      }, 200, origin);
    }

    // Fetch batch
    const batch = await env.DB.prepare(`
      SELECT id, canonical_domain FROM brands
      WHERE enriched_at IS NULL
        AND COALESCE(enrich_attempts, 0) < 5
        AND canonical_domain IS NOT NULL
        AND canonical_domain != ''
      LIMIT 50
    `).all<{ id: string; canonical_domain: string }>();

    let enriched = 0;

    for (const brand of batch.results) {
      try {
        const result = await enrichBrand(brand.canonical_domain, env.CACHE, env);

        // If every field came back null, treat this as a failed attempt:
        // bump the attempt counter but DO NOT set enriched_at, so the
        // next cron tick will retry until the row succeeds or hits 5.
        const hasAnyData =
          result.logo_url !== null ||
          result.hq_lat !== null ||
          result.hq_lng !== null ||
          result.hq_country !== null ||
          result.hq_ip !== null;

        if (!hasAnyData) {
          await env.DB.prepare(
            `UPDATE brands SET enrich_attempts = COALESCE(enrich_attempts, 0) + 1 WHERE id = ?`,
          ).bind(brand.id).run();
          continue;
        }

        await env.DB.prepare(`
          UPDATE brands SET
            logo_url    = COALESCE(logo_url, ?),
            website_url = COALESCE(website_url, ?),
            hq_lat      = COALESCE(hq_lat, ?),
            hq_lng      = COALESCE(hq_lng, ?),
            hq_country  = COALESCE(hq_country, ?),
            hq_ip       = COALESCE(hq_ip, ?),
            enriched_at = datetime('now')
          WHERE id = ?
        `).bind(
          result.logo_url,
          result.website_url,
          result.hq_lat,
          result.hq_lng,
          result.hq_country,
          result.hq_ip,
          brand.id,
        ).run();

        enriched++;
      } catch (err) {
        console.error(`[backfill-brand-enrichment] failed for ${brand.id}:`, err);
        // Bump attempt counter so we retry next tick instead of marking
        // a permanently-broken row as enriched.
        await env.DB.prepare(
          `UPDATE brands SET enrich_attempts = COALESCE(enrich_attempts, 0) + 1 WHERE id = ?`,
        ).bind(brand.id).run();
      }
    }

    return json({
      success: true,
      data: {
        processed: batch.results.length,
        enriched,
        remaining: Math.max(0, totalPending - batch.results.length),
      },
    }, 200, origin);
  } catch (err) {
    console.error(`[backfill-brand-enrichment] Fatal error:`, err);
    return json({
      success: false,
      error: err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}

// POST /api/admin/backfill-brand-sector
// Classifies brand sectors via Haiku + fetches RDAP registrant data.
// 20 brands per call (Haiku + RDAP + title fetch ≈ 3 subrequests each).
export async function handleBackfillBrandSector(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const { fetchRdap, heuristicClassifySector } = await import("../../lib/brand-enricher");
    const { runSyncAgent } = await import("../../lib/agentRunner");
    const { brandEnricherAgent } = await import("../../agents/brand-enricher");
    type SectorResult = { sector: string; aiSucceeded: boolean };

    if (!env.ANTHROPIC_API_KEY) {
      return json({
        success: false,
        error:   "ANTHROPIC_API_KEY not configured",
      }, 500, origin);
    }

    // Skip tier='tracked' — those are mostly Tranco-imported brands
    // with no customer interest. They get classified on-demand if
    // promoted to monitored later. Only classify the brands that
    // actually surface in operator workflows.
    const tierFilter = `AND b.tier IN ('monitored','customer')`;

    // Count remaining (skip rows that have already failed 5 times)
    const totalRow = await env.DB.prepare(`
      SELECT COUNT(*) as n FROM brands b
      WHERE (b.sector IS NULL OR b.sector_classified_at IS NULL)
        AND COALESCE(b.sector_attempts, 0) < 5
        AND b.canonical_domain IS NOT NULL
        AND b.canonical_domain != ''
        ${tierFilter}
    `).first<{ n: number }>();
    const totalPending = totalRow?.n ?? 0;

    if (totalPending === 0) {
      return json({
        success: true,
        data: {
          message:    "All brands classified",
          processed:  0,
          classified: 0,
          remaining:  0,
        },
      }, 200, origin);
    }

    // Batch lifted from 20 → 100 per call. Loop is parallelized below
    // (Promise.all chunks of 8) so the CPU/network load is spread,
    // not concentrated.
    const batch = await env.DB.prepare(`
      SELECT b.id, b.name, b.canonical_domain FROM brands b
      WHERE (b.sector IS NULL OR b.sector_classified_at IS NULL)
        AND COALESCE(b.sector_attempts, 0) < 5
        AND b.canonical_domain IS NOT NULL
        AND b.canonical_domain != ''
        ${tierFilter}
      LIMIT 100
    `).all<{ id: string; name: string; canonical_domain: string }>();

    let classified = 0;
    let heuristicHits = 0;
    let aiCalls = 0;

    // Process the batch in parallel chunks of 8 — each chunk awaits
    // before the next starts so we don't blow CPU/subrequest budgets.
    const CONCURRENCY = 8;

    async function classifyOne(brand: { id: string; name: string; canonical_domain: string }): Promise<void> {
      try {
        // Heuristic-first: single regex pass covers government, education,
        // finance, healthcare, travel, telecom, gaming, energy, media via
        // TLD + brand-name keyword matches. Returns null on ambiguous
        // brands so we fall through to AI for the long tail.
        const heuristicSector = heuristicClassifySector(brand.canonical_domain, brand.name);

        // RDAP runs in parallel with sector resolution either way.
        const rdapPromise = fetchRdap(brand.canonical_domain);

        let sectorVal: string | null = null;
        if (heuristicSector) {
          heuristicHits++;
          sectorVal = heuristicSector;
        } else {
          aiCalls++;
          const ai = await runSyncAgent<SectorResult>(env, brandEnricherAgent, {
            domain: brand.canonical_domain,
            brandName: brand.name,
          });
          sectorVal = ai.data?.sector ?? null;
        }

        const rdapData = await rdapPromise.catch(() => null);

        const hasAnyData =
          sectorVal !== null ||
          rdapData?.registrar != null ||
          rdapData?.registered_at != null ||
          rdapData?.expires_at != null ||
          rdapData?.registrant_country != null;

        if (!hasAnyData) {
          await env.DB.prepare(
            `UPDATE brands SET sector_attempts = COALESCE(sector_attempts, 0) + 1 WHERE id = ?`,
          ).bind(brand.id).run();
          return;
        }

        await env.DB.prepare(`
          UPDATE brands SET
            sector               = COALESCE(sector, ?),
            registrar            = COALESCE(registrar, ?),
            registered_at        = COALESCE(registered_at, ?),
            expires_at           = COALESCE(expires_at, ?),
            registrant_country   = COALESCE(registrant_country, ?),
            sector_classified_at = datetime('now')
          WHERE id = ?
        `).bind(
          sectorVal,
          rdapData?.registrar          ?? null,
          rdapData?.registered_at      ?? null,
          rdapData?.expires_at         ?? null,
          rdapData?.registrant_country ?? null,
          brand.id,
        ).run();

        classified++;
      } catch (err) {
        console.error(`[backfill-brand-sector] failed for ${brand.id}:`, err);
        await env.DB.prepare(
          `UPDATE brands SET sector_attempts = COALESCE(sector_attempts, 0) + 1 WHERE id = ?`,
        ).bind(brand.id).run();
      }
    }

    for (let i = 0; i < batch.results.length; i += CONCURRENCY) {
      const chunk = batch.results.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(classifyOne));
    }

    return json({
      success: true,
      data: {
        processed:  batch.results.length,
        classified,
        heuristic_hits: heuristicHits,
        ai_calls: aiCalls,
        remaining:  Math.max(0, totalPending - batch.results.length),
      },
    }, 200, origin);
  } catch (err) {
    console.error(`[backfill-brand-sector] Fatal error:`, err);
    return json({
      success: false,
      error:   err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}

// Rows fuzzy-matched per runBrandMatchBackfill call.
export const BRAND_MATCH_BATCH = 500;
// Ceiling on the reported `pending` figure (see the probe below).
export const BRAND_MATCH_PENDING_CAP = 500;

export interface BrandMatchBackfillResult {
  matched: number;
  checked: number;
  /** Unlinked threats left after this batch, exact up to BRAND_MATCH_PENDING_CAP. */
  pending: number;
  /** True when more than BRAND_MATCH_PENDING_CAP remain — `pending` is then a floor. */
  pending_capped: boolean;
}

// Core brand-match backfill logic.
export async function runBrandMatchBackfill(env: Env): Promise<BrandMatchBackfillResult> {
  // Capped pending probe, run FIRST so a no-work call costs one cheap read.
  // The previous full COUNT(*) over ~1M unlinked threats (cachedCount
  // 'count.threats.unattributed_with_ioc', 600s) existed only to gate on zero and
  // report `pending`; counting at most BATCH + CAP + 1 rows answers both:
  // pending-after-this-batch is exact up to CAP, and anything beyond reads
  // as CAP with `pending_capped: true`. Uncached on purpose — a ≤1001-row
  // probe is cheap, and a fresh value keeps the callers' multi-round
  // loops from looping on a stale pre-batch total.
  const probeRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM threats
       WHERE target_brand_id IS NULL AND (malicious_domain IS NOT NULL OR malicious_url IS NOT NULL OR ioc_value IS NOT NULL)
       LIMIT ?
     )`,
  ).bind(BRAND_MATCH_BATCH + BRAND_MATCH_PENDING_CAP + 1).first<{ n: number }>();
  const probed = probeRow?.n ?? 0;
  if (probed === 0) return { matched: 0, checked: 0, pending: 0, pending_capped: false };

  const brandRows = await env.DB.prepare(
    "SELECT id, name, canonical_domain, tier FROM brands",
  ).all<{ id: string; name: string; canonical_domain: string; tier: string | null }>();

  const brands = brandRows.results;
  if (brands.length === 0) return { matched: 0, checked: 0, pending: 0, pending_capped: false };

  const rows = await env.DB.prepare(
    `SELECT id, malicious_domain, malicious_url, ioc_value FROM threats
     WHERE target_brand_id IS NULL AND (malicious_domain IS NOT NULL OR malicious_url IS NOT NULL OR ioc_value IS NOT NULL)
     ORDER BY created_at DESC
     LIMIT ?`,
  ).bind(BRAND_MATCH_BATCH).all<{ id: string; malicious_domain: string | null; malicious_url: string | null; ioc_value: string | null }>();

  let matched = 0;

  for (const row of rows.results) {
    const haystacks = [row.malicious_domain, row.malicious_url, row.ioc_value].filter(
      (v): v is string => v != null && v.length > 0,
    );
    if (haystacks.length === 0) continue;

    const match = fuzzyMatchBrandDetailed(haystacks, brands);
    if (!match) continue;
    const brandId = match.brandId;

    try {
      await env.DB.prepare(
        "UPDATE threats SET target_brand_id = ?, brand_match_method = ? WHERE id = ? AND target_brand_id IS NULL",
      ).bind(brandId, match.method, row.id).run();

      await env.DB.prepare(
        `UPDATE brands SET
           threat_count = threat_count + 1,
           last_threat_seen = datetime('now')
         WHERE id = ?`,
      ).bind(brandId).run();

      matched++;
    } catch (err) {
      console.error(`[backfill-brand-match] update failed for ${row.id}:`, err);
    }
  }

  const remaining = Math.max(0, probed - rows.results.length);
  return {
    matched,
    checked: rows.results.length,
    pending: Math.min(remaining, BRAND_MATCH_PENDING_CAP),
    pending_capped: remaining > BRAND_MATCH_PENDING_CAP,
  };
}

export interface BrandMatchRoundsResult {
  matched: number;
  checked: number;
  pending: number;
  pending_capped: boolean;
  /** Rounds actually executed (≤ maxRounds). */
  rounds_run: number;
}

/**
 * Run up to `maxRounds` brand-match batches, stopping as soon as another
 * round cannot do new work. Every caller loops this way (orchestrator
 * hourly tick, post-Tranco import in both the orchestrator and
 * brand-candidates, the admin endpoint), so the stop rules live here once.
 *
 * Stop rules:
 *   - `checked === 0` / `pending === 0`: nothing left.
 *   - `matched === 0`: each round reads the NEWEST 500 unlinked threats.
 *     A round that linked nothing leaves that set unchanged, so the next
 *     round would re-read and re-fuzz the identical 500 rows against the
 *     identical brand list and match nothing again (~2.7M wasted
 *     reads/day from the hourly tick's second round alone).
 */
export async function runBrandMatchRounds(env: Env, maxRounds: number): Promise<BrandMatchRoundsResult> {
  const out: BrandMatchRoundsResult = { matched: 0, checked: 0, pending: 0, pending_capped: false, rounds_run: 0 };
  for (let i = 0; i < maxRounds; i++) {
    const bf = await runBrandMatchBackfill(env);
    out.rounds_run++;
    out.matched += bf.matched;
    out.checked += bf.checked;
    out.pending = bf.pending;
    out.pending_capped = bf.pending_capped;
    if (bf.pending === 0 || bf.checked === 0 || bf.matched === 0) break;
  }
  return out;
}

// POST /api/admin/backfill-brand-match
export async function handleBackfillBrandMatch(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const body = await request.json().catch(() => null) as { rounds?: number } | null;
    const rounds = Math.min(Math.max(body?.rounds ?? 1, 1), 20);

    const r = await runBrandMatchRounds(env, rounds);

    return json({
      success: true,
      data: { matched: r.matched, checked: r.checked, pending: r.pending, pending_capped: r.pending_capped, rounds },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/admin/backfill-safe-domains
export async function handleBackfillSafeDomains(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const brands = await env.DB.prepare(
      "SELECT id, canonical_domain FROM brands WHERE canonical_domain IS NOT NULL",
    ).all<{ id: string; canonical_domain: string }>();

    let domainsAdded = 0;
    for (const brand of brands.results) {
      const domain = brand.canonical_domain;
      if (!domain) continue;

      // Add exact domain
      const r1 = await env.DB.prepare(
        `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
         VALUES (?, ?, ?, NULL, 'auto_detected')`,
      ).bind(crypto.randomUUID(), brand.id, domain).run();
      if (r1.meta?.changes) domainsAdded++;

      // Add www variant
      const r2 = await env.DB.prepare(
        `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
         VALUES (?, ?, ?, NULL, 'auto_detected')`,
      ).bind(crypto.randomUUID(), brand.id, "www." + domain).run();
      if (r2.meta?.changes) domainsAdded++;

      // Add wildcard
      const r3 = await env.DB.prepare(
        `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
         VALUES (?, ?, ?, NULL, 'auto_detected')`,
      ).bind(crypto.randomUUID(), brand.id, "*." + domain).run();
      if (r3.meta?.changes) domainsAdded++;
    }

    return json({
      success: true,
      data: { brands_processed: brands.results.length, domains_added: domainsAdded },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/admin/brand-firmographics/enrich ──────────────────
// Triggers the free-source firmographic enricher (SEC EDGAR +
// Companies House + Wikidata). Picks up to 200 monitored+customer
// brands per call that don't yet have a firmographic row or whose
// row is older than 90 days.
//
// Also serves as the per-tick handler for the `enricher` cron's
// brand_firmographic job (dispatched via the same enricherJob
// machinery as domain_geo / brand_logo_hq / brand_sector_rdap).

export async function handleBackfillBrandFirmographics(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { enrichFirmographicsBatch } = await import('../../lib/firmographic-enricher');
    const summary = await enrichFirmographicsBatch(env);
    return json({
      success: true,
      data: {
        processed: summary.scanned,
        enriched:  summary.enriched,
        no_match:  summary.no_match,
        errors:    summary.errors,
        duration_ms: summary.duration_ms,
        message: `Firmographic: scanned ${summary.scanned}, enriched ${summary.enriched}, no match ${summary.no_match}, errors ${summary.errors} in ${summary.duration_ms}ms`,
      },
    }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Firmographic enrichment failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/backfill-social-config — RETIRED 2026-05-07 ───
//
// Originally migrated brand_profiles → brands unified model. The
// migration was completed in production prior to the brand_profiles
// deprecation (R9, 2026-05-07). The endpoint stays mounted but now
// returns 410 Gone so any forgotten cron/curl pointing at it gets
// a directional error instead of silently re-running stale logic.

export async function handleBackfillSocialConfig(request: Request, _env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  return json({
    success: false,
    error: "/api/admin/backfill-social-config is retired (brand_profiles deprecation, 2026-05-07). The migration ran during pre-deprecation cleanup; no further action required.",
    code: "ENDPOINT_RETIRED",
  }, 410, origin);
}
