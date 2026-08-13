/**
 * Marketing visibility aggregation — the single source of truth for both
 * the daily briefing's "Marketing & AI Visibility" section and the admin
 * GET /api/admin/marketing-analytics endpoint.
 *
 * Every query is wrapped in a local safe helper that returns a zeroed
 * fallback on error, so a missing table or malformed row can never throw
 * out of here. The only variable is the window in hours, which is clamped
 * to an integer in [1, 168] before use.
 */
import type { Env } from "../types";

export interface MarketingVisibility {
  windowHours: number;
  humanViews: number;
  aiCrawlerViews: number;
  otherBotViews: number;
  aiReferralSessions: number;
  ctaClicks: number;
  contactSubs: number;
  topPages: Array<{ page: string; views: number }>;
  aiCrawlerBreakdown: Array<{ crawler_name: string; hits: number }>;
  aiReferralBySource: Array<{ ai_source: string; sessions: number }>;
}

async function safeCount(db: Env["DB"], sql: string, hours: number): Promise<number> {
  try {
    const row = await db.prepare(sql).bind(hours).first<{ n: number }>();
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

async function safeRows<T>(db: Env["DB"], sql: string, hours: number): Promise<T[]> {
  try {
    const result = await db.prepare(sql).bind(hours).all<T>();
    return (result.results as T[]) ?? [];
  } catch {
    return [];
  }
}

const WINDOW = "created_at >= datetime('now','-'||?||' hours')";

export async function fetchMarketingVisibility(env: Env, hours = 24): Promise<MarketingVisibility> {
  const db = env.DB;
  const h = Math.min(168, Math.max(1, Math.trunc(Number(hours) || 24)));

  const [
    humanViews,
    aiCrawlerViews,
    otherBotViews,
    aiReferralSessions,
    ctaClicks,
    contactSubs,
    topPages,
    aiCrawlerBreakdown,
    aiReferralBySource,
  ] = await Promise.all([
    safeCount(
      db,
      `SELECT COUNT(*) AS n FROM marketing_events
       WHERE event_type='pageview' AND source='beacon' AND ${WINDOW}`,
      h,
    ),
    safeCount(
      db,
      `SELECT COUNT(*) AS n FROM marketing_events
       WHERE source='edge' AND is_ai_crawler=1 AND ${WINDOW}`,
      h,
    ),
    safeCount(
      db,
      `SELECT COUNT(*) AS n FROM marketing_events
       WHERE source='edge' AND is_bot=1 AND is_ai_crawler=0 AND ${WINDOW}`,
      h,
    ),
    safeCount(
      db,
      `SELECT COUNT(DISTINCT visitor_hash) AS n FROM marketing_events
       WHERE is_ai_referral=1 AND ${WINDOW}`,
      h,
    ),
    safeCount(
      db,
      `SELECT COUNT(*) AS n FROM marketing_events
       WHERE event_type IN ('cta','click') AND ${WINDOW}`,
      h,
    ),
    safeCount(
      db,
      `SELECT COUNT(*) AS n FROM contact_submissions WHERE ${WINDOW}`,
      h,
    ),
    safeRows<{ page: string; views: number }>(
      db,
      `SELECT page, COUNT(*) AS views FROM marketing_events
       WHERE event_type='pageview' AND ${WINDOW}
       GROUP BY page ORDER BY views DESC LIMIT 8`,
      h,
    ),
    safeRows<{ crawler_name: string; hits: number }>(
      db,
      `SELECT crawler_name, COUNT(*) AS hits FROM marketing_events
       WHERE is_ai_crawler=1 AND ${WINDOW}
       GROUP BY crawler_name ORDER BY hits DESC LIMIT 10`,
      h,
    ),
    safeRows<{ ai_source: string; sessions: number }>(
      db,
      `SELECT ai_source, COUNT(DISTINCT visitor_hash) AS sessions FROM marketing_events
       WHERE is_ai_referral=1 AND ${WINDOW}
       GROUP BY ai_source ORDER BY sessions DESC`,
      h,
    ),
  ]);

  return {
    windowHours: h,
    humanViews,
    aiCrawlerViews,
    otherBotViews,
    aiReferralSessions,
    ctaClicks,
    contactSubs,
    topPages,
    aiCrawlerBreakdown,
    aiReferralBySource,
  };
}
