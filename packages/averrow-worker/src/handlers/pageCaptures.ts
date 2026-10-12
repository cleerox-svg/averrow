// Averrow — Phishing page capture routes
// (docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md, lib/page-capture.ts).
//
//   GET  /api/intel/captures/:id/screenshot?variant=desktop|mobile   (requireStaff)
//   GET  /api/intel/captures/:id/html                                (requireStaff)
//   POST /api/intel/identity-threats/detections/:threatId/capture    (edit_alerts)
//   POST /api/internal/captures/backfill?days=7&limit=200            (internal secret)
//
// Evidence is streamed from the PRIVATE R2 bucket through these staff
// routes only. The rendered HTML is attacker-controlled markup, so it is
// NEVER served as text/html: octet-stream attachment, `CSP: sandbox`,
// nosniff (middleware/security.ts preserves a handler's sandbox CSP).

import { corsHeaders, json } from "../lib/cors";
import { audit } from "../lib/audit";
import { getDbContext, getReadSession } from "../lib/db";
import { rateLimitCustom } from "../middleware/rateLimit";
import { IDP_FAMILY_TECHNIQUES } from "../lib/idp-impersonation";
import {
  CAPTURE_ID_PATTERN,
  captureTargetUrl,
  d1Ts,
  enqueueAutoCaptures,
  enqueueManualCapture,
} from "../lib/page-capture";
import type { AuthContext } from "../middleware/auth";
import type { Env } from "../types";

/** Same opaque-id shape the detection detail route accepts. */
const THREAT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MANUAL_CAPTURE_RATE = { key: "page_capture", maxRequests: 20, windowSeconds: 3600 } as const;
export const BACKFILL_DEFAULT_DAYS = 7;
export const BACKFILL_MAX_DAYS = 30;
export const BACKFILL_DEFAULT_LIMIT = 200;
export const BACKFILL_MAX_LIMIT = 500;

const FAMILY_PH = IDP_FAMILY_TECHNIQUES.map(() => "?").join(", ");

interface CaptureKeys {
  desktop_key: string | null;
  mobile_key: string | null;
  html_key: string | null;
}

async function loadKeys(env: Env, request: Request, id: string): Promise<CaptureKeys | null> {
  return getReadSession(env, getDbContext(request)).prepare(
    `SELECT desktop_key, mobile_key, html_key FROM page_captures WHERE id = ?`,
  ).bind(id).first<CaptureKeys>();
}

function notFound(origin: string | null): Response {
  return json({ success: false, error: "Capture not found" }, 404, origin);
}

function unavailable(origin: string | null): Response {
  return json({ success: false, error: "Page capture storage is not configured" }, 503, origin);
}

export async function handleCaptureScreenshot(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!CAPTURE_ID_PATTERN.test(id)) return notFound(origin);
  const variant = new URL(request.url).searchParams.get("variant") ?? "desktop";
  if (variant !== "desktop" && variant !== "mobile") {
    return json({ success: false, error: "variant must be desktop or mobile" }, 400, origin);
  }
  if (!env.PHISH_CAPTURES) return unavailable(origin);
  const row = await loadKeys(env, request, id);
  const key = row ? (variant === "desktop" ? row.desktop_key : row.mobile_key) : null;
  if (!key) return notFound(origin);
  const obj = await env.PHISH_CAPTURES.get(key);
  if (!obj) return notFound(origin);
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="capture-${id}-${variant}.png"`,
    },
  });
}

export async function handleCaptureHtml(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!CAPTURE_ID_PATTERN.test(id)) return notFound(origin);
  if (!env.PHISH_CAPTURES) return unavailable(origin);
  const row = await loadKeys(env, request, id);
  if (!row?.html_key) return notFound(origin);
  const obj = await env.PHISH_CAPTURES.get(row.html_key);
  if (!obj) return notFound(origin);
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      // Download only — never text/html (attacker-controlled markup).
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="capture-${id}.html.txt"`,
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

/** POST …/detections/:threatId/capture — caller already passed
 *  requirePermission('edit_alerts'). */
export async function handleRequestCapture(
  request: Request,
  env: Env,
  ctx: AuthContext,
  threatId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!THREAT_ID_PATTERN.test(threatId)) {
    return json({ success: false, error: "Detection not found" }, 404, origin);
  }
  const threat = await getReadSession(env, getDbContext(request)).prepare(
    `SELECT id, technique, malicious_url, malicious_domain FROM threats WHERE id = ?`,
  ).bind(threatId).first<{ id: string; technique: string | null; malicious_url: string | null; malicious_domain: string | null }>();
  // Same 404 contract as the detail route: IdP-family threats only.
  if (!threat || !threat.technique || !IDP_FAMILY_TECHNIQUES.includes(threat.technique)) {
    return json({ success: false, error: "Detection not found" }, 404, origin);
  }
  const target = captureTargetUrl(threat.malicious_url, threat.malicious_domain);
  if (!target) {
    return json({ success: false, error: "Detection has no capturable URL" }, 422, origin);
  }

  const limited = await rateLimitCustom(request, env, { ...MANUAL_CAPTURE_RATE }, ctx.userId);
  if (limited) return limited;

  const id = await enqueueManualCapture(env.DB, threatId, target, ctx.userId);
  if (!id) {
    return json({ success: false, error: "A capture is already queued or in progress" }, 409, origin);
  }
  await audit(env, {
    action: "page_capture_requested",
    userId: ctx.userId,
    resourceType: "threat",
    resourceId: threatId,
    details: { capture_id: id, target_url: target },
    request,
  });
  return json({ success: true, data: { id, status: "queued" as const } }, 202, origin);
}

/** POST /api/internal/captures/backfill — enqueue IdP-family threats from
 *  the last `days` (default 7, max 30), newest first, up to `limit`
 *  (default 200, max 500). Idempotent: a threat that has ever had a capture
 *  is skipped by the enqueue guard. Caller already checked the secret. */
export async function handleCaptureBackfill(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const url = new URL(request.url);
  const days = clampInt(url.searchParams.get("days"), BACKFILL_DEFAULT_DAYS, 1, BACKFILL_MAX_DAYS);
  const limit = clampInt(url.searchParams.get("limit"), BACKFILL_DEFAULT_LIMIT, 1, BACKFILL_MAX_LIMIT);
  if (days === null || limit === null) {
    return Response.json({ success: false, error: "days must be 1..30 and limit 1..500" }, { status: 400 });
  }
  const since = d1Ts(new Date(now.getTime() - days * 86_400_000));
  // Indexed range on idx_threats_technique_created (migration 0288).
  const res = await env.DB.prepare(
    `SELECT id, malicious_url, malicious_domain FROM threats
      WHERE technique IN (${FAMILY_PH}) AND created_at >= ?
        AND (malicious_url IS NOT NULL OR malicious_domain IS NOT NULL)
      ORDER BY created_at DESC
      LIMIT ?`,
  ).bind(...IDP_FAMILY_TECHNIQUES, since, limit).all<{ id: string; malicious_url: string | null; malicious_domain: string | null }>();
  const rows = res.results ?? [];
  const queued = await enqueueAutoCaptures(env.DB, rows.map((r) => ({
    threatId: r.id, maliciousUrl: r.malicious_url, maliciousDomain: r.malicious_domain,
  })), now);
  await audit(env, {
    action: "page_capture_backfill",
    userId: null,
    resourceType: "page_captures",
    details: { actor: "internal", days, limit, scanned: rows.length, queued },
    request,
  });
  return Response.json({ success: true, data: { days, scanned: rows.length, queued } });
}

function clampInt(raw: string | null, dflt: number, min: number, max: number): number | null {
  if (raw === null || raw === "") return dflt;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}
