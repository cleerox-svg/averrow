/**
 * Reddit Social Feed — Brand mention monitoring across cybersecurity subreddits.
 *
 * Authentication: OAuth2 client_credentials (app-only, no user login needed)
 * Rate limit: 100 requests/minute
 * Schedule: Every 2 hours
 *
 * Two monitoring modes:
 * 1. Brand-specific search: queries Reddit search for each brand's name/domain
 * 2. Subreddit monitoring: scans cybersecurity subreddits for any brand mention
 *
 * Rotates 10 brands per run (round-robin via KV counter).
 */

import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";

// ─── Types ───────────────────────────────────────────────────────

interface RedditPost {
  kind: string;
  data: {
    id: string;
    name: string;
    title: string;
    selftext: string;
    author: string;
    permalink: string;
    url: string;
    subreddit: string;
    score: number;
    num_comments: number;
    created_utc: number;
    is_self: boolean;
  };
}

interface RedditListing {
  kind: string;
  data: {
    children: RedditPost[];
    after: string | null;
  };
}

interface BrandRow {
  id: string;
  name: string;
  canonical_domain: string | null;
}

// Cybersecurity subreddits to monitor for brand mentions
const SECURITY_SUBREDDITS = ['cybersecurity', 'netsec', 'phishing', 'Scams', 'hacking'];

const MAX_API_CALLS_PER_RUN = 50;
const BRANDS_PER_RUN = 10;
const DELAY_BETWEEN_CALLS_MS = 1000;

// ─── Feed Module ─────────────────────────────────────────────────

export const reddit: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const env = ctx.env;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;
    let apiCalls = 0;

    // Check for Reddit credentials
    const clientId = env.REDDIT_CLIENT_ID;
    const clientSecret = env.REDDIT_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.log('[reddit] No REDDIT_CLIENT_ID/SECRET configured — skipping');
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // 1. Get OAuth token
    const token = await getRedditToken(env, clientId, clientSecret);
    if (!token) {
      console.error('[reddit] Failed to obtain OAuth token — skipping');
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 1 };
    }

    // 2. Get brands to monitor (rotate 10 per run)
    const offset = parseInt(await env.CACHE.get('reddit_brand_offset') ?? '0', 10);
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
    await env.CACHE.put('reddit_brand_offset', String(nextOffset), { expirationTtl: 86400 });

    // 3. Brand-specific search
    for (const brand of brands.results) {
      if (apiCalls >= MAX_API_CALLS_PER_RUN) break;

      // Search for brand name (exact match)
      try {
        const nameResults = await searchReddit(token, `"${brand.name}"`, apiCalls);
        apiCalls++;
        const nameProcessed = await processRedditPosts(env, nameResults, brand, 'keyword');
        itemsFetched += nameProcessed.fetched;
        itemsNew += nameProcessed.new;
        itemsDuplicate += nameProcessed.duplicate;
      } catch (err) {
        itemsError++;
        console.error(`[reddit] Search error for brand ${brand.name}:`, err instanceof Error ? err.message : String(err));
      }

      await delay(DELAY_BETWEEN_CALLS_MS);

      // Search for brand domain if available
      if (brand.canonical_domain && apiCalls < MAX_API_CALLS_PER_RUN) {
        try {
          const domainResults = await searchReddit(token, `"${brand.canonical_domain}"`, apiCalls);
          apiCalls++;
          const domainProcessed = await processRedditPosts(env, domainResults, brand, 'domain');
          itemsFetched += domainProcessed.fetched;
          itemsNew += domainProcessed.new;
          itemsDuplicate += domainProcessed.duplicate;
        } catch (err) {
          itemsError++;
          console.error(`[reddit] Domain search error for ${brand.canonical_domain}:`, err instanceof Error ? err.message : String(err));
        }

        await delay(DELAY_BETWEEN_CALLS_MS);
      }
    }

    // 4. Subreddit monitoring — scan security subreddits for any brand mention
    const allBrandNames = await env.DB.prepare(`
      SELECT id, name, canonical_domain FROM brands
      WHERE monitoring_status = 'active' AND threat_count > 0
      ORDER BY threat_count DESC LIMIT 50
    `).all<BrandRow>();

    for (const subreddit of SECURITY_SUBREDDITS) {
      if (apiCalls >= MAX_API_CALLS_PER_RUN) break;

      try {
        const posts = await fetchSubredditNew(token, subreddit);
        apiCalls++;

        for (const post of posts) {
          const text = `${post.data.title} ${post.data.selftext}`.toLowerCase();

          // Check against all monitored brands
          for (const brand of allBrandNames.results) {
            const nameMatch = text.includes(brand.name.toLowerCase());
            const domainMatch = brand.canonical_domain ? text.includes(brand.canonical_domain.toLowerCase()) : false;

            if (nameMatch || domainMatch) {
              const result = await insertSocialMention(env, post, brand, domainMatch ? 'domain' : 'keyword');
              if (result === 'new') {
                itemsNew++;
              } else if (result === 'duplicate') {
                itemsDuplicate++;
              }
              itemsFetched++;
            }
          }
        }
      } catch (err) {
        itemsError++;
        console.error(`[reddit] Subreddit r/${subreddit} error:`, err instanceof Error ? err.message : String(err));
      }

      await delay(DELAY_BETWEEN_CALLS_MS);
    }

    console.log(`[reddit] Complete: fetched=${itemsFetched} new=${itemsNew} dup=${itemsDuplicate} errors=${itemsError} api_calls=${apiCalls}`);

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};

// ─── Reddit Auth ─────────────────────────────────────────────────

async function getRedditToken(env: Env, clientId: string, clientSecret: string): Promise<string | null> {
  // Check KV cache first
  const cached = await env.CACHE.get('reddit_access_token');
  if (cached) return cached;

  try {
    const auth = btoa(`${clientId}:${clientSecret}`);
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Averrow/1.0 (Threat Intelligence Platform)',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[reddit] Auth failed: ${response.status} ${text.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    if (!data.access_token) return null;

    // Cache with 55-minute TTL (tokens last 60 min)
    await env.CACHE.put('reddit_access_token', data.access_token, { expirationTtl: 3300 });
    return data.access_token;
  } catch (err) {
    console.error('[reddit] Auth error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── Reddit API Calls ────────────────────────────────────────────

async function searchReddit(token: string, query: string, _callNum: number): Promise<RedditPost[]> {
  const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(query)}&sort=new&limit=25&t=day&type=link`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Averrow/1.0 (Threat Intelligence Platform)',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Reddit search ${response.status}`);
  }

  const listing = await response.json() as RedditListing;
  return listing.data?.children ?? [];
}

async function fetchSubredditNew(token: string, subreddit: string): Promise<RedditPost[]> {
  const url = `https://oauth.reddit.com/r/${subreddit}/new?limit=25`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Averrow/1.0 (Threat Intelligence Platform)',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Reddit r/${subreddit}/new ${response.status}`);
  }

  const listing = await response.json() as RedditListing;
  return listing.data?.children ?? [];
}

// ─── Post Processing ─────────────────────────────────────────────

async function processRedditPosts(
  env: Env,
  posts: RedditPost[],
  brand: BrandRow,
  matchType: string,
): Promise<{ fetched: number; new: number; duplicate: number }> {
  let fetched = 0;
  let newCount = 0;
  let duplicate = 0;

  for (const post of posts) {
    fetched++;
    const result = await insertSocialMention(env, post, brand, matchType);
    if (result === 'new') newCount++;
    else if (result === 'duplicate') duplicate++;
  }

  return { fetched, new: newCount, duplicate };
}

async function insertSocialMention(
  env: Env,
  post: RedditPost,
  brand: BrandRow,
  matchType: string,
): Promise<'new' | 'duplicate' | 'error'> {
  const redditId = post.data.id;
  const dedupKey = `social:reddit:${redditId}:${brand.id}`;

  // Check KV dedup cache
  const seen = await env.CACHE.get(dedupKey);
  if (seen) return 'duplicate';

  // Check DB dedup
  const existing = await env.DB.prepare(
    `SELECT id FROM social_mentions WHERE platform = 'reddit' AND id = ?`
  ).bind(`reddit_${redditId}_${brand.id}`).first();
  if (existing) {
    await env.CACHE.put(dedupKey, '1', { expirationTtl: 7200 });
    return 'duplicate';
  }

  const contentText = `${post.data.title}\n\n${post.data.selftext}`.slice(0, 2000);
  const confidence = matchType === 'domain' ? 80 : 60;
  const permalink = `https://reddit.com${post.data.permalink}`;

  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO social_mentions
        (id, platform, source_feed, content_type, content_url, content_text,
         content_author, content_author_url, content_created,
         brand_id, brand_name, match_type, match_confidence,
         platform_metadata, status, created_at, updated_at)
      VALUES (?, 'reddit', 'reddit', 'post', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))
    `).bind(
      `reddit_${redditId}_${brand.id}`,
      permalink,
      contentText,
      post.data.author,
      `https://reddit.com/user/${post.data.author}`,
      new Date(post.data.created_utc * 1000).toISOString(),
      brand.id,
      brand.name,
      matchType,
      confidence,
      JSON.stringify({
        subreddit: post.data.subreddit,
        score: post.data.score,
        num_comments: post.data.num_comments,
        reddit_id: redditId,
        permalink: post.data.permalink,
      }),
    ).run();

    // Mark as seen in KV (2 hour TTL)
    await env.CACHE.put(dedupKey, '1', { expirationTtl: 7200 });
    return 'new';
  } catch (err) {
    console.error(`[reddit] Insert error for ${redditId}:`, err instanceof Error ? err.message : String(err));
    return 'error';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
