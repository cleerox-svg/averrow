/**
 * News Watcher Agent — RSS ingestion → actor + geopolitical campaign updates.
 *
 * Phase D of the Threat Actors rebuild. Polls a configured set of
 * threat-intel RSS / Atom feeds (CISA advisories, Mandiant blog,
 * Microsoft Threat Intelligence, etc.), dedups by article URL, and
 * for each NEW item asks Haiku to extract structured intel:
 *
 *   * actors          — named threat actors / APTs mentioned
 *   * target_countries — ISO-2 codes
 *   * target_sectors   — finance / gov / energy / etc.
 *   * severity         — critical / high / medium / low / info
 *   * is_geopolitical  — drives geopolitical_campaigns auto-population
 *   * campaign_label   — short title for the campaign row
 *
 * Side effects per article:
 *
 *   1. Insert a news_articles row (idempotent on article_url).
 *   2. For each extracted actor name, upsertActorByName(... 'news') —
 *      creates new actor rows on first mention, bumps last_seen on
 *      existing ones. The Threat Actors page surfaces the freshness.
 *   3. When is_geopolitical is true, create or update a
 *      geopolitical_campaigns row keyed by a stable hash of
 *      (campaign_label OR sorted-actors). Subsequent articles bump
 *      updated_at and append to the row's actor / country / sector
 *      arrays (deduped).
 *
 * Schedule: every 6 hours at hour % 6 === 2 (jittered off the
 * NEXUS / Sparrow / Strategist windows so we don't pile Haiku
 * throughput). Bounded by ARTICLES_PER_RUN.
 *
 * Cost guard: enforced. Worst case ARTICLES_PER_RUN × 1 Haiku call.
 */

import type { AgentModule, AgentResult, AgentContext } from "../lib/agentRunner";
import { checkCostGuard } from "../lib/haiku";
import { upsertActorByName } from "../lib/otx-attribution";
import { parseRss, type RssItem } from "../lib/rss-parser";
import { extractFromArticle, type NewsExtraction } from "../lib/news-extractor";
import { withD1Retry } from "../lib/d1-retry";

const ARTICLES_PER_RUN = 30;

interface FeedConfig {
  id: string;     // 'cisa' | 'mandiant' | 'msft_threatintel' | …
  url: string;
}

const FEEDS: FeedConfig[] = [
  // CISA advisories — official US gov cyber alerts. RSS format.
  { id: "cisa", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml" },
  // Microsoft Threat Intelligence blog. Atom format.
  { id: "msft_threatintel", url: "https://www.microsoft.com/en-us/security/blog/topic/threat-intelligence/feed/" },
  // Mandiant / Google Cloud threat-intel blog. RSS format.
  { id: "mandiant", url: "https://cloud.google.com/blog/topics/threat-intelligence/rss/" },
];

function articleId(feedId: string, url: string): string {
  // Stable URL-derived id keeps reruns idempotent.
  return `art_${feedId}_${url.replace(/[^a-z0-9]+/gi, "_").slice(0, 80)}`.slice(0, 100);
}

function campaignIdFor(label: string | null, actors: string[]): string {
  // Prefer the Haiku-supplied campaign_label for the stable id; fall
  // back to a sorted-actor-hash when the label is missing.
  const seed = label?.toLowerCase().trim()
    || actors.map((a) => a.toLowerCase().trim()).sort().join("|")
    || "unknown";
  const slug = seed.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
  return `gc_news_${slug || "unknown"}`;
}

function dedupAppend(existing: string[], incoming: string[]): string[] {
  const set = new Set([...existing, ...incoming].map((s) => s.trim()).filter(Boolean));
  return Array.from(set).slice(0, 50);
}

function safeParseStringArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function fetchAndParse(feed: FeedConfig): Promise<RssItem[]> {
  try {
    const res = await fetch(feed.url, {
      signal: AbortSignal.timeout(30_000), headers: {
        "User-Agent": "Averrow-NewsWatcher/1.0",
        Accept: "application/rss+xml, application/atom+xml, text/xml, */*",
      },
    });
    if (!res.ok) {
      console.error(`[news-watcher] ${feed.id} HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    return parseRss(xml);
  } catch (err) {
    console.error(`[news-watcher] ${feed.id} fetch failed:`, err);
    return [];
  }
}

async function upsertGeopoliticalCampaign(
  db: D1Database,
  extraction: NewsExtraction,
  article: { title: string; url: string },
): Promise<void> {
  if (!extraction.is_geopolitical || extraction.actors.length === 0) return;

  const id = campaignIdFor(extraction.campaign_label, extraction.actors);
  const name = extraction.campaign_label ?? `Reported activity — ${extraction.actors[0]}`;

  // Read any existing campaign row so we can dedup-append actors / countries / sectors.
  const existing = await db
    .prepare(
      `SELECT threat_actors, target_countries, target_sectors
         FROM geopolitical_campaigns WHERE id = ?`,
    )
    .bind(id)
    .first<{ threat_actors: string | null; target_countries: string | null; target_sectors: string | null }>();

  const mergedActors    = dedupAppend(safeParseStringArray(existing?.threat_actors),    extraction.actors);
  const mergedCountries = dedupAppend(safeParseStringArray(existing?.target_countries), extraction.target_countries);
  const mergedSectors   = dedupAppend(safeParseStringArray(existing?.target_sectors),   extraction.target_sectors);

  const priority = extraction.severity === "critical" ? "critical"
                 : extraction.severity === "high"     ? "high"
                 : "medium";

  await db
    .prepare(
      `INSERT INTO geopolitical_campaigns
          (id, name, status, briefing_priority,
           threat_actors, target_countries, target_sectors,
           created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
          name              = excluded.name,
          status            = 'active',
          briefing_priority = excluded.briefing_priority,
          threat_actors     = excluded.threat_actors,
          target_countries  = excluded.target_countries,
          target_sectors    = excluded.target_sectors,
          updated_at        = datetime('now')`,
    )
    .bind(
      id,
      name,
      priority,
      JSON.stringify(mergedActors),
      JSON.stringify(mergedCountries),
      JSON.stringify(mergedSectors),
    )
    .run();
}

export const newsWatcherAgent: AgentModule = {
  name: "news_watcher",
  displayName: "NEWS WATCHER",
  description: "Polls threat-intel RSS feeds, extracts actors + geopolitical context via Haiku",
  color: "#3CB878",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 20,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 80_000_000 },
  reads: [
    { kind: "d1_table", name: "news_articles" },
    { kind: "d1_table", name: "geopolitical_campaigns" },
    { kind: "external", name: "cisa_advisories",  url: "https://www.cisa.gov/cybersecurity-advisories/all.xml" },
    { kind: "external", name: "msft_threatintel", url: "https://www.microsoft.com/en-us/security/blog/topic/threat-intelligence/feed/" },
    { kind: "external", name: "mandiant_blog",    url: "https://cloud.google.com/blog/topics/threat-intelligence/rss/" },
  ],
  writes: [
    { kind: "d1_table", name: "news_articles" },
    { kind: "d1_table", name: "geopolitical_campaigns" },
  ],
  outputs: [{ type: "insight" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 38,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, runId } = ctx;
    const callCtx = { agentId: "news_watcher", runId };

    const guard = await checkCostGuard(env, false);
    if (guard) {
      return {
        itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0,
        output: { skipped: true, reason: `cost guard: ${guard}` },
      };
    }

    let totalFetched = 0;
    let totalNew = 0;
    let extractedOk = 0;
    let extractedNoActors = 0;
    let extractedFailed = 0;
    let actorsUpserted = 0;
    let campaignsUpserted = 0;

    // Pull every configured feed in serial — three feeds × ~50 items
    // each is a few hundred ms of network total, well inside the
    // worker's CPU budget.
    for (const feed of FEEDS) {
      const items = await fetchAndParse(feed);
      totalFetched += items.length;

      // Process up to ARTICLES_PER_RUN total articles per cycle (across
      // all feeds combined). Most feed cycles will see ≤ 5 truly new
      // items thanks to the news_articles dedup, so the cap rarely bites.
      for (const item of items) {
        if (totalNew >= ARTICLES_PER_RUN) break;

        const id = articleId(feed.id, item.link);

        // Cheap dedup: bail if we've already ingested this URL.
        const dup = await env.DB
          .prepare(`SELECT 1 FROM news_articles WHERE article_url = ? LIMIT 1`)
          .bind(item.link)
          .first<{ 1: number }>();
        if (dup) continue;

        totalNew++;

        let extraction: NewsExtraction | null = null;
        let extractStatus: "ok" | "no_actors" | "failed" = "failed";

        try {
          extraction = await extractFromArticle(env, callCtx, item.title, item.description);
          if (extraction.actors.length === 0) {
            extractStatus = "no_actors";
            extractedNoActors++;
          } else {
            extractStatus = "ok";
            extractedOk++;
          }
        } catch (err) {
          console.error(`[news-watcher] extract failed for ${item.link}:`, err);
          extractedFailed++;
        }

        // Always insert the article row (extraction status reflects
        // success/failure). Retry on transient D1 errors — this per-item
        // INSERT OR IGNORE is the agent's hottest write and was the likely
        // source of the "D1_ERROR: Network connection lost" run failures.
        // Idempotent (INSERT OR IGNORE on a deterministic id) → safe to retry.
        await withD1Retry(
          () =>
            env.DB
              .prepare(`
                INSERT OR IGNORE INTO news_articles
                  (id, source_feed, article_url, title, excerpt, published_at,
                   extracted, extract_status, is_geopolitical)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `)
              .bind(
                id,
                feed.id,
                item.link,
                item.title.slice(0, 500),
                item.description.slice(0, 1000),
                item.publishedAt,
                extraction ? JSON.stringify(extraction) : null,
                extractStatus,
                extraction?.is_geopolitical ? 1 : 0,
              )
              .run(),
          { label: "news_watcher article insert" },
        );

        if (!extraction || extraction.actors.length === 0) continue;

        // Upsert each named actor — bumps last_seen on existing ones,
        // creates new rows for first-seen names.
        const country = extraction.target_countries[0] ?? null;
        for (const actorName of extraction.actors) {
          try {
            const actorId = await upsertActorByName(env.DB, actorName, "news", country);
            if (actorId) actorsUpserted++;
          } catch (err) {
            console.error(`[news-watcher] actor upsert failed for ${actorName}:`, err);
          }
        }

        // Auto-create / update the geopolitical campaign for state-sponsored items.
        if (extraction.is_geopolitical) {
          try {
            await upsertGeopoliticalCampaign(env.DB, extraction, { title: item.title, url: item.link });
            campaignsUpserted++;
          } catch (err) {
            console.error(`[news-watcher] campaign upsert failed:`, err);
          }
        }
      }
      if (totalNew >= ARTICLES_PER_RUN) break;
    }

    return {
      itemsProcessed: totalFetched,
      itemsCreated: totalNew,
      itemsUpdated: actorsUpserted + campaignsUpserted,
      output: {
        feeds_polled: FEEDS.length,
        articles_fetched: totalFetched,
        articles_new: totalNew,
        extracted_ok: extractedOk,
        extracted_no_actors: extractedNoActors,
        extracted_failed: extractedFailed,
        actors_upserted: actorsUpserted,
        campaigns_upserted: campaignsUpserted,
      },
    };
  },
};
