// Averrow — Admin handlers: brand-candidates
// Split from handlers/admin.ts (S3.4a). Behavior-preserving move.

import { z } from "zod";
import { json, corsHeaders } from "../../lib/cors";
import { audit } from "../../lib/audit";
import type { Env, UserRole, UserStatus } from "../../types";
import { runSyncAgent } from "../../lib/agentRunner";
import { adminClassifyAgent, type AdminClassifyOutput } from "../../agents/admin-classify";
import { callAnthropicJSON } from "../../lib/anthropic";
import { estimateCost } from "../../lib/budgetManager";
import { HOT_PATH_HAIKU } from "../../lib/ai-models";
import { enrichThreatsGeo, PRIVATE_IP_SQL_FILTER } from "../../lib/geoip";
import { fuzzyMatchBrand } from "../../lib/brandDetect";
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
import { runBrandMatchBackfill } from "./backfills";


// ─── POST /api/admin/import-tranco ──────────────────────────────

const TRANCO_CSV_URL = "https://tranco-list.eu/top-1m.csv.zip";

/**
 * Coarsen a Tranco rank into the reputation bucket the platform
 * actually consumes. Returning the SAME bucket on both old and new
 * rank values means a per-brand UPDATE can be skipped — D1 write
 * audit (2026-05-20) showed ~76K Tranco rank UPDATEs/day on top-of-list
 * jitter that doesn't move any brand across a bucket boundary.
 *
 * Buckets:
 *   1   — top-1K       (high-trust, household names)
 *   2   — top-10K      (mainstream)
 *   3   — top-100K     (midmarket)
 *   4   — top-1M       (long-tail)
 *   5   — unranked     (null / beyond 1M)
 *
 * The numeric bucket id is internal; comparing values is sufficient.
 */
export function trancoRankBucket(rank: number | null | undefined): number {
  if (rank == null || rank <= 0) return 5;
  if (rank <= 1_000) return 1;
  if (rank <= 10_000) return 2;
  if (rank <= 100_000) return 3;
  if (rank <= 1_000_000) return 4;
  return 5;
}

export async function handleImportTranco(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as {
      limit?: number;
      min_rank?: number;
      max_rank?: number;
      sectors?: Record<string, string>;
    } | null;

    // Hard ceiling 100K per call. Tranco file itself is up to 1M; we cap at
    // 100K to keep the brand catalog focused. Daily orchestrator currently
    // requests 25K (incremental); super_admin can trigger the full 100K
    // out-of-band via /api/admin/import-tranco for the bulk seed.
    const limit = Math.min(body?.limit ?? 100000, 100000);
    const minRank = body?.min_rank ?? 1;
    const maxRank = body?.max_rank ?? limit;

    // Fetch Tranco CSV (rank,domain format)
    const res = await fetch(TRANCO_CSV_URL);
    if (!res.ok) throw new Error(`Tranco fetch failed: HTTP ${res.status}`);

    // Tranco serves a zip — decompress it
    const zipBuffer = await res.arrayBuffer();
    const csvText = await extractCsvFromZip(zipBuffer);
    if (!csvText) throw new Error("Failed to extract CSV from Tranco zip");

    const lines = csvText.split("\n").filter(Boolean);
    const candidates: Array<{ rank: number; domain: string }> = [];

    for (const line of lines) {
      const [rankStr, domain] = line.split(",");
      if (!rankStr || !domain) continue;
      const rank = parseInt(rankStr, 10);
      if (rank < minRank || rank > maxRank) continue;
      const cleanDomain = domain.trim().toLowerCase();
      const baseName = cleanDomain.split(".")[0] ?? "";
      // Skip short names (< 4 chars) and purely numeric domains
      if (baseName.length < 4 || /^\d+$/.test(baseName)) continue;
      candidates.push({ rank, domain: cleanDomain });
      if (candidates.length >= limit) break;
    }

    // Load existing brands (id + canonical_domain + tranco_rank). Lets us
    // (a) skip INSERT for dupes and (b) UPDATE tranco_rank where the import
    // disagrees with the stored value (rank drifts week-over-week).
    const existing = await env.DB.prepare(
      "SELECT id, canonical_domain, tranco_rank FROM brands"
    ).all<{ id: string; canonical_domain: string; tranco_rank: number | null }>();
    const existingMap = new Map(
      existing.results.map(r => [r.canonical_domain.toLowerCase(), r])
    );

    const toImport: Array<{ rank: number; domain: string }> = [];
    const toUpdate: Array<{ rank: number; domain: string }> = [];
    // Bucket-based skip filter (PR-BJ — write-budget Phase 1, change A):
    // we previously wrote whenever the new Tranco rank differed AT ALL
    // from the stored value. Tranco's daily list has heavy intra-rank
    // churn (~76K rank-jitter updates/day in production), but the
    // PLATFORM only consumes rank as a coarse reputation bucket
    // (top-1K = high-trust, top-10K = mainstream, top-100K = midmarket,
    // top-1M = long-tail). Intra-bucket drift is noise. Updating only
    // when the bucket boundary is crossed cuts the write count without
    // changing any downstream consumer behavior — every caller that
    // reads tranco_rank uses it for relative ordering or for the same
    // bucket check.
    for (const c of candidates) {
      const ex = existingMap.get(c.domain);
      if (!ex) toImport.push(c);
      else if (trancoRankBucket(ex.tranco_rank) !== trancoRankBucket(c.rank)) toUpdate.push(c);
    }
    let imported = 0;
    let updated = 0;
    const skipped = candidates.length - toImport.length - toUpdate.length;

    // Batch INSERT — brand row + brand_domains apex row (PR1 table). Both
    // wrapped in ON CONFLICT DO NOTHING semantics so re-runs are idempotent.
    const BATCH_SIZE = 50;
    for (let i = 0; i < toImport.length; i += BATCH_SIZE) {
      const batch = toImport.slice(i, i + BATCH_SIZE);
      const stmts: D1PreparedStatement[] = [];
      for (const c of batch) {
        const brandId = `brand_${c.domain.replace(/[^a-z0-9]+/g, "_")}`;
        const name = extractBrandName(c.domain);
        const sector = body?.sectors?.[c.domain] ?? null;
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, first_seen, threat_count, tranco_rank)
           VALUES (?, ?, ?, ?, 'tranco', datetime('now'), 0, ?)`
        ).bind(brandId, name, c.domain, sector, c.rank));
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO brand_domains (id, brand_id, domain, domain_type, source, verified, first_seen, last_seen)
           VALUES (?, ?, ?, 'apex', 'tranco', 1, datetime('now'), datetime('now'))`
        ).bind(`bd_${brandId}_apex`, brandId, c.domain));
      }
      await env.DB.batch(stmts);
      imported += batch.length;
    }

    // Batch UPDATE — refresh tranco_rank for existing brands that drifted
    // (or never had it populated due to the pre-PR2 INSERT bug).
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const batch = toUpdate.slice(i, i + BATCH_SIZE);
      const stmts = batch.map(c =>
        env.DB.prepare(`UPDATE brands SET tranco_rank = ? WHERE canonical_domain = ?`)
          .bind(c.rank, c.domain)
      );
      await env.DB.batch(stmts);
      updated += batch.length;
    }

    // Clean up false positive brands — short/generic names that aren't real brands
    try {
      const GENERIC_NAMES = ['www','one','bit','dns','app','web','api','cdn','dev','net','goo','pages','forms','mail','blog','shop','host','info','link','news','data','live','play','docs','home','code','test','help','chat','free','plus','labs'];
      // Delete brands with very short names (<=3 chars) that were just imported from Tranco
      await env.DB.prepare(
        `DELETE FROM brands WHERE source = 'tranco' AND LENGTH(name) <= 3 AND threat_count = 0`
      ).run();
      // Delete purely numeric names
      await env.DB.prepare(
        `DELETE FROM brands WHERE source = 'tranco' AND threat_count = 0
         AND name GLOB '[0-9]*' AND name NOT GLOB '*[a-zA-Z]*'`
      ).run();
      // Delete generic names
      for (const generic of GENERIC_NAMES) {
        await env.DB.prepare(
          `DELETE FROM brands WHERE source = 'tranco' AND threat_count = 0 AND LOWER(name) = ?`
        ).bind(generic).run();
      }
    } catch (cleanupErr) {
      console.error('[import-tranco] cleanup error:', cleanupErr);
    }

    // Auto-run brand match backfill (10 rounds) to link existing threats to newly imported brands
    let backfillMatched = 0;
    if (imported > 0) {
      for (let i = 0; i < 10; i++) {
        const bf = await runBrandMatchBackfill(env);
        backfillMatched += bf.matched;
        if (bf.pending === 0 || bf.checked === 0) break;
      }
    }

    return json({
      success: true,
      data: {
        candidates: candidates.length,
        imported,
        updated,
        skipped,
        backfillMatched,
        message: `Imported ${imported} brands from Tranco top ${maxRank} (${updated} rank-updated, ${skipped} already up to date, ${backfillMatched} threats backfill-matched)`,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

/** Extract brand name from domain: "amazon.com" → "Amazon", "bank-of-america.com" → "Bank Of America" */
function extractBrandName(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return base
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Minimal zip extraction — finds the first file and decompresses it */
async function extractCsvFromZip(buffer: ArrayBuffer): Promise<string | null> {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return new TextDecoder().decode(buffer);
  }
  const compressionMethod = bytes[8]! | (bytes[9]! << 8);
  const compressedSize = bytes[18]! | (bytes[19]! << 8) | (bytes[20]! << 16) | (bytes[21]! << 24);
  const fileNameLen = bytes[26]! | (bytes[27]! << 8);
  const extraLen = bytes[28]! | (bytes[29]! << 8);
  const dataOffset = 30 + fileNameLen + extraLen;

  if (compressionMethod === 0) {
    return new TextDecoder().decode(bytes.slice(dataOffset, dataOffset + compressedSize));
  }
  if (compressionMethod === 8) {
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) { result.set(c, offset); offset += c.length; }
    return new TextDecoder().decode(result);
  }
  return null;
}

// ─── GET /api/admin/brand-candidates ──────────────────────────────
// List pending CT-driven brand candidates for operator review. Sorted
// by cert_count DESC so the highest-signal candidates float to top.

export async function handleListBrandCandidates(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "pending";
    const limit = Math.min(200, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const rows = await env.DB.prepare(`
      SELECT id, apex_domain, source, status, cert_count, distinct_issuers,
             first_seen, last_seen, reviewed_at, reviewed_by, promoted_brand_id, notes
      FROM brand_candidates
      WHERE status = ?
      ORDER BY cert_count DESC, last_seen DESC
      LIMIT ? OFFSET ?
    `).bind(status, limit, offset).all();

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM brand_candidates WHERE status = ?`
    ).bind(status).first<{ n: number }>();

    return json({
      success: true,
      data: rows.results,
      total: count?.n ?? 0,
    }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "List candidates failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/brand-candidates/aggregate ───────────────────
// Manual trigger for the CT-driven aggregator (also runs nightly via
// the orchestrator). Useful right after a big CT-feed catch-up.

export async function handleAggregateBrandCandidates(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { aggregateBrandCandidates } = await import('../../lib/brand-candidates');
    const summary = await aggregateBrandCandidates(env);
    return json({
      success: true,
      data: {
        ...summary,
        message: `Aggregator: scanned ${summary.scanned} apexes, proposed ${summary.proposed}, refreshed ${summary.refreshed}, skipped ${summary.skipped_existing_brand} existing brands + ${summary.skipped_already_candidate} existing candidates in ${summary.duration_ms}ms`,
      },
    }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Aggregate failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/brand-candidates/:id/promote ──────────────────
// Operator approves a pending candidate — creates a brand row at
// tier='monitored' + a brand_domains apex entry. Requires admin.

export async function handlePromoteBrandCandidate(
  request: Request,
  env: Env,
  candidateId: string,
  reviewerUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { promoteCandidate } = await import('../../lib/brand-candidates');
    const result = await promoteCandidate(env, candidateId, reviewerUserId);
    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Promote failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/brand-candidates/:id/reject ───────────────────

export async function handleRejectBrandCandidate(
  request: Request,
  env: Env,
  candidateId: string,
  reviewerUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as { notes?: string } | null;
    const { rejectCandidate } = await import('../../lib/brand-candidates');
    await rejectCandidate(env, candidateId, reviewerUserId, body?.notes ?? null);
    return json({ success: true, data: { candidate_id: candidateId } }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Reject failed",
    }, 500, origin);
  }
}
