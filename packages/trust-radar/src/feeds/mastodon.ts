/**
 * Mastodon/Fediverse Social Feed — Brand mention monitoring across instances.
 *
 * No authentication needed for public data.
 * Rate limit: 300 requests/5 minutes per instance.
 *
 * Cron: every 4 hours. The orchestrator triggers this feed up to ~6×/day,
 * so per-tick scope is intentionally narrow — the aggregate cycle covers
 * every brand × instance over multiple days.
 *
 * Implementation note (2026-05-04 rewrite):
 *
 * The previous version per-tick scanned 4 instances × 10 brands ×
 * 2 queries (name + domain) = 80 search calls plus two timeline scans,
 * each followed by per-status `KV GET → DB SELECT → DB INSERT → KV PUT`
 * (4 awaits/status × ≤20 statuses/search = up to 6,400 sub-requests).
 * That's well over the Worker per-invocation ceiling and explains the
 * 4 orphan pull-history rows seen in 24h diagnostics.
 *
 * Two structural changes:
 *
 *  1) **Rotate one instance per tick.** The instance offset lives in
 *     KV (`mastodon_instance_offset`). With 4 instances and a 4-hour
 *     cron, every instance still gets scanned every 16 hours — the
 *     existing brand-offset rotation already takes ~5 days to cover
 *     347 brands, so the instance rotation is well within that envelope.
 *
 *  2) **Bulk INSERT OR IGNORE via `db.batch()`.** Drops the per-status
 *     `SELECT id FROM social_mentions WHERE id = ?` and the per-status
 *     KV GET/PUT pair. PK collisions on `social_mentions.id` give us
 *     accurate new-vs-duplicate accounting via `meta.changes`. Aligns
 *     with CLAUDE.md §8 ("Use ON CONFLICT DO NOTHING — never SELECT
 *     then INSERT").
 */

import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";

// ─── Types ───────────────────────────────────────────────────────

interface BrandRow {
  id: string;
  name: string;
  canonical_domain: string | null;
}

interface MastodonStatus {
  id: string;
  url: string;
  content: string;       // HTML
  created_at: string;
  favourites_count: number;
  reblogs_count: number;
  in_reply_to_id: string | null;
  account: {
    acct: string;        // user@instance or just user
    url: string;
    display_name: string;
    followers_count: number;
  };
}

interface MastodonSearchResult {
  statuses: MastodonStatus[];
}

interface PendingMention {
  id: string;
  status: MastodonStatus;
  brand: BrandRow;
  instance: string;
  matchType: "keyword" | "domain";
}

// Mastodon instances to search — rotated one per tick.
const MASTODON_INSTANCES = [
  "mastodon.social",      // Largest general instance
  "infosec.exchange",     // InfoSec community (most relevant)
  "ioc.exchange",         // IOC sharing community
  "hachyderm.io",         // Tech community
];

const BRANDS_PER_RUN = 10;
const DELAY_BETWEEN_CALLS_MS = 1500;
const MAX_API_CALLS_PER_RUN = 30;
const MENTION_BATCH_CHUNK = 50;
const STATUSES_PER_SEARCH = 20;
const TIMELINE_LIMIT = 40;

// ─── Feed Module ─────────────────────────────────────────────────

export const mastodon: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const env = ctx.env;
    let itemsFetched = 0;
    let itemsError = 0;
    let apiCalls = 0;

    // Pick one instance per tick. Offset wraps after we increment.
    const instanceOffsetRaw = await env.CACHE.get("mastodon_instance_offset");
    const instanceOffset = parseInt(instanceOffsetRaw ?? "0", 10);
    const instance = MASTODON_INSTANCES[instanceOffset % MASTODON_INSTANCES.length]!;
    await env.CACHE.put(
      "mastodon_instance_offset",
      String((instanceOffset + 1) % MASTODON_INSTANCES.length),
      { expirationTtl: 86_400 * 7 },
    );

    // Get brands to monitor (rotate BRANDS_PER_RUN per run)
    const offset = parseInt((await env.CACHE.get("mastodon_brand_offset")) ?? "0", 10);
    const brands = await env.DB.prepare(`
      SELECT b.id, b.name, b.canonical_domain
      FROM brands b
      WHERE b.monitoring_status = 'active'
        AND b.threat_count > 0
      ORDER BY b.threat_count DESC
      LIMIT ? OFFSET ?
    `).bind(BRANDS_PER_RUN, offset).all<BrandRow>();

    // Update offset for next run
    const nextOffset = brands.results.length < BRANDS_PER_RUN ? 0 : offset + BRANDS_PER_RUN;
    await env.CACHE.put("mastodon_brand_offset", String(nextOffset), { expirationTtl: 86_400 });

    // Surface brand-eligibility gate as a visible warning.
    if (brands.results.length === 0) {
      throw new Error(
        `Mastodon: no eligible brands (need monitoring_status='active' AND threat_count>0)`,
      );
    }

    // Load all eligible brands once — used for the timeline keyword scan.
    const allBrands = await env.DB.prepare(`
      SELECT id, name, canonical_domain FROM brands
      WHERE monitoring_status = 'active' AND threat_count > 0
      ORDER BY threat_count DESC LIMIT 50
    `).all<BrandRow>();

    // Collect every observed mention into a single buffer; flush once at
    // the end via db.batch(). De-dupe within the buffer by id so a status
    // matching multiple brands only produces one INSERT per (status,brand).
    const pending = new Map<string, PendingMention>();

    // 1. Brand-specific search on the elected instance only
    for (const brand of brands.results) {
      if (apiCalls >= MAX_API_CALLS_PER_RUN) break;

      // Search for brand name
      try {
        const statuses = await searchMastodon(instance, brand.name);
        apiCalls++;
        itemsFetched += collectMentions(pending, statuses, brand, instance, "keyword");
      } catch (err) {
        itemsError++;
        console.error(`[mastodon] Search error for ${brand.name} on ${instance}:`, err instanceof Error ? err.message : String(err));
      }

      await delay(DELAY_BETWEEN_CALLS_MS);

      // Search for brand domain if available
      if (brand.canonical_domain && apiCalls < MAX_API_CALLS_PER_RUN) {
        try {
          const statuses = await searchMastodon(instance, brand.canonical_domain);
          apiCalls++;
          itemsFetched += collectMentions(pending, statuses, brand, instance, "domain");
        } catch (err) {
          itemsError++;
          console.error(`[mastodon] Domain search error for ${brand.canonical_domain} on ${instance}:`, err instanceof Error ? err.message : String(err));
        }

        await delay(DELAY_BETWEEN_CALLS_MS);
      }
    }

    // 2. Local timeline scan on the elected instance — surface free
    // mentions of any eligible brand.
    if (apiCalls < MAX_API_CALLS_PER_RUN) {
      try {
        const timelineStatuses = await fetchLocalTimeline(instance);
        apiCalls++;
        for (const status of timelineStatuses) {
          const text = stripHtml(status.content).toLowerCase();
          for (const brand of allBrands.results) {
            const nameMatch = text.includes(brand.name.toLowerCase());
            const domainMatch = brand.canonical_domain
              ? text.includes(brand.canonical_domain.toLowerCase())
              : false;
            if (nameMatch || domainMatch) {
              const matchType: PendingMention["matchType"] = domainMatch ? "domain" : "keyword";
              const id = `mastodon_${instance}_${status.id}_${brand.id}`;
              if (!pending.has(id)) {
                pending.set(id, { id, status, brand, instance, matchType });
                itemsFetched++;
              }
            }
          }
        }
      } catch (err) {
        itemsError++;
        console.error(`[mastodon] timeline error on ${instance}:`, err instanceof Error ? err.message : String(err));
      }
    }

    // 3. Bulk INSERT OR IGNORE — single round-trip per chunk.
    const { itemsNew, itemsDuplicate } = await flushPendingMentions(env, pending);

    console.log(
      `[mastodon] instance=${instance} fetched=${itemsFetched} new=${itemsNew} dup=${itemsDuplicate} errors=${itemsError} api_calls=${apiCalls}`,
    );
    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};

// ─── Mastodon API Calls ─────────────────────────────────────────

async function searchMastodon(instance: string, query: string): Promise<MastodonStatus[]> {
  const url = `https://${instance}/api/v2/search?q=${encodeURIComponent(query)}&type=statuses&limit=${STATUSES_PER_SEARCH}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Averrow/1.0 (Threat Intelligence Platform)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Mastodon search ${instance} ${response.status}`);
  }
  const data = (await response.json()) as MastodonSearchResult;
  return data.statuses ?? [];
}

async function fetchLocalTimeline(instance: string): Promise<MastodonStatus[]> {
  const url = `https://${instance}/api/v1/timelines/public?local=true&limit=${TIMELINE_LIMIT}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Averrow/1.0 (Threat Intelligence Platform)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Mastodon timeline ${instance} ${response.status}`);
  }
  return (await response.json()) as MastodonStatus[];
}

// ─── Result Buffering & Flush ───────────────────────────────────

/**
 * Append every status from a search result to the pending buffer for
 * one (brand, instance, matchType) tuple. Returns the number of new
 * candidate mentions the buffer accepted (de-duped by id).
 */
function collectMentions(
  pending: Map<string, PendingMention>,
  statuses: MastodonStatus[],
  brand: BrandRow,
  instance: string,
  matchType: PendingMention["matchType"],
): number {
  let added = 0;
  for (const status of statuses) {
    const id = `mastodon_${instance}_${status.id}_${brand.id}`;
    if (pending.has(id)) continue;
    pending.set(id, { id, status, brand, instance, matchType });
    added++;
  }
  return added;
}

/**
 * Flush the pending buffer via db.batch(INSERT OR IGNORE). Counts
 * `meta.changes` from each statement to distinguish new (1) from
 * duplicate (0). No KV touch — the threats PK already gives us
 * cross-tick dedup.
 */
async function flushPendingMentions(
  env: Env,
  pending: Map<string, PendingMention>,
): Promise<{ itemsNew: number; itemsDuplicate: number }> {
  if (pending.size === 0) return { itemsNew: 0, itemsDuplicate: 0 };

  const entries = [...pending.values()];
  const stmts = entries.map((m) => {
    const contentText = stripHtml(m.status.content).slice(0, 2000);
    const confidence = m.matchType === "domain" ? 80 : 60;
    const metadata = JSON.stringify({
      instance: m.instance,
      favourites: m.status.favourites_count,
      reblogs: m.status.reblogs_count,
      in_reply_to: m.status.in_reply_to_id,
      account_followers: m.status.account.followers_count,
    });
    return env.DB.prepare(`
      INSERT OR IGNORE INTO social_mentions
        (id, platform, source_feed, content_type, content_url, content_text,
         content_author, content_author_url, content_created,
         brand_id, brand_name, match_type, match_confidence,
         platform_metadata, status, created_at, updated_at)
      VALUES (?, 'mastodon', 'mastodon', 'toot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))
    `).bind(
      m.id,
      m.status.url,
      contentText,
      m.status.account.acct,
      m.status.account.url,
      m.status.created_at,
      m.brand.id,
      m.brand.name,
      m.matchType,
      confidence,
      metadata,
    );
  });

  let itemsNew = 0;
  let itemsDuplicate = 0;
  for (let i = 0; i < stmts.length; i += MENTION_BATCH_CHUNK) {
    const chunk = stmts.slice(i, i + MENTION_BATCH_CHUNK);
    try {
      const results = await env.DB.batch(chunk);
      for (const r of results) {
        const changed = r.meta?.changes ?? 0;
        if (changed > 0) itemsNew++;
        else itemsDuplicate++;
      }
    } catch (err) {
      console.error(`[mastodon] batch flush ${i}-${i + chunk.length} failed:`, err instanceof Error ? err.message : String(err));
      // Treat a chunk failure as duplicate-bucket so we don't double-count
      // the buffer entries that didn't make it in. The next tick will
      // surface them again (they're idempotent by id).
      itemsDuplicate += chunk.length;
    }
  }

  return { itemsNew, itemsDuplicate };
}

// ─── Helpers ────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
