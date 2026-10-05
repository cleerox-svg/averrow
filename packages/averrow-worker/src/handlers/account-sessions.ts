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
// concurrent-refresh window). Access tokens also carry the session id as the
// `sid` claim; the cookie wins, the claim is the fallback when it is absent.
//
// Revocation reaches live ACCESS tokens too, not only refresh: revoked session
// ids are added to the per-user `forced_logout:<user_id>` KV value that
// requireAuth already reads on every request (lib/forced-logout.ts — no extra
// KV read per request).
//
// Read-only identities (the `auditor` seat, incl. the MCP service account, and
// the shared UI-preview presets) may list sessions but never mutate them: they
// would stamp forced_logout on an identity other token holders share.

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { hashToken } from "../lib/hash";
import { writeForcedLogout } from "../lib/forced-logout";
import { isReadOnlyGlobalRole } from "../middleware/auth";
import { UI_PREVIEW_USER_IDS } from "./auth";
import type { Env, UserRole } from "../types";

/** The verified caller, from the auth context — never from the request. */
export interface SessionCaller {
  userId: string;
  role: UserRole;
  /** The access token's `sid` claim, if any. */
  sessionId?: string | null;
}

interface OwnSessionRow {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  issued_at: string;
  rotated_at: string | null;
  auth_method: string | null;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/i;

function maskIpv4(ip: string): string | null {
  const m = IPV4_RE.exec(ip);
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null;
  return `${m[1]}.${m[2]}.${m[3]}.•••`;
}

/**
 * Mask the host part of an IP so a full address never leaves the worker.
 *   IPv4                 203.0.113.42        → 203.0.113.•••
 *   IPv6 (any spelling)  2001:db8:1:2::9     → 2001:db8:1:••••
 *                        2001::1             → 2001:0:0:••••
 *                        ::1                 → 0:0:0:••••
 *   IPv4-embedded IPv6   ::ffff:1.2.3.4      → ::ffff:1.2.3.•••
 * IPv6 keeps only the first three groups of the EXPANDED address (a /48), so
 * a compressed short form like `2001::1` can't pass through whole.
 * Anything unparseable → null.
 * Mirrored in packages/shared/src/account/security/sessions.ts.
 */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const addr = (ip.trim().split("%")[0] ?? "").toLowerCase();
  if (!addr.includes(":")) return maskIpv4(addr);

  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    // IPv4-mapped / -embedded: the prefix identifies no host; mask the v4 part.
    const v4 = maskIpv4(tail);
    return v4 ? `${addr.slice(0, lastColon + 1)}${v4}` : null;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): string[] | null => {
    if (!part) return [];
    const groups = part.split(":");
    return groups.every((g) => HEX_GROUP_RE.test(g)) ? groups : null;
  };
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  if (!head || !rest) return null;
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const prefix = groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}:••••`;
}

/** 403 for identities that must not mutate sessions (see header). */
function refuseReadOnlySessionMutation(caller: SessionCaller, origin: string | null): Response | null {
  if (isReadOnlyGlobalRole(caller.role) || UI_PREVIEW_USER_IDS.includes(caller.userId)) {
    return json({ success: false, error: "Read-only sessions can't sign devices out" }, 403, origin);
  }
  return null;
}

/**
 * Reject live access tokens for revoked sessions (and optionally raise the
 * blanket stamp). A KV failure is audited and reported as
 * `revocation_pending` rather than failing a committed revoke: the refresh
 * side is already dead and the access tokens lapse within their TTL.
 */
async function revokeAccessTokens(
  request: Request, env: Env, userId: string, update: { ts?: number; revokeSids: string[] },
): Promise<boolean> {
  if (update.ts === undefined && update.revokeSids.length === 0) return true;
  try {
    await writeForcedLogout(env, userId, update);
    return true;
  } catch (err) {
    await audit(env, {
      action: "session_revocation_kv_failed", userId, resourceType: "user", resourceId: userId,
      details: { sessions: update.revokeSids.length, error: err instanceof Error ? err.message : String(err) },
      outcome: "failure", request,
    });
    return false;
  }
}

function readRefreshCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key === "radar_refresh") return rest.join("=") || null;
  }
  return null;
}

/** Id of the caller's live session (from the refresh cookie), or null.
 *  Mutating handlers fall back to the access token's `sid` claim. */
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
  request: Request, env: Env, caller: SessionCaller, sessionId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const refused = refuseReadOnlySessionMutation(caller, origin);
  if (refused) return refused;
  const { userId } = caller;
  try {
    const currentId = (await findCurrentSessionId(request, env, userId)) ?? caller.sessionId ?? null;
    if (currentId && currentId === sessionId) {
      return json({ success: false, error: "Use sign out to end this device's session." }, 400, origin);
    }
    const res = await env.DB.prepare(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    ).bind(sessionId, userId).run();
    if (!res.meta.changes) {
      return json({ success: false, error: "Session not found" }, 404, origin);
    }
    const kvOk = await revokeAccessTokens(request, env, userId, { revokeSids: [sessionId] });
    await audit(env, { action: "session_revoke", userId, resourceType: "session", resourceId: sessionId, request });
    // A KNOWN current session is refused above, so a successful revoke never
    // hit it: false. When neither the cookie nor the token's sid identified
    // the current session we can't tell: null — the client should re-check
    // (e.g. attempt a refresh) and sign out locally if that fails.
    return json({
      success: true,
      data: {
        revoked: 1,
        revoked_current: currentId ? false : null,
        ...(kvOk ? {} : { revocation_pending: true }),
      },
    }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/auth/sessions/revoke-others ──────────────────────

export async function handleRevokeOtherSessions(request: Request, env: Env, caller: SessionCaller): Promise<Response> {
  const origin = request.headers.get("Origin");
  const refused = refuseReadOnlySessionMutation(caller, origin);
  if (refused) return refused;
  const { userId } = caller;
  try {
    const currentId = (await findCurrentSessionId(request, env, userId)) ?? caller.sessionId ?? null;
    if (!currentId) {
      // Without a known current session we could not keep this device signed in.
      return json({ success: false, error: "Couldn't identify this device's session. Sign in again and retry." }, 409, origin);
    }
    const res = await env.DB.prepare(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id != ? AND revoked_at IS NULL RETURNING id",
    ).bind(userId, currentId).all<{ id: string }>();
    const revokedIds = (res.results ?? []).map((r) => String(r.id));
    const kvOk = await revokeAccessTokens(request, env, userId, { revokeSids: revokedIds });
    await audit(env, {
      action: "session_revoke_others", userId, resourceType: "user", resourceId: userId,
      details: { revoked: revokedIds.length }, request,
    });
    return json({
      success: true,
      data: { revoked: revokedIds.length, ...(kvOk ? {} : { revocation_pending: true }) },
    }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/auth/logout-all ──────────────────────────────────
// Ends every session including this one: revokes all refresh sessions and
// stamps the forced-logout gate, then clears the refresh cookie.
//
// The stamp is backdated one second (same convention as invite acceptance in
// handlers/auth.ts): the gate rejects iat <= ts, so stamping `now` would also
// reject a fresh sign-in completed within the same second. Every revoked
// session's id (plus the caller's token sid) is listed as well, so a
// session-bound token minted in that same second is still rejected; the
// residual is a sid-less token minted in that second, for one access TTL.

export async function handleLogoutEverywhere(request: Request, env: Env, caller: SessionCaller): Promise<Response> {
  const origin = request.headers.get("Origin");
  const refused = refuseReadOnlySessionMutation(caller, origin);
  if (refused) return refused;
  const { userId } = caller;
  try {
    const res = await env.DB.prepare(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL RETURNING id",
    ).bind(userId).all<{ id: string }>();
    const revokedIds = (res.results ?? []).map((r) => String(r.id));
    const sids = caller.sessionId && !revokedIds.includes(caller.sessionId)
      ? [...revokedIds, caller.sessionId]
      : revokedIds;
    const kvOk = await revokeAccessTokens(request, env, userId, {
      ts: Math.floor(Date.now() / 1000) - 1,
      revokeSids: sids,
    });
    await audit(env, {
      action: "logout_everywhere", userId, resourceType: "user", resourceId: userId,
      details: { revoked: revokedIds.length }, request,
    });
    const response = json({
      success: true,
      data: { revoked: revokedIds.length, ...(kvOk ? {} : { revocation_pending: true }) },
    }, 200, origin);
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", "radar_refresh=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
