/**
 * POST /api/track — public, unauthenticated marketing analytics beacon.
 *
 * Fired by the marketing site's client JS on page view and CTA/click
 * events. Responds 204 immediately and performs the D1 insert via
 * ctx.waitUntil so the beacon never blocks the page. Referrer is
 * classified SERVER-SIDE (defense in depth — the client-supplied `ref`
 * is only a hint) and the request User-Agent is classified too. Raw IP
 * is never stored; visitor_hash matches the edge logger's scheme.
 */
import type { Env } from "../types";
import { json } from "../lib/cors";
import { classifyReferrer, classifyUserAgent } from "../lib/ai-traffic";
import { computeVisitorHash } from "../lib/marketing-event-logger";

const VALID_TYPES = new Set(["pageview", "click", "cta"]);
const RATE_LIMIT_CAP = 120;
const RATE_LIMIT_TTL = 3600;

interface TrackBody {
  type?: unknown;
  page?: unknown;
  ref?: unknown;
  ctaId?: unknown;
}

export async function handleTrackEvent(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ success: false, error: "Expected application/json" }, 400, origin);
  }

  let body: TrackBody;
  try {
    body = (await request.json()) as TrackBody;
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  const type = body.type;
  if (typeof type !== "string" || !VALID_TYPES.has(type)) {
    return json({ success: false, error: "Invalid event type" }, 400, origin);
  }

  const page = body.page;
  if (typeof page !== "string" || !page.startsWith("/") || page.length > 255) {
    return json({ success: false, error: "Invalid page" }, 400, origin);
  }

  let ctaId: string | null = null;
  if (body.ctaId !== undefined && body.ctaId !== null) {
    if (typeof body.ctaId !== "string" || body.ctaId.length > 64) {
      return json({ success: false, error: "Invalid ctaId" }, 400, origin);
    }
    ctaId = body.ctaId;
  }

  const ref = typeof body.ref === "string" ? body.ref : null;

  // Rate limit — shared per-IP KV bucket. Over-limit → silent 204.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimitKey = `pub_track_${ip}`;
  const currentCount = parseInt((await env.CACHE.get(rateLimitKey)) || "0", 10);
  if (currentCount >= RATE_LIMIT_CAP) {
    return new Response(null, { status: 204 });
  }
  await env.CACHE.put(rateLimitKey, String(currentCount + 1), { expirationTtl: RATE_LIMIT_TTL });

  const refClass = classifyReferrer(ref);
  const ua = request.headers.get("User-Agent") || "";
  const uaClass = classifyUserAgent(ua);

  ctx.waitUntil(
    (async () => {
      try {
        const visitorHash = await computeVisitorHash(ip === "unknown" ? "" : ip, ua);
        await env.DB.prepare(
          `INSERT INTO marketing_events
             (event_type, source, page, cta_id, visitor_hash, user_agent, referer,
              country, city, asn, is_bot, is_ai_crawler, crawler_name,
              is_ai_referral, ai_source)
           VALUES (?, 'beacon', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          type,
          page,
          ctaId,
          visitorHash,
          ua,
          ref,
          null,
          null,
          null,
          uaClass.isBot ? 1 : 0,
          uaClass.isAiCrawler ? 1 : 0,
          uaClass.crawlerName,
          refClass.isAiReferral ? 1 : 0,
          refClass.aiSource,
        ).run();
      } catch {
        // Swallow — analytics must never surface an error to the client.
      }
    })(),
  );

  return new Response(null, { status: 204 });
}
