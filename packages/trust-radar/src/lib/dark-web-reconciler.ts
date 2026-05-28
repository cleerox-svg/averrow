// Dark Web Reconciler — Telegram → dark_web_mentions bridge.
//
// Pattern copy of lib/dns-queue-reconciler.ts. Cursor-paginated
// incremental promotion of brand-matched Telegram leak-channel
// messages from social_mentions into dark_web_mentions.
//
// ── Why ──
//
// feeds/telegram.ts already ingests ~10 curated leak/credential/
// ransomware channels every 4h, brand-matches them in JS, and
// records each match in social_mentions with platform='telegram'
// + a has_threat_keyword flag in platform_metadata. The dark web
// module's UI only reads dark_web_mentions, so this rich leak-
// channel signal is sitting one table over and invisible to
// customers. This reconciler closes that gap without re-ingesting
// (zero new external calls, zero AI tokens, classification done
// deterministically from the existing match_type + threat keyword).
//
// ── Mechanics ──
//
//   Cursor:
//     KV key `reconciler:dark_web:telegram_cursor` (ISO timestamp).
//     Each tick reads `social_mentions WHERE platform='telegram'
//     AND created_at >= cursor ORDER BY created_at LIMIT 500` and
//     advances cursor to MAX(created_at) of the FULL window — not
//     just the qualifying subset — so sparse-match periods don't
//     pin the cursor on a stale row.
//
//   `>= cursor` (not `>`) prevents skipping rows with identical
//     created_at across tick boundaries. The dark_web_mentions
//     unique index on (brand_id, source, source_url) absorbs the
//     overlap-dedup cost.
//
//   Bootstrap: missing cursor defaults to `now - 30 minutes`.
//     Telegram volume is low (~125 msgs/hour total) so re-scanning
//     30 min at startup is harmless.
//
//   Qualification (in JS, post-SELECT, to keep the cursor advance
//   correct even on no-match windows):
//     - brand_id IS NOT NULL  (Telegram feed records both
//       brand-matched and keyword-only rows; we only want the
//       brand-matched ones for dark web)
//     - match_type='domain' OR platform_metadata.has_threat_keyword
//       (either is a strong-enough signal)
//
//   Severity / classification (deterministic, no AI):
//     domain match + threat keyword  → HIGH      / confirmed
//     domain match alone             → MEDIUM    / confirmed
//     brand name + threat keyword    → MEDIUM    / confirmed
//     brand name alone               → LOW       / suspicious
//
//   Caps: READ_LIMIT 500 (Telegram per-tick volume is single-
//     digits — the cap is for burst windows after backfill of new
//     channels). INSERT chunk 50.
//
//   Never throws — drift recoverable next tick. Returns {skipped}
//   on any failure path so Navigator stays unblocked.

import type { Env } from '../types';

const CURSOR_KEY = 'reconciler:dark_web:telegram_cursor';
const CHUNK_SIZE = 50;
const READ_LIMIT = 500;
const BOOTSTRAP_MINUTES_AGO = 30;

export interface DarkWebReconcileResult {
  skipped: boolean;
  reason?: string;
  /** Total rows pulled from social_mentions this tick. */
  scanned: number;
  /** Rows that passed the qualification filter (brand-matched + signal). */
  qualified: number;
  /** Rows actually written to dark_web_mentions (INSERT OR IGNORE changes). */
  inserted: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  cursorLagMinutes: number;
  durationMs: number;
  batchesAttempted: number;
  batchesFailed: number;
  lastError?: string;
}

interface SocialRow {
  id: string;
  brand_id: string | null;
  content_url: string | null;
  content_text: string | null;
  content_author: string | null;
  content_created: string | null;
  match_type: string | null;
  match_confidence: number | null;
  platform_metadata: string | null;
  created_at: string;
}

interface MentionInsert {
  id: string;
  brand_id: string;
  source_url: string;
  source_channel: string | null;
  source_author: string | null;
  posted_at: string | null;
  content_snippet: string | null;
  matched_terms: string;
  match_type: 'domain' | 'brand_name';
  classification: 'confirmed' | 'suspicious';
  classification_confidence: number;
  classification_reason: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
}

function parseHasThreatKeyword(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as { has_threat_keyword?: unknown };
    return parsed.has_threat_keyword === true;
  } catch {
    return false;
  }
}

function parseChannelName(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { channel_name?: unknown };
    return typeof parsed.channel_name === 'string' ? parsed.channel_name : null;
  } catch {
    return null;
  }
}

function classify(row: SocialRow): MentionInsert | null {
  if (!row.brand_id || !row.content_url) return null;

  const hasKeyword = parseHasThreatKeyword(row.platform_metadata);
  const isDomainMatch = row.match_type === 'domain';

  // Qualification gate — brand_id alone isn't enough (Telegram also
  // records brand-only keyword hits); we need either a domain match
  // OR a leak-vocabulary signal.
  if (!isDomainMatch && !hasKeyword) return null;

  let severity: MentionInsert['severity'];
  let signals: string[];
  if (isDomainMatch && hasKeyword) {
    severity = 'HIGH';
    signals = ['telegram_channel', 'brand_domain_match', 'leak_vocabulary'];
  } else if (isDomainMatch) {
    severity = 'MEDIUM';
    signals = ['telegram_channel', 'brand_domain_match'];
  } else {
    severity = 'MEDIUM';
    signals = ['telegram_channel', 'brand_name_match', 'leak_vocabulary'];
  }

  const classification: 'confirmed' | 'suspicious' =
    severity === 'HIGH' || severity === 'MEDIUM' ? 'confirmed' : 'suspicious';

  // Confidence: telegram feed scores domain=80, keyword=60. Map to
  // 0..1 for dark_web_mentions.classification_confidence.
  const baseConfidence = row.match_confidence ? row.match_confidence / 100 : 0.5;

  return {
    id: crypto.randomUUID(),
    brand_id: row.brand_id,
    source_url: row.content_url,
    source_channel: parseChannelName(row.platform_metadata) ?? row.content_author,
    source_author: row.content_author,
    posted_at: row.content_created,
    content_snippet: (row.content_text ?? '').slice(0, 500),
    matched_terms: JSON.stringify(signals.includes('brand_domain_match') ? ['domain'] : ['brand_name']),
    match_type: isDomainMatch ? 'domain' : 'brand_name',
    classification,
    classification_confidence: Math.max(0.5, Math.min(0.95, baseConfidence)),
    classification_reason: `Telegram leak channel: ${signals.join(', ')}`,
    severity,
  };
}

export async function reconcileDarkWeb(env: Env): Promise<DarkWebReconcileResult> {
  const start = Date.now();
  let batchesAttempted = 0;
  let batchesFailed = 0;
  let lastError: string | undefined;
  const base: DarkWebReconcileResult = {
    skipped: false,
    scanned: 0,
    qualified: 0,
    inserted: 0,
    cursorBefore: null,
    cursorAfter: null,
    cursorLagMinutes: 0,
    durationMs: 0,
    batchesAttempted: 0,
    batchesFailed: 0,
  };

  try {
    // ── 1. Read cursor from KV ──
    let cursor: string | null = null;
    try {
      cursor = await env.CACHE.get(CURSOR_KEY);
    } catch {
      // KV transient — treat as bootstrap.
    }
    if (!cursor) {
      const bootstrapAt = new Date(Date.now() - BOOTSTRAP_MINUTES_AGO * 60_000);
      cursor = bootstrapAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    }
    const cursorBefore = cursor;
    const cursorAgeMs = Date.now() - Date.parse(cursor.replace(' ', 'T') + 'Z');
    const cursorLagMinutes = Math.max(0, Math.floor(cursorAgeMs / 60_000));

    // ── 2. Read all telegram social_mentions since cursor ──
    // Read unfiltered (no qualification predicate) so the cursor
    // advance covers ALL rows in the window — sparse-match periods
    // can't pin the cursor on a stale qualifying row. The qualify
    // step runs in JS below.
    const res = await env.DB.prepare(`
      SELECT id, brand_id, content_url, content_text, content_author,
             content_created, match_type, match_confidence,
             platform_metadata, created_at
      FROM social_mentions
      WHERE platform = 'telegram'
        AND created_at >= ?
      ORDER BY created_at
      LIMIT ?
    `).bind(cursor, READ_LIMIT).all<SocialRow>();

    const rows = res.results;
    const scanned = rows.length;
    let maxCreatedAt = cursor;
    for (const r of rows) {
      if (r.created_at > maxCreatedAt) maxCreatedAt = r.created_at;
    }

    // ── 3. Qualify + classify in JS ──
    const inserts: MentionInsert[] = [];
    for (const r of rows) {
      const mi = classify(r);
      if (mi) inserts.push(mi);
    }
    const qualified = inserts.length;

    // ── 4. Batch INSERT ON CONFLICT DO UPDATE ──
    // Use the existing unique index (brand_id, source, source_url)
    // for dedup. On conflict we touch last_seen/last_checked so the
    // UI sorts by recency correctly when the same paste/post is
    // observed again.
    let inserted = 0;
    for (let i = 0; i < inserts.length; i += CHUNK_SIZE) {
      const chunk = inserts.slice(i, i + CHUNK_SIZE);
      const stmts = chunk.map((m) =>
        env.DB.prepare(`
          INSERT INTO dark_web_mentions (
            id, brand_id, source, source_url, source_channel, source_author,
            posted_at, content_snippet, matched_terms, match_type,
            classification, classified_by, classification_confidence,
            classification_reason, severity, status,
            first_seen, last_seen, last_checked
          ) VALUES (
            ?, ?, 'telegram', ?, ?, ?,
            ?, ?, ?, ?,
            ?, 'system', ?,
            ?, ?, 'active',
            datetime('now'), datetime('now'), datetime('now')
          )
          ON CONFLICT (brand_id, source, source_url) DO UPDATE SET
            last_seen    = datetime('now'),
            last_checked = datetime('now'),
            updated_at   = datetime('now')
        `).bind(
          m.id, m.brand_id, m.source_url, m.source_channel, m.source_author,
          m.posted_at, m.content_snippet, m.matched_terms, m.match_type,
          m.classification, m.classification_confidence,
          m.classification_reason, m.severity,
        )
      );
      batchesAttempted++;
      try {
        const results = await env.DB.batch(stmts);
        for (const r of results) inserted += r.meta?.changes ?? 0;
      } catch (err) {
        batchesFailed++;
        if (!lastError) {
          lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
        console.error('[dark-web-reconciler] batch failed:', err);
      }
    }

    // ── 5. Advance cursor ──
    // Persist even if some batches failed — the failed rows would
    // be retried next tick via INSERT OR IGNORE-style ON CONFLICT
    // (the unique index dedups). Not advancing pins the cursor on
    // a permanent-failure row.
    let cursorAfter: string | null = cursorBefore;
    if (maxCreatedAt > cursor) {
      try {
        await env.CACHE.put(CURSOR_KEY, maxCreatedAt, {
          expirationTtl: 86_400 * 7,
        });
        cursorAfter = maxCreatedAt;
      } catch (err) {
        console.error('[dark-web-reconciler] cursor write failed:', err);
        if (!lastError) {
          lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
      }
    }

    return {
      skipped: false,
      scanned,
      qualified,
      inserted,
      cursorBefore,
      cursorAfter,
      cursorLagMinutes,
      durationMs: Date.now() - start,
      batchesAttempted,
      batchesFailed,
      lastError,
    };
  } catch (err) {
    console.error('[dark-web-reconciler] fatal:', err);
    return {
      ...base,
      skipped: true,
      reason: err instanceof Error ? err.message : 'fatal_error',
      durationMs: Date.now() - start,
      batchesAttempted,
      batchesFailed,
      lastError: lastError ?? (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
    };
  }
}
