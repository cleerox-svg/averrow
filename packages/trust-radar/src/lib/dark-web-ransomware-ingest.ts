// Dark Web — Ransomware Leak Site (DLS) Ingest
//
// Global-pull → SQL brand-match → insert-matches. One external
// fetch per source per run, matched against the monitored-brand
// catalog in JS, inserts only the brand-matched victims directly
// into dark_web_mentions with source='ransomware_leak'.
//
// Why this path (not feeds/ + insertThreat):
//   - threats.threat_type has a CHECK constraint that does NOT
//     include 'ransomware' (migrations 0001, 0013). Routing
//     ransomware through the standard feed runner would either
//     require a constraint relaxation or a confusing mis-typing.
//   - Ransomware DLS victims are not IOCs — they're observations
//     of an attack that happened. They don't carry an IP/URL to
//     monitor, just a victim brand to alert on. Direct landing in
//     dark_web_mentions is semantically correct.
//
// D1 cost per run:
//   - 1 SELECT of monitored brands (canonical_domain + name) — KV-
//     cacheable in a later iteration; current call is hourly-bound
//     by the orchestrator so we leave it bare.
//   - N INSERT ... ON CONFLICT DO UPDATE where N = brand-matched
//     victim count this run (single digits in steady state).
// External calls: 2 (one per source). Both are public, no auth.
// AI tokens: 0.

import { createAlert } from './alerts';
import { logger } from './logger';
import type { Env } from '../types';

interface RansomwatchPost {
  post_title: string;
  group_name: string;
  discovered: string;
  description?: string;
  website?: string;
  post_url?: string;
}

interface RansomwareLiveVictim {
  victim?: string;
  group?: string;
  group_name?: string;
  discovered?: string;
  published?: string;
  website?: string;
  domain?: string;
  url?: string;
  description?: string;
}

interface NormalizedVictim {
  source_name: 'ransomwatch' | 'ransomware_live';
  group_name: string;
  victim_label: string;          // human title (post or company name)
  victim_domain: string | null;  // extracted hostname when available
  posted_at: string | null;
  post_url: string | null;
  description: string | null;
}

interface BrandRow {
  id: string;
  name: string;
  canonical_domain: string | null;
}

export interface RansomwareIngestResult {
  skipped: boolean;
  reason?: string;
  ransomwatch_fetched: number;
  ransomware_live_fetched: number;
  victims_total: number;
  brand_matches: number;
  inserted: number;
  alerts_created: number;
  durationMs: number;
  errors: string[];
}

const RANSOMWATCH_URL =
  'https://raw.githubusercontent.com/joshhighet/ransomwatch/main/posts.json';
const RANSOMWARE_LIVE_URL = 'https://api.ransomware.live/recentvictims';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_VICTIMS_PER_SOURCE = 500;

function hostnameOf(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase();
    // Strip www. for matching against canonical_domain.
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    // Bare hostname-ish string — try as-is.
    const bare = trimmed.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(bare) ? bare : null;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const init: RequestInit = {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Averrow/1.0 (+https://averrow.com)',
      },
    };
    // Edge cache for 10 min — both sources publish at slow cadence
    // (ransomwatch: ~hourly commits; ransomware.live: ~hourly).
    (init as RequestInit & { cf?: unknown }).cf = {
      cacheTtl: 600,
      cacheEverything: true,
    };
    const res = await fetch(url, init);
    if (!res.ok) {
      logger.warn('dark_web_ransomware_fetch_http', { url, status: res.status });
      return null;
    }
    return await res.json() as T;
  } catch (err) {
    logger.warn('dark_web_ransomware_fetch_error', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function normalizeRansomwatch(posts: RansomwatchPost[]): NormalizedVictim[] {
  return posts.slice(0, MAX_VICTIMS_PER_SOURCE).map((p) => ({
    source_name: 'ransomwatch',
    group_name: p.group_name,
    victim_label: p.post_title.slice(0, 200),
    victim_domain: hostnameOf(p.website),
    posted_at: p.discovered ?? null,
    post_url: p.post_url ?? null,
    description: p.description ?? null,
  }));
}

function normalizeRansomwareLive(victims: RansomwareLiveVictim[]): NormalizedVictim[] {
  return victims.slice(0, MAX_VICTIMS_PER_SOURCE).map((v) => {
    const group = v.group_name ?? v.group ?? 'unknown';
    const label = v.victim ?? v.domain ?? v.website ?? 'unnamed victim';
    const domain = hostnameOf(v.domain ?? v.website ?? v.victim ?? null);
    return {
      source_name: 'ransomware_live',
      group_name: group,
      victim_label: label.slice(0, 200),
      victim_domain: domain,
      posted_at: v.published ?? v.discovered ?? null,
      post_url: v.url ?? null,
      description: v.description ?? null,
    } satisfies NormalizedVictim;
  });
}

interface MatchedVictim extends NormalizedVictim {
  brand_id: string;
  brand_name: string;
}

function matchVictimsToBrands(
  victims: NormalizedVictim[],
  brands: BrandRow[],
): MatchedVictim[] {
  // Build two indexes: by canonical domain (exact) and by lower-
  // cased brand name (substring match in victim_label). Domain
  // wins when both fire.
  const byDomain = new Map<string, BrandRow>();
  const nameIndex: Array<{ lower: string; brand: BrandRow }> = [];
  for (const b of brands) {
    if (b.canonical_domain) {
      byDomain.set(b.canonical_domain.toLowerCase().replace(/^www\./, ''), b);
    }
    if (b.name && b.name.length >= 3) {
      nameIndex.push({ lower: b.name.toLowerCase(), brand: b });
    }
  }

  const matched: MatchedVictim[] = [];
  const seenPerBrand = new Set<string>(); // dedup within one run
  for (const v of victims) {
    let brand: BrandRow | null = null;
    if (v.victim_domain) {
      brand = byDomain.get(v.victim_domain) ?? null;
    }
    if (!brand) {
      const haystack = `${v.victim_label} ${v.description ?? ''}`.toLowerCase();
      for (const { lower, brand: b } of nameIndex) {
        // Word-boundary check: avoid "ge" matching "georgia"
        if (
          haystack === lower ||
          haystack.startsWith(`${lower} `) ||
          haystack.endsWith(` ${lower}`) ||
          haystack.includes(` ${lower} `) ||
          haystack.includes(`${lower}.`) ||
          haystack.includes(`${lower},`)
        ) {
          brand = b;
          break;
        }
      }
    }
    if (!brand) continue;
    const dedupKey = `${brand.id}:${v.source_name}:${v.post_url ?? v.victim_label}`;
    if (seenPerBrand.has(dedupKey)) continue;
    seenPerBrand.add(dedupKey);
    matched.push({ ...v, brand_id: brand.id, brand_name: brand.name });
  }
  return matched;
}

/**
 * Pull ransomwatch + ransomware.live victim feeds, brand-match
 * against the monitored-brand catalog, insert matches directly
 * into dark_web_mentions with source='ransomware_leak'. Creates a
 * CRITICAL alert on each genuinely new insert. Idempotent via the
 * dark_web_mentions unique index (brand_id, source, source_url).
 */
export async function runDarkWebRansomwareIngest(env: Env): Promise<RansomwareIngestResult> {
  const start = Date.now();
  const base: RansomwareIngestResult = {
    skipped: false,
    ransomwatch_fetched: 0,
    ransomware_live_fetched: 0,
    victims_total: 0,
    brand_matches: 0,
    inserted: 0,
    alerts_created: 0,
    durationMs: 0,
    errors: [],
  };

  try {
    // ── 1. Pull both sources in parallel ──
    const [rwRaw, rlRaw] = await Promise.all([
      fetchJson<RansomwatchPost[]>(RANSOMWATCH_URL),
      fetchJson<RansomwareLiveVictim[]>(RANSOMWARE_LIVE_URL),
    ]);

    const rwPosts = Array.isArray(rwRaw) ? rwRaw : [];
    const rlVictims = Array.isArray(rlRaw) ? rlRaw : [];

    const rwNormalized = normalizeRansomwatch(rwPosts);
    const rlNormalized = normalizeRansomwareLive(rlVictims);
    const allVictims = [...rwNormalized, ...rlNormalized];

    if (allVictims.length === 0) {
      logger.info('dark_web_ransomware_empty', {
        ransomwatch: rwPosts.length,
        ransomware_live: rlVictims.length,
      });
      return {
        ...base,
        ransomwatch_fetched: rwPosts.length,
        ransomware_live_fetched: rlVictims.length,
        durationMs: Date.now() - start,
      };
    }

    // ── 2. Load monitored brands (only those actually being watched) ──
    const brands = await env.DB.prepare(`
      SELECT DISTINCT b.id, b.name, b.canonical_domain
      FROM brands b
      INNER JOIN monitored_brands mb ON mb.brand_id = b.id
      WHERE b.canonical_domain IS NOT NULL OR b.name IS NOT NULL
    `).all<BrandRow>();

    // ── 3. Brand-match in JS ──
    const matched = matchVictimsToBrands(allVictims, brands.results);

    // ── 4. Resolve alert recipient (one query, returns rows for all
    //      brand_ids we matched). Falls back gracefully when no
    //      recipient is set for a given brand.
    const matchedBrandIds = Array.from(new Set(matched.map((m) => m.brand_id)));
    const recipientByBrand = new Map<string, { user_id: string | null; org_id: number | null }>();
    if (matchedBrandIds.length > 0) {
      const placeholders = matchedBrandIds.map(() => '?').join(',');
      const [mbRows, obRows] = await Promise.all([
        env.DB.prepare(
          `SELECT brand_id, added_by FROM monitored_brands WHERE brand_id IN (${placeholders})`,
        ).bind(...matchedBrandIds).all<{ brand_id: string; added_by: string }>(),
        env.DB.prepare(
          `SELECT brand_id, org_id FROM org_brands WHERE brand_id IN (${placeholders})`,
        ).bind(...matchedBrandIds).all<{ brand_id: string; org_id: number }>(),
      ]);
      for (const r of mbRows.results) {
        const cur = recipientByBrand.get(r.brand_id) ?? { user_id: null, org_id: null };
        recipientByBrand.set(r.brand_id, { ...cur, user_id: r.added_by });
      }
      for (const r of obRows.results) {
        const cur = recipientByBrand.get(r.brand_id) ?? { user_id: null, org_id: null };
        recipientByBrand.set(r.brand_id, { ...cur, org_id: r.org_id });
      }
    }

    // ── 5. INSERT ... ON CONFLICT DO UPDATE + per-new-insert alert ──
    let inserted = 0;
    let alertsCreated = 0;
    const errors: string[] = [];

    for (const m of matched) {
      const sourceUrl = m.post_url ?? `ransomware://${m.source_name}/${m.group_name}/${m.victim_label}`;
      const mentionId = crypto.randomUUID();
      const matchedTerms = JSON.stringify(
        m.victim_domain ? [m.victim_domain] : [m.brand_name],
      );
      const reason = `Ransomware leak post — group "${m.group_name}" listed ${m.victim_label} on ${m.source_name}`;

      try {
        // INSERT OR IGNORE — meta.changes>0 is the clean
        // "genuinely new" signal. Ransomware leak posts don't
        // get republished, so a stale last_seen on existing rows
        // costs nothing.
        const res = await env.DB.prepare(`
          INSERT OR IGNORE INTO dark_web_mentions (
            id, brand_id, source, source_url, source_channel, source_author,
            posted_at, content_snippet, matched_terms, match_type,
            classification, classified_by, classification_confidence,
            classification_reason, severity, status,
            first_seen, last_seen, last_checked
          ) VALUES (
            ?, ?, 'ransomware_leak', ?, ?, ?,
            ?, ?, ?, ?,
            'confirmed', 'system', 0.95,
            ?, 'CRITICAL', 'active',
            datetime('now'), datetime('now'), datetime('now')
          )
        `).bind(
          mentionId, m.brand_id, sourceUrl, m.group_name, m.source_name,
          m.posted_at, (m.description ?? m.victim_label).slice(0, 500),
          matchedTerms, m.victim_domain ? 'domain' : 'brand_name',
          reason,
        ).run();

        const isNew = (res.meta?.changes ?? 0) > 0;
        if (isNew) inserted++;

        if (isNew) {
          const recipient = recipientByBrand.get(m.brand_id);
          if (recipient?.user_id) {
            try {
              await createAlert(env.DB, {
                brandId: m.brand_id,
                userId: recipient.user_id,
                alertType: 'dark_web_mention',
                severity: 'CRITICAL',
                title: `Ransomware leak: ${m.brand_name} listed by ${m.group_name}`,
                summary: `${m.source_name} reports ${m.brand_name} on the ${m.group_name} leak site.`,
                details: {
                  source: 'ransomware_leak',
                  source_name: m.source_name,
                  group_name: m.group_name,
                  victim_label: m.victim_label,
                  victim_domain: m.victim_domain,
                  post_url: m.post_url,
                  posted_at: m.posted_at,
                },
                sourceType: 'dark_web_monitor',
                sourceId: mentionId,
              });
              alertsCreated++;
            } catch (alertErr) {
              errors.push(
                `alert ${m.brand_id}: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`,
              );
            }
          }
        }
      } catch (err) {
        errors.push(
          `insert ${m.brand_id}/${m.source_name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    logger.info('dark_web_ransomware_ingest_complete', {
      ransomwatch_fetched: rwPosts.length,
      ransomware_live_fetched: rlVictims.length,
      victims_total: allVictims.length,
      brand_matches: matched.length,
      inserted,
      alerts_created: alertsCreated,
      errors_count: errors.length,
    });

    return {
      skipped: false,
      ransomwatch_fetched: rwPosts.length,
      ransomware_live_fetched: rlVictims.length,
      victims_total: allVictims.length,
      brand_matches: matched.length,
      inserted,
      alerts_created: alertsCreated,
      durationMs: Date.now() - start,
      errors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('dark_web_ransomware_ingest_fatal', { error: msg });
    return {
      ...base,
      skipped: true,
      reason: msg,
      durationMs: Date.now() - start,
      errors: [msg],
    };
  }
}
