// Averrow — self-service session management (Account → Security page).
//
// Distinct from handlers/sessions.ts, which is the ADMIN view (every user's
// session rows, force-logout of an arbitrary user). These handlers are scoped
// to the CALLER's own sessions only: every query carries `user_id = ?` from
// the verified auth context, never from the request.
//
// The caller's own session is identified by the HttpOnly `radar_refresh`
// cookie (Path=/api/auth, so it reaches /api/auth/sessions*): its hash matches
// `sessions.refresh_token_hash` (or `previous_token_hash` inside the
// concurrent-refresh window). Access tokens carry no session id.

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { hashToken } from "../lib/hash";
import { ABSOLUTE_SESSION_TTL } from "../lib/jwt";
import type { Env } from "../types";

interface OwnSessionRow {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  issued_at: string;
  rotated_at: string | null;
  auth_method: string | null;
}

/** Mask the host part of an IP: 203.0.113.42 → 203.0.113.•••, 2001:db8:1:2::9 → 2001:db8:1:••••. */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(":")) {
    return `${ip.split(":").slice(0, 3).join(":")}:••••`;
  }
  const octets = ip.split(".");
  if (octets.length !== 4) return null;
  return `${octets.slice(0, 3).join(".")}.•••`;
}

function readRefreshCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key === "radar_refresh") return rest.join("=") || null;
  }
  return null;
}

/** Id of the caller's live session (from the refresh cookie), or null. */
export async function findCurrentSessionId(request: Request, env: Env, userId: string): Promise<string | null> {
  const token = readRefreshCookie(request);
  if (!token) return null;
  const hash = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT id FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
        AND (refresh_token_hash = ? OR previous_token_hash = ?)
      LIMIT 1`,
  ).bind(userId, hash, hash).first<{ id: string }>();
  return row?.id ?? null;
}

// ─── GET /api/auth/sessions ─────────────────────────────────────

export async function handleListOwnSessions(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const currentId = await findCurrentSessionId(request, env, userId);
    const { results } = await env.DB.prepare(
      `SELECT id, ip_address, user_agent, issued_at, rotated_at, auth_method
         FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
        ORDER BY COALESCE(rotated_at, issued_at) DESC
        LIMIT 50`,
    ).bind(userId).all<OwnSessionRow>();

    const sessions = results.map((s) => ({
      id: s.id,
      // Masked server-side: the full address never leaves the worker.
      ip_masked: maskIp(s.ip_address),
      user_agent: s.user_agent,
      issued_at: s.issued_at,
      // The refresh token rotates every access-token refresh, so this is the
      // last time the device was seen.
      last_active_at: s.rotated_at ?? s.issued_at,
      auth_method: s.auth_method,
      is_current: s.id === currentId,
    }));
    return json({ success: true, data: { total: sessions.length, current_known: currentId !== null, sessions } }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── DELETE /api/auth/sessions/:id ──────────────────────────────

export async function handleRevokeOwnSession(
  request: Request, env: Env, userId: string, sessionId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const currentId = await findCurrentSessionId(request, env, userId);
    if (currentId && currentId === sessionId) {
      return json({ success: false, error: "Use sign out to end this device's session." }, 400, origin);
    }
    const res = await env.DB.prepare(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    ).bind(sessionId, userId).run();
    if (!res.meta.changes) {
      return json({ success: false, error: "Session not found" }, 404, origin);
    }
    await audit(env, { action: "session_revoke", userId, resourceType: "session", resourceId: sessionId, request });
    return json({ success: true, data: { revoked: 1 } }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/auth/sessions/revoke-others ──────────────────────

export async function handleRevokeOtherSessions(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const currentId = await findCurrentSessionId(request, env, userId);
    if (!currentId) {
      // Without a known current session we could not keep this device signed in.
      return json({ success: false, error: "Couldn't identify this device's session. Sign in again and retry." }, 409, origin);
    }
    const res = await env.DB.prepare(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id != ? AND revoked_at IS NULL",
    ).bind(userId, currentId).run();
    await audit(env, {
      action: "session_revoke_others", userId, resourceType: "user", resourceId: userId,
      details: { revoked: res.meta.changes ?? 0 }, request,
    });
    return json({ success: true, data: { revoked: res.meta.changes ?? 0 } }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/auth/logout-all ──────────────────────────────────
// Ends every session including this one: revokes all refresh sessions and
// stamps the forced-logout gate (access tokens issued before now are
// rejected), then clears the refresh cookie.

export async function handleLogoutEverywhere(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    await env.CACHE.put(`forced_logout:${userId}`, String(Math.floor(Date.now() / 1000)), {
      expirationTtl: ABSOLUTE_SESSION_TTL,
    });
    const res = await env.DB.prepare(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
    ).bind(userId).run();
    await audit(env, {
      action: "logout_everywhere", userId, resourceType: "user", resourceId: userId,
      details: { revoked: res.meta.changes ?? 0 }, request,
    });
    const response = json({ success: true, data: { revoked: res.meta.changes ?? 0 } }, 200, origin);
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", "radar_refresh=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
