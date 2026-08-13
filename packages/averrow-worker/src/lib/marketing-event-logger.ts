/**
 * Marketing edge logger — records AI-crawler / bot visits to public
 * marketing pages. Called via ctx.waitUntil() so it never blocks page
 * serving. Human page views are NOT logged here — those arrive via the
 * client beacon (POST /api/track) which also carries the referrer for
 * AI-referral detection. This edge path only fires for bots/crawlers,
 * which never run the beacon JS.
 *
 * Raw IP is never stored: visitor_hash is a salted, truncated SHA-256 of
 * ip|ua|utc-date so the same visitor can be de-duplicated within a day
 * without retaining a raw identifier.
 */
import type { Env } from "../types";
import { classifyUserAgent } from "./ai-traffic";

// Static salt for the visitor hash. Not a secret (the hash is truncated
// and one-way regardless), but it keeps the digest from being a bare
// hash of public inputs.
const VISITOR_SALT = "averrow-mkt-v1";

/**
 * Salted, truncated (first 16 hex chars) SHA-256 of the day-scoped
 * visitor identity. Shared by the edge logger and the /api/track beacon
 * so both surfaces produce the same hash for the same visitor+day.
 */
export async function computeVisitorHash(ip: string, ua: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10); // UTC yyyy-mm-dd
  const input = `${VISITOR_SALT}|${ip}|${ua}|${day}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}

export async function logMarketingEdgeView(env: Env, request: Request, page: string): Promise<void> {
  try {
    const ua = request.headers.get("User-Agent") || "";
    const cls = classifyUserAgent(ua);

    // Only log bots/crawlers here — humans are handled by the beacon.
    if (!cls.isBot && !cls.isAiCrawler) return;

    const cf = (request as unknown as { cf?: Record<string, unknown> }).cf || {};
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const visitorHash = await computeVisitorHash(ip, ua);

    await env.DB.prepare(
      `INSERT INTO marketing_events
         (event_type, source, page, visitor_hash, user_agent, referer,
          country, city, asn, is_bot, is_ai_crawler, crawler_name,
          is_ai_referral, ai_source)
       VALUES ('pageview', 'edge', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
    ).bind(
      page,
      visitorHash,
      ua,
      request.headers.get("Referer") || null,
      (cf.country as string) || null,
      (cf.city as string) || null,
      cf.asn ? String(cf.asn) : null,
      cls.isBot ? 1 : 0,
      cls.isAiCrawler ? 1 : 0,
      cls.crawlerName,
    ).run();
  } catch {
    // Never let logging affect page serving.
  }
}
