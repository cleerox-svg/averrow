/**
 * Honeypot Visit Logger — logs crawler/bot visits to honeypot pages.
 * Used with ctx.waitUntil() so it doesn't slow down page load.
 */
import type { Env } from "../types";

const BOT_PATTERN = /bot|crawl|spider|scrape|curl|wget|python|php|java|go-http|axios|node-fetch|headless/i;
const BOT_NAME_PATTERN = /(googlebot|bingbot|yandex|baidu|duckduck|facebookexternalhit|twitterbot|linkedinbot|semrush|ahrefs|mj12bot|dotbot|petalbot|curl|wget|python|scrapy|httpclient)/i;

export async function logHoneypotVisit(env: Env, request: Request, page: string): Promise<void> {
  try {
    const cf = (request as unknown as { cf?: Record<string, unknown> }).cf || {};
    const userAgent = request.headers.get("User-Agent") || "";
    const isBot = BOT_PATTERN.test(userAgent);
    const botMatch = isBot ? userAgent.match(BOT_NAME_PATTERN) : null;
    const botName = botMatch ? botMatch[1] : isBot ? "unknown_bot" : null;

    await env.DB.prepare(
      `INSERT INTO honeypot_visits (page, visitor_ip, user_agent, referer, country, city, asn, is_bot, bot_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      page,
      request.headers.get("CF-Connecting-IP"),
      userAgent,
      request.headers.get("Referer") || null,
      (cf.country as string) || null,
      (cf.city as string) || null,
      cf.asn ? String(cf.asn) : null,
      isBot ? 1 : 0,
      botName,
    ).run();
  } catch {
    // Don't let logging failures affect page serving
  }
}
