// Dark Web — Ransomware Leak Site (DLS) Ingest
//
// Global-pull → brand-match → insert-matches. One external fetch per
// run, matched against the monitored-brand catalog in JS, inserts only
// the brand-matched victims directly into dark_web_mentions with
// source='ransomware_leak'.
//
// Source: RansomLook (https://www.ransomlook.io) — the maintained
// successor of ransomwatch. All RansomLook content, API responses
// included, is CC BY 4.0 ("share and adapt for any purpose, even
// commercially, provided that appropriate credit is given" —
// ransomlook.io/about). Every stored row and alert names RansomLook and
// the licence (RANSOMLOOK_ATTRIBUTION below); UI that shows these rows
// must show the credit too.
//
// Replaced (2026-11): ransomwatch `posts.json` (repo archived, newest
// entry 2025-06-16) and `api.ransomware.live/recentvictims` (deprecated
// v1; ransomware.live terms §5.2 prohibit commercial use without written
// approval). Neither is fetched any more.
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
// Scheduling: called at the top of runDarkWebMonitorBatch
// (scanners/dark-web-monitor.ts), dispatched by the dedicated dark_web
// cron `14 */6 * * *` through executeAgent('dark_web_monitor'). An
// upstream failure (HTTP error, timeout, non-JSON, or a non-empty body
// that parses to zero posts) is returned as `upstream_error` and the
// agent finishes the run 'partial' (AgentResult.degraded) instead of a
// silent 'success' with zero rows.
//
// D1 cost per run:
//   - 1 SELECT of monitored brands (canonical_domain + name).
//   - N INSERT ... SELECT ... WHERE NOT EXISTS where N = brand-matched
//     victim count this run (single digits in steady state).
// External calls: 1. Public, no auth. AI tokens: 0.

import { createAlert } from './alerts';
import { logger } from './logger';
import type { Env } from '../types';

// ─── RansomLook source definition ─────────────────────────────────
// The ONE place the endpoint and field mapping live. Shape verified
// live from this codebase's sandbox on 2026-11-14 against
// https://www.ransomlook.io/api/recent/300 (swagger 2.1.0 at
// /swagger.json, operationId get_recent_post): a JSON array of
//   { post_title: string, group_name: string, discovered: string
//     ("YYYY-MM-DD HH:MM:SS[.ffffff]", UTC, no zone), description:
//     string|null, link: string|null (relative path on the group's site,
//     an .onion URL, a fragment, or occasionally the victim's own
//     website), magnet: string|null, screen: string|null, private:
//     boolean, misp_uuid: string (UUIDv5 — deterministic per post) }.
// There is NO dedicated victim-website field: the victim domain comes
// from post_title when the title is a domain/URL (~10% of posts), else
// from a clearnet (non-.onion) absolute `link`.
// `/api/recent/<n>` returns the n most recent posts across all groups;
// 300 ≈ 4-5 days at current volume, so the 6-hourly run overlaps
// itself many times over and survives several missed runs.

export const RANSOMLOOK_SOURCE_NAME = 'ransomlook';
export const RANSOMLOOK_RECENT_URL = 'https://www.ransomlook.io/api/recent/300';
export const RANSOMLOOK_LICENSE = 'CC-BY-4.0';
export const RANSOMLOOK_ATTRIBUTION =
  'Source: RansomLook (https://www.ransomlook.io), licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)';

/** Public RansomLook group page; the fragment makes the URL unique per post. */
function ransomLookPostUrl(group: string, postKey: string): string {
  return `https://www.ransomlook.io/group/${encodeURIComponent(group)}#${encodeURIComponent(postKey)}`;
}

/** Hosts a `link` may point at that are never a victim's own website. */
const NON_VICTIM_LINK_HOSTS = new Set([
  'ransomlook.io', 't.me', 'telegram.me', 'telegram.org', 'x.com', 'twitter.com',
  'mega.nz', 'mega.io', 'gofile.io', 'mediafire.com', 'anonfiles.com', 'pixeldrain.com',
  'github.com', 'pastebin.com', 'tox.chat', 'bit.ly',
]);

export interface NormalizedVictim {
  source_name: typeof RANSOMLOOK_SOURCE_NAME;
  group_name: string;
  victim_label: string;          // human title (post title)
  victim_domain: string | null;  // extracted hostname when available
  posted_at: string | null;
  /** Stable per-post URL on ransomlook.io — the dedup key (source_url). */
  post_url: string;
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
  ransomlook_fetched: number;
  /** Items in the response that could not be parsed into a post. */
  ransomlook_invalid: number;
  victims_total: number;
  brand_matches: number;
  inserted: number;
  alerts_created: number;
  durationMs: number;
  errors: string[];
  /** Set when the upstream pull failed — the run is degraded, not quiet. */
  upstream_error: string | null;
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_VICTIMS_PER_SOURCE = 500;
/** One-time overlap guard window for rows ingested from the retired sources. */
const LEGACY_OVERLAP_DAYS = 30;

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Hostname from a URL or bare domain; null unless it is a dotted DNS name. */
export function hostnameOf(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let host: string;
  if (/^https?:\/\//.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return null;
    }
  } else {
    host = trimmed.split(/[/?#]/, 1)[0] ?? '';
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  return DOMAIN_RE.test(host) ? host : null;
}

/** Victim domain from a RansomLook `link` — absolute clearnet URLs only. */
function victimDomainFromLink(link: string | null): string | null {
  if (!link || !/^https?:\/\//i.test(link.trim())) return null;
  const host = hostnameOf(link);
  if (!host || host.endsWith('.onion')) return null;
  for (const h of NON_VICTIM_LINK_HOSTS) {
    if (host === h || host.endsWith(`.${h}`)) return null;
  }
  return host;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export interface RansomLookParseResult {
  victims: NormalizedVictim[];
  /** Array items that were not usable posts (missing title/group, wrong type). */
  invalid: number;
  /** Total array items seen (before the per-run cap). */
  total: number;
  /** Set when the body is not an array at all. */
  error: string | null;
}

/**
 * Parse a RansomLook `/api/recent` body defensively. Unknown fields are
 * ignored, missing optional fields tolerated; an item without a
 * post_title or group_name is counted invalid. Posts flagged
 * `private: true` are skipped (RansomLook withholds them publicly) and
 * are not counted invalid.
 */
export function parseRansomLookPosts(body: unknown): RansomLookParseResult {
  if (!Array.isArray(body)) {
    return { victims: [], invalid: 0, total: 0, error: 'response is not a JSON array' };
  }
  const victims: NormalizedVictim[] = [];
  let invalid = 0;
  for (const item of body.slice(0, MAX_VICTIMS_PER_SOURCE)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { invalid++; continue; }
    const rec = item as Record<string, unknown>;
    const title = str(rec.post_title);
    const group = str(rec.group_name);
    if (!title || !group) { invalid++; continue; }
    if (rec.private === true) continue;
    const link = str(rec.link);
    const mispUuid = str(rec.misp_uuid);
    victims.push({
      source_name: RANSOMLOOK_SOURCE_NAME,
      group_name: group.slice(0, 120),
      victim_label: title.slice(0, 200),
      victim_domain: hostnameOf(title) ?? victimDomainFromLink(link),
      posted_at: str(rec.discovered),
      post_url: ransomLookPostUrl(group, mispUuid ?? title),
      description: str(rec.description),
    });
  }
  return { victims, invalid, total: body.length, error: null };
}

type FetchOutcome = { ok: true; body: unknown } | { ok: false; error: string };

async function fetchRansomLook(url: string): Promise<FetchOutcome> {
  try {
    const init: RequestInit = {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Averrow/1.0 (+https://averrow.com)',
      },
    };
    // Edge cache for 10 min — RansomLook scrapes leak sites roughly hourly.
    (init as RequestInit & { cf?: unknown }).cf = {
      cacheTtl: 600,
      cacheEverything: true,
    };
    const res = await fetch(url, init);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, error: `non-JSON response (${text.length} bytes)` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Group-name key that survives spacing/hyphen differences between trackers
 * ("inc ransom" vs "incransom"). Must match the SQL expression in the
 * legacy-overlap guard below: lower() with ' ', '-', '_' removed.
 */
export function groupKey(group: string): string {
  return group.toLowerCase().replace(/[ _-]/g, '');
}

interface MatchedVictim extends NormalizedVictim {
  brand_id: string;
  brand_name: string;
}

export function matchVictimsToBrands(
  victims: NormalizedVictim[],
  brands: BrandRow[],
): MatchedVictim[] {
  // Domain-exact only. The initial release also tried a brand-name
  // substring fallback in (victim_label + description); under live
  // data that fired on common English-word brand names ("Office",
  // "One", "Line", "Current", "Tesla") against unrelated victim
  // descriptions and on a junk catalog row "Www" (canonical_domain
  // www.gov.uk) that matched any URL containing "www.". First post-
  // merge cron produced ~94% false-positive CRITICAL alerts. Audit
  // confirmed only domain-exact matches survived.
  //
  // RansomLook posts carry no victim-website field; the domain comes
  // from a domain-shaped post_title or a clearnet `link` (see
  // parseRansomLookPosts), so recall is lower than with the retired
  // ransomware.live feed. Domain-exact stays the right precision/recall
  // tradeoff for unattended CRITICAL alerting. A stricter name
  // matcher (require token boundaries + name length >= 5 + stoplist +
  // demote severity from CRITICAL to MEDIUM) can be added later if
  // needed.
  const byDomain = new Map<string, BrandRow>();
  for (const b of brands) {
    if (b.canonical_domain) {
      byDomain.set(b.canonical_domain.toLowerCase().replace(/^www\./, ''), b);
    }
  }

  const matched: MatchedVictim[] = [];
  const seenPerBrand = new Set<string>();
  for (const v of victims) {
    if (!v.victim_domain) continue;
    const brand = byDomain.get(v.victim_domain) ?? null;
    if (!brand) continue;
    const dedupKey = `${brand.id}:${v.post_url}`;
    if (seenPerBrand.has(dedupKey)) continue;
    seenPerBrand.add(dedupKey);
    matched.push({ ...v, brand_id: brand.id, brand_name: brand.name });
  }
  return matched;
}

/**
 * Pull RansomLook's recent leak-site posts, brand-match against the
 * monitored-brand catalog, insert matches directly into
 * dark_web_mentions with source='ransomware_leak'. Creates a CRITICAL
 * alert on each genuinely new insert. Idempotent via the
 * dark_web_mentions unique index (brand_id, source, source_url).
 */
export async function runDarkWebRansomwareIngest(env: Env): Promise<RansomwareIngestResult> {
  const start = Date.now();
  const base: RansomwareIngestResult = {
    skipped: false,
    ransomlook_fetched: 0,
    ransomlook_invalid: 0,
    victims_total: 0,
    brand_matches: 0,
    inserted: 0,
    alerts_created: 0,
    durationMs: 0,
    errors: [],
    upstream_error: null,
  };

  try {
    // ── 1. Pull RansomLook ──
    const fetched = await fetchRansomLook(RANSOMLOOK_RECENT_URL);
    if (!fetched.ok) {
      const upstreamError = `ransomlook fetch failed: ${fetched.error}`;
      logger.warn('dark_web_ransomware_fetch_failed', { url: RANSOMLOOK_RECENT_URL, error: fetched.error });
      return { ...base, upstream_error: upstreamError, errors: [upstreamError], durationMs: Date.now() - start };
    }

    const parsed = parseRansomLookPosts(fetched.body);
    if (parsed.error || (parsed.total > 0 && parsed.victims.length === 0 && parsed.invalid > 0)) {
      // A non-empty body that yields zero posts means the upstream shape
      // changed — a failed pull, never a quiet "nothing new".
      const upstreamError = parsed.error
        ? `ransomlook response unusable: ${parsed.error}`
        : `ransomlook response unusable: 0 of ${parsed.total} items parsed`;
      logger.warn('dark_web_ransomware_parse_failed', { error: upstreamError, total: parsed.total, invalid: parsed.invalid });
      return {
        ...base,
        ransomlook_fetched: parsed.total,
        ransomlook_invalid: parsed.invalid,
        upstream_error: upstreamError,
        errors: [upstreamError],
        durationMs: Date.now() - start,
      };
    }

    const allVictims = parsed.victims;
    if (allVictims.length === 0) {
      logger.info('dark_web_ransomware_empty', { ransomlook: parsed.total });
      return {
        ...base,
        ransomlook_fetched: parsed.total,
        ransomlook_invalid: parsed.invalid,
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

    // ── 5. INSERT (guarded) + per-new-insert alert ──
    let inserted = 0;
    let alertsCreated = 0;
    const errors: string[] = [];

    for (const m of matched) {
      const sourceUrl = m.post_url;
      const mentionId = crypto.randomUUID();
      const matchedTerms = JSON.stringify(
        m.victim_domain ? [m.victim_domain] : [m.brand_name],
      );
      const reason =
        `Ransomware leak post — group "${m.group_name}" listed ${m.victim_label} ` +
        `(via RansomLook, ransomlook.io, CC BY 4.0)`;

      try {
        // INSERT OR IGNORE on the (brand_id, source, source_url) unique
        // index — meta.changes>0 is the clean "genuinely new" signal.
        // The NOT EXISTS clause is a one-time transition guard: a victim
        // already stored from the retired ransomwatch / ransomware.live
        // feeds (different source_url) for the same brand + group in the
        // last LEGACY_OVERLAP_DAYS days is not re-inserted or re-alerted.
        // It expires on its own once those rows age out of the window.
        const res = await env.DB.prepare(`
          INSERT OR IGNORE INTO dark_web_mentions (
            id, brand_id, source, source_url, source_channel, source_author,
            posted_at, content_snippet, matched_terms, match_type,
            classification, classified_by, classification_confidence,
            classification_reason, severity, status,
            first_seen, last_seen, last_checked
          )
          SELECT
            ?, ?, 'ransomware_leak', ?, ?, ?,
            ?, ?, ?, ?,
            'confirmed', 'system', 0.95,
            ?, 'CRITICAL', 'active',
            datetime('now'), datetime('now'), datetime('now')
          WHERE NOT EXISTS (
            SELECT 1 FROM dark_web_mentions
            WHERE brand_id = ?
              AND source = 'ransomware_leak'
              AND source_author IN ('ransomwatch', 'ransomware_live')
              AND lower(replace(replace(replace(source_channel, ' ', ''), '-', ''), '_', '')) = ?
              AND first_seen >= datetime('now', ?)
          )
        `).bind(
          mentionId, m.brand_id, sourceUrl, m.group_name, m.source_name,
          m.posted_at, (m.description ?? m.victim_label).slice(0, 500),
          matchedTerms, m.victim_domain ? 'domain' : 'brand_name',
          reason,
          m.brand_id, groupKey(m.group_name), `-${LEGACY_OVERLAP_DAYS} days`,
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
                summary: `RansomLook reports ${m.brand_name} on the ${m.group_name} leak site.`,
                details: {
                  source: 'ransomware_leak',
                  source_name: m.source_name,
                  group_name: m.group_name,
                  victim_label: m.victim_label,
                  victim_domain: m.victim_domain,
                  post_url: m.post_url,
                  posted_at: m.posted_at,
                  attribution: RANSOMLOOK_ATTRIBUTION,
                  license: RANSOMLOOK_LICENSE,
                },
                sourceType: 'dark_web_monitor',
                sourceId: mentionId,
              }, { env });
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
      ransomlook_fetched: parsed.total,
      ransomlook_invalid: parsed.invalid,
      victims_total: allVictims.length,
      brand_matches: matched.length,
      inserted,
      alerts_created: alertsCreated,
      errors_count: errors.length,
    });

    return {
      skipped: false,
      ransomlook_fetched: parsed.total,
      ransomlook_invalid: parsed.invalid,
      victims_total: allVictims.length,
      brand_matches: matched.length,
      inserted,
      alerts_created: alertsCreated,
      durationMs: Date.now() - start,
      errors,
      upstream_error: null,
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
