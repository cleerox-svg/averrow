// CT-driven brand candidate aggregator.
//
// Watches `ct_certificates` (populated by the existing CT scanner —
// crt.sh + certstream) and surfaces apex domains seen ≥3 times across
// ≥2 distinct issuers in the last 30 days as proposed brand candidates.
// Candidates that are already in `brands` or already in the
// `brand_candidates` queue are skipped.
//
// The cert-count + distinct-issuer threshold is a real-ownership
// signal: phish kits typically use one issuer (Let's Encrypt) for one
// cert. Real brand-owned domains accumulate certs across multiple
// issuers (Let's Encrypt + DigiCert + GoDaddy etc.) over time.
//
// Output: rows in `brand_candidates` (PR5 table). An operator review
// step (future PR) flips `pending → promoted` (creates a brand row)
// or `pending → rejected` (stays as negative example).

import type { Env } from '../types';

const MIN_CERT_COUNT = 3;
const MIN_DISTINCT_ISSUERS = 2;
const LOOKBACK_DAYS = 30;
const PER_RUN_LIMIT = 500;

export interface CandidateAggregationSummary {
  scanned:    number;     // distinct apex domains seen in CT lookback
  proposed:   number;     // newly inserted candidates
  refreshed:  number;     // existing pending candidates whose counts updated
  skipped_existing_brand:    number;  // apex already in brands table
  skipped_already_candidate: number;  // apex already in brand_candidates
  duration_ms: number;
}

export async function aggregateBrandCandidates(env: Env): Promise<CandidateAggregationSummary> {
  const start = Date.now();
  const summary: CandidateAggregationSummary = {
    scanned: 0, proposed: 0, refreshed: 0,
    skipped_existing_brand: 0, skipped_already_candidate: 0,
    duration_ms: 0,
  };

  // Aggregate CT activity by apex domain. SQL extracts the apex
  // (rightmost two labels) via SUBSTR — works for foo.example.com
  // → example.com, but not for ccTLDs like example.co.uk. The
  // post-fetch filter in JS does the more careful apex extraction.
  const rows = await env.DB.prepare(`
    SELECT
      domain,
      COUNT(*)              AS cert_count,
      COUNT(DISTINCT issuer) AS distinct_issuers,
      MIN(created_at)       AS first_seen,
      MAX(created_at)       AS last_seen
    FROM ct_certificates
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND domain IS NOT NULL
      AND domain != ''
    GROUP BY domain
    HAVING COUNT(*) >= ? AND COUNT(DISTINCT issuer) >= ?
    ORDER BY COUNT(*) DESC
    LIMIT ?
  `).bind(LOOKBACK_DAYS, MIN_CERT_COUNT, MIN_DISTINCT_ISSUERS, PER_RUN_LIMIT * 4).all<{
    domain: string;
    cert_count: number;
    distinct_issuers: number;
    first_seen: string;
    last_seen: string;
  }>();

  summary.scanned = rows.results.length;
  if (rows.results.length === 0) {
    summary.duration_ms = Date.now() - start;
    return summary;
  }

  // Reduce to apex (handles ccTLDs better than SUBSTR — keeps
  // example.co.uk together rather than splitting on co.uk).
  // Also dedupes subdomains: foo.example.com and bar.example.com
  // both contribute to candidate 'example.com'.
  const apexBuckets = new Map<string, {
    cert_count: number;
    distinct_issuers: number;
    first_seen: string;
    last_seen: string;
  }>();

  for (const row of rows.results) {
    const apex = extractApex(row.domain);
    if (!apex) continue;
    const existing = apexBuckets.get(apex);
    if (existing) {
      existing.cert_count += row.cert_count;
      existing.distinct_issuers = Math.max(existing.distinct_issuers, row.distinct_issuers);
      if (row.first_seen < existing.first_seen) existing.first_seen = row.first_seen;
      if (row.last_seen > existing.last_seen) existing.last_seen = row.last_seen;
    } else {
      apexBuckets.set(apex, {
        cert_count: row.cert_count,
        distinct_issuers: row.distinct_issuers,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
      });
    }
  }

  // Apex needs MIN_DISTINCT_ISSUERS even after dedup
  const apexes = Array.from(apexBuckets.entries())
    .filter(([_, agg]) => agg.distinct_issuers >= MIN_DISTINCT_ISSUERS)
    .slice(0, PER_RUN_LIMIT);

  // Bulk dedup against existing brands + candidates (one query each
  // instead of one-per-apex; keeps D1 read budget sane at 100K brands).
  const apexList = apexes.map(([a]) => a);
  const existingBrands = await fetchExistingApexes(env, apexList);
  const existingCandidates = await fetchExistingCandidates(env, apexList);

  for (const [apex, agg] of apexes) {
    if (existingBrands.has(apex)) {
      summary.skipped_existing_brand++;
      continue;
    }
    const candidateState = existingCandidates.get(apex);
    if (candidateState === 'rejected' || candidateState === 'promoted') {
      // Already decided; don't re-propose.
      summary.skipped_already_candidate++;
      continue;
    }

    if (candidateState === 'pending') {
      // Refresh counts on existing pending candidate so operator review
      // sees current activity.
      await env.DB.prepare(`
        UPDATE brand_candidates SET
          cert_count = ?,
          distinct_issuers = ?,
          last_seen = ?
        WHERE apex_domain = ? AND source = 'ct_log'
      `).bind(agg.cert_count, agg.distinct_issuers, agg.last_seen, apex).run();
      summary.refreshed++;
      continue;
    }

    // New candidate
    const id = `bc_ct_${apex.replace(/[^a-z0-9]+/g, '_')}`;
    await env.DB.prepare(`
      INSERT OR IGNORE INTO brand_candidates
        (id, apex_domain, source, status, cert_count, distinct_issuers, first_seen, last_seen)
      VALUES (?, ?, 'ct_log', 'pending', ?, ?, ?, ?)
    `).bind(id, apex, agg.cert_count, agg.distinct_issuers, agg.first_seen, agg.last_seen).run();
    summary.proposed++;
  }

  summary.duration_ms = Date.now() - start;
  return summary;
}

// ─── Helpers ─────────────────────────────────────────────────────

// Robust apex extraction. Handles common ccTLDs explicitly; falls
// back to "last two labels" otherwise. Not exhaustive (no
// public-suffix-list dependency to keep bundle small) but covers
// the cases where SUBSTR-based SQL gets it wrong.
const COMPOUND_TLDS = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.in', 'co.za', 'co.il',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.ar', 'com.tw',
  'org.uk', 'org.au', 'gov.uk', 'gov.au', 'ac.uk', 'ac.jp',
  'net.au', 'edu.au',
]);

export function extractApex(domain: string): string | null {
  const d = domain.toLowerCase().trim().replace(/^\*\./, '');
  if (!d || d.includes(' ') || d.startsWith('.') || d.endsWith('.')) return null;
  const parts = d.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  // Reject IP-ish inputs
  if (/^\d+$/.test(parts[parts.length - 1] ?? '')) return null;

  // Try compound TLD first (foo.example.co.uk → example.co.uk)
  if (parts.length >= 3) {
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (COMPOUND_TLDS.has(lastTwo)) {
      return `${parts[parts.length - 3]}.${lastTwo}`;
    }
  }
  // Default: last two labels
  return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

async function fetchExistingApexes(env: Env, apexes: string[]): Promise<Set<string>> {
  if (apexes.length === 0) return new Set();
  const out = new Set<string>();
  // Batch in groups of 100 to keep statement size reasonable
  const BATCH = 100;
  for (let i = 0; i < apexes.length; i += BATCH) {
    const batch = apexes.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const res = await env.DB.prepare(
      `SELECT canonical_domain FROM brands WHERE canonical_domain IN (${placeholders})`
    ).bind(...batch).all<{ canonical_domain: string }>();
    for (const r of res.results) out.add(r.canonical_domain.toLowerCase());
  }
  return out;
}

async function fetchExistingCandidates(env: Env, apexes: string[]): Promise<Map<string, string>> {
  if (apexes.length === 0) return new Map();
  const out = new Map<string, string>();
  const BATCH = 100;
  for (let i = 0; i < apexes.length; i += BATCH) {
    const batch = apexes.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const res = await env.DB.prepare(
      `SELECT apex_domain, status FROM brand_candidates
       WHERE apex_domain IN (${placeholders}) AND source = 'ct_log'`
    ).bind(...batch).all<{ apex_domain: string; status: string }>();
    for (const r of res.results) out.set(r.apex_domain.toLowerCase(), r.status);
  }
  return out;
}

// ─── Promote a candidate into the brands table ─────────────────────

export interface PromotionResult {
  candidate_id:   string;
  apex_domain:    string;
  brand_id:       string;
  already_existed: boolean;
}

export async function promoteCandidate(
  env: Env,
  candidateId: string,
  reviewerUserId: string,
): Promise<PromotionResult> {
  const candidate = await env.DB.prepare(
    `SELECT id, apex_domain, status FROM brand_candidates WHERE id = ?`
  ).bind(candidateId).first<{ id: string; apex_domain: string; status: string }>();
  if (!candidate) throw new Error(`candidate ${candidateId} not found`);
  if (candidate.status !== 'pending') {
    throw new Error(`candidate ${candidateId} is ${candidate.status}, cannot promote`);
  }

  const brandId = `brand_${candidate.apex_domain.replace(/[^a-z0-9]+/g, '_')}`;
  const brandName = extractBrandName(candidate.apex_domain);

  // Upsert into brands. Tier 'monitored' since CT-discovered candidates
  // by definition have non-trivial activity.
  const existing = await env.DB.prepare(
    `SELECT id FROM brands WHERE canonical_domain = ?`
  ).bind(candidate.apex_domain).first<{ id: string }>();

  let alreadyExisted = false;
  let finalBrandId = brandId;
  if (existing) {
    finalBrandId = existing.id;
    alreadyExisted = true;
  } else {
    await env.DB.prepare(`
      INSERT INTO brands (id, name, canonical_domain, source, tier, first_seen, threat_count)
      VALUES (?, ?, ?, 'ct_candidate', 'monitored', datetime('now'), 0)
    `).bind(brandId, brandName, candidate.apex_domain).run();

    // Apex row in brand_domains
    await env.DB.prepare(`
      INSERT OR IGNORE INTO brand_domains
        (id, brand_id, domain, domain_type, source, verified, first_seen, last_seen)
      VALUES (?, ?, ?, 'apex', 'ct_candidate', 1, datetime('now'), datetime('now'))
    `).bind(`bd_${brandId}_apex`, brandId, candidate.apex_domain).run();
  }

  // Mark candidate as promoted
  await env.DB.prepare(`
    UPDATE brand_candidates SET
      status = 'promoted',
      reviewed_at = datetime('now'),
      reviewed_by = ?,
      promoted_brand_id = ?
    WHERE id = ?
  `).bind(reviewerUserId, finalBrandId, candidateId).run();

  return {
    candidate_id: candidateId,
    apex_domain: candidate.apex_domain,
    brand_id: finalBrandId,
    already_existed: alreadyExisted,
  };
}

export async function rejectCandidate(
  env: Env,
  candidateId: string,
  reviewerUserId: string,
  notes: string | null,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE brand_candidates SET
      status = 'rejected',
      reviewed_at = datetime('now'),
      reviewed_by = ?,
      notes = ?
    WHERE id = ? AND status = 'pending'
  `).bind(reviewerUserId, notes, candidateId).run();
}

function extractBrandName(domain: string): string {
  const base = domain.split('.')[0] ?? domain;
  return base.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
