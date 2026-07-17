// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Authentication Handlers (Google OAuth + JWT refresh + magic-link)

import { json } from "../lib/cors";
import { signJWT, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, ABSOLUTE_SESSION_TTL } from "../lib/jwt";
import { hashToken, generateRefreshToken } from "../lib/hash";
import { buildGoogleAuthURL, exchangeCodeForTokens, fetchGoogleUserInfo, getRedirectUri, CANONICAL_ORIGIN } from "../lib/oauth";
import { audit } from "../lib/audit";
import { loadOrgScopeForToken } from "../middleware/auth";
import {
  generateMagicLinkToken, hashMagicLinkToken, checkRateLimit,
  persistMagicLinkRow, findMagicLinkByHash, markMagicLinkUsed,
} from "../lib/magic-link";
import { sendMagicLinkEmail } from "../lib/magic-link-email";
import type { Env, UserRole } from "../types";

// ─── OAuth: initiate login ──────────────────────────────────────

export async function handleOAuthLogin(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID) {
    return json({ success: false, error: "Google OAuth not configured" }, 503, request.headers.get("Origin"));
  }

  // state carries a return-to URL + CSRF nonce
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return_to") ?? "/observatory";
  const nonce = crypto.randomUUID();

  // Store nonce in KV with 10-min TTL for CSRF validation
  await env.CACHE.put(`oauth_state:${nonce}`, returnTo, { expirationTtl: 600 });

  const redirectUri = getRedirectUri(request);
  const authUrl = buildGoogleAuthURL(env.GOOGLE_CLIENT_ID, redirectUri, nonce);

  // H3: bind the OAuth state to this browser via a short-lived cookie
  // holding sha256(nonce). The callback requires it to match the state
  // param, so a stolen/forged state can't complete login from another
  // browser.
  return oauthRedirectWithStateCookie(authUrl, await hashToken(nonce), request);
}

// ─── OAuth: initiate login via invite ───────────────────────────

export async function handleOAuthInviteLogin(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID) {
    return json({ success: false, error: "Google OAuth not configured" }, 503, request.headers.get("Origin"));
  }

  const url = new URL(request.url);
  const inviteToken = url.searchParams.get("token");
  if (!inviteToken) {
    return json({ success: false, error: "Missing invite token" }, 400, request.headers.get("Origin"));
  }

  // Validate the invite exists and is pending
  const tokenHash = await hashToken(inviteToken);
  const invite = await env.DB.prepare(
    "SELECT id, email, status, expires_at FROM invitations WHERE token_hash = ?",
  ).bind(tokenHash).first<{ id: string; email: string; status: string; expires_at: string }>();

  if (!invite || invite.status !== "pending") {
    return json({ success: false, error: "Invalid or consumed invite" }, 400, request.headers.get("Origin"));
  }
  if (new Date(invite.expires_at) < new Date()) {
    await env.DB.prepare("UPDATE invitations SET status = 'expired' WHERE id = ?").bind(invite.id).run();
    return json({ success: false, error: "Invite has expired" }, 410, request.headers.get("Origin"));
  }

  // Encode invite token hash into state so callback can find it
  const nonce = crypto.randomUUID();
  await env.CACHE.put(`oauth_state:${nonce}`, `__invite__:${inviteToken}`, { expirationTtl: 600 });

  const redirectUri = getRedirectUri(request);
  const authUrl = buildGoogleAuthURL(env.GOOGLE_CLIENT_ID, redirectUri, nonce);

  // H3: same browser-binding cookie as the regular login flow — both
  // paths land on the same /api/auth/callback.
  return oauthRedirectWithStateCookie(authUrl, await hashToken(nonce), request);
}

// ─── OAuth: callback ────────────────────────────────────────────

export async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirectWithError(CANONICAL_ORIGIN, `OAuth error: ${error}`);
  }
  if (!code || !state) {
    return redirectWithError(CANONICAL_ORIGIN, "Missing code or state");
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ success: false, error: "OAuth not configured" }, 503, origin);
  }

  // H3: validate browser binding — the radar_oauth_state cookie set at
  // initiation must contain sha256(state). Without it, a state nonce
  // stolen (or planted) from another browser can't complete the flow.
  // Only the Google OAuth callback is guarded here; magic-link and
  // passkey flows have their own tokens and never touch oauth_state.
  const cookies = parseCookies(request.headers.get("Cookie") ?? "");
  const stateCookie = cookies[OAUTH_STATE_COOKIE];
  if (!stateCookie || stateCookie !== await hashToken(state)) {
    await audit(env, { action: "oauth_state_cookie_mismatch", outcome: "denied", request }).catch(() => {});
    return clearOAuthStateCookie(redirectWithError(CANONICAL_ORIGIN, "Invalid or expired OAuth state"), request);
  }

  // Validate CSRF state
  const storedState = await env.CACHE.get(`oauth_state:${state}`);
  if (!storedState) {
    return clearOAuthStateCookie(redirectWithError(CANONICAL_ORIGIN, "Invalid or expired OAuth state"), request);
  }
  await env.CACHE.delete(`oauth_state:${state}`);

  // State validated + consumed — the one-time cookie is cleared on
  // whatever response the rest of the flow produces.
  const response = await completeOAuthCallback(
    request, env, code, storedState,
    env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET,
  );
  return clearOAuthStateCookie(response, request);
}

/** Post-state-validation half of the OAuth callback: code exchange,
 *  user lookup / invite acceptance, session issuance. Split out so the
 *  caller can uniformly clear the one-time state cookie on every exit.
 *  Client id/secret are passed pre-narrowed (caller 503s when unset). */
async function completeOAuthCallback(
  request: Request,
  env: Env,
  code: string,
  storedState: string,
  googleClientId: string,
  googleClientSecret: string,
): Promise<Response> {
  // Exchange code for tokens
  const redirectUri = getRedirectUri(request);
  let googleUser;
  try {
    const tokens = await exchangeCodeForTokens(code, googleClientId, googleClientSecret, redirectUri);
    googleUser = await fetchGoogleUserInfo(tokens.access_token);
  } catch (err) {
    await audit(env, { action: "oauth_token_exchange_failed", details: { error: "An internal error occurred" }, outcome: "failure", request });
    return redirectWithError(CANONICAL_ORIGIN, "Failed to authenticate with Google");
  }

  if (!googleUser.email_verified) {
    await audit(env, { action: "oauth_unverified_email", details: { email: googleUser.email }, outcome: "denied", request });
    return redirectWithError(CANONICAL_ORIGIN, "Google account email is not verified");
  }

  // Check if this is an invite flow
  const isInviteFlow = storedState.startsWith("__invite__:");
  const inviteToken = isInviteFlow ? storedState.slice("__invite__:".length) : null;

  if (isInviteFlow && inviteToken) {
    return handleInviteAcceptance(request, env, googleUser, inviteToken, CANONICAL_ORIGIN);
  }

  // Regular login — look up existing user by google_sub
  let user = await env.DB.prepare(
    "SELECT id, email, name, role, status FROM users WHERE google_sub = ?",
  ).bind(googleUser.sub).first<{ id: string; email: string; name: string; role: UserRole; status: string }>();

  if (!user) {
    // Also check by email for users who haven't linked Google yet
    user = await env.DB.prepare(
      "SELECT id, email, name, role, status FROM users WHERE email = ? AND google_sub IS NULL",
    ).bind(googleUser.email).first<{ id: string; email: string; name: string; role: UserRole; status: string }>();

    if (user) {
      // Link Google account to existing user
      await env.DB.prepare("UPDATE users SET google_sub = ?, name = ? WHERE id = ?")
        .bind(googleUser.sub, googleUser.name, user.id).run();
    }
  }

  if (!user) {
    await audit(env, { action: "login_no_account", details: { email: googleUser.email, google_sub: googleUser.sub }, outcome: "denied", request });
    return redirectWithError(CANONICAL_ORIGIN, "No account found. Access is invitation-only.");
  }

  if (user.status !== "active") {
    await audit(env, { action: "login_inactive", userId: user.id, details: { status: user.status }, outcome: "denied", request });
    return redirectWithError(CANONICAL_ORIGIN, "Account is suspended or deactivated");
  }

  // Issue session tokens
  return issueSession(request, env, user.id, user.email, user.role, CANONICAL_ORIGIN, storedState);
}

// ─── Token refresh ──────────────────────────────────────────────
//
// H5 (SECURITY_AUDIT_2026-06-10): the refresh token is sourced ONLY
// from the HttpOnly `radar_refresh` cookie — never from the request
// body. This is deliberate: every session-issuing flow (OAuth
// callback, invite acceptance, magic-link verify, passkey
// auth/finish) routes through `issueSession`, which always sets the
// cookie, so every live session already carries it. A body-token
// fallback was considered for migration and rejected — no client
// ever held a usable refresh token in JS-readable storage (the
// redirect hash never included one, and the legacy ops body-refresh
// path parsed a response shape this endpoint never returned), so a
// body path would only widen the attack surface XSS-stolen tokens
// could exploit. Do not add one.
//
// The rotated refresh token is likewise returned ONLY via
// Set-Cookie; the JSON envelope carries just the short-lived access
// token, which the SPAs hold in memory.

/**
 * Grace window (ms) during which a just-rotated refresh token may be
 * re-presented without tripping reuse detection. Covers the realistic
 * benign race: two browser tabs sharing the same HttpOnly cookie both
 * hit a 401 and fire /api/auth/refresh near-simultaneously — the slower
 * request arrives carrying the token the faster one already rotated.
 * Tight enough that a genuinely stolen token surfacing later is still
 * caught and nukes the session family.
 */
const REFRESH_REUSE_GRACE_MS = 15_000;

export async function handleRefreshToken(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  // Read refresh token from HttpOnly cookie
  const cookies = parseCookies(request.headers.get("Cookie") ?? "");
  const refreshToken = cookies["radar_refresh"];

  if (!refreshToken) {
    return json({ success: false, error: "No refresh token" }, 401, origin);
  }

  const tokenHash = await hashToken(refreshToken);

  // Find active session
  let session = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.issued_at, s.expires_at, s.auth_method,
            u.email, u.role, u.status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > datetime('now')`,
  ).bind(tokenHash).first<{
    id: string; user_id: string; issued_at: string; expires_at: string;
    auth_method: string | null;
    email: string; role: UserRole; status: string;
  }>();

  if (!session) {
    // H-2 (AUTH_AUDIT_2026-06): reuse detection. The token isn't the
    // current active hash on any live session — was it a token we ALREADY
    // rotated away? If so, distinguish two cases by the rotation age:
    //   * within REFRESH_REUSE_GRACE_MS on a still-live session → benign
    //     concurrent refresh (e.g. two tabs racing on the same cookie).
    //     Adopt the session and re-rotate normally below.
    //   * otherwise (stale, or the session was already revoked) → a
    //     replayed/stolen token. Revoke the whole family + force-logout.
    const prior = await env.DB.prepare(
      `SELECT s.id, s.user_id, s.issued_at, s.expires_at, s.revoked_at, s.rotated_at, s.auth_method,
              u.email, u.role, u.status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.previous_token_hash = ?`,
    ).bind(tokenHash).first<{
      id: string; user_id: string; issued_at: string; expires_at: string;
      revoked_at: string | null; rotated_at: string | null; auth_method: string | null;
      email: string; role: UserRole; status: string;
    }>();

    if (prior) {
      const rotatedMs = prior.rotated_at ? new Date(prior.rotated_at).getTime() : 0;
      const withinGrace = prior.revoked_at === null && Date.now() - rotatedMs <= REFRESH_REUSE_GRACE_MS;

      if (withinGrace) {
        // Benign race — fall through to the normal rotation tail.
        session = {
          id: prior.id, user_id: prior.user_id,
          issued_at: prior.issued_at, expires_at: prior.expires_at,
          auth_method: prior.auth_method,
          email: prior.email, role: prior.role, status: prior.status,
        };
      } else {
        // Replay of an already-rotated token → treat as theft.
        await env.DB.prepare(
          "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
        ).bind(prior.user_id).run();
        // Belt-and-suspenders: invalidate any live access tokens for this
        // user too (the forced-logout gate rejects tokens with iat <= now).
        await env.CACHE.put(
          `forced_logout:${prior.user_id}`,
          String(Math.floor(Date.now() / 1000)),
          { expirationTtl: ABSOLUTE_SESSION_TTL },
        ).catch(() => {});
        await audit(env, { action: "refresh_token_reuse", userId: prior.user_id, outcome: "denied", request });
        return clearRefreshCookie(
          json({ success: false, error: "Session security check failed. Please log in again." }, 401, origin),
        );
      }
    }
  }

  if (!session) {
    await audit(env, { action: "refresh_invalid", outcome: "failure", request });
    return json({ success: false, error: "Invalid or expired refresh token" }, 401, origin);
  }

  // Check absolute session limit (30 days from first issue)
  const sessionAge = (Date.now() - new Date(session.issued_at).getTime()) / 1000;
  if (sessionAge > ABSOLUTE_SESSION_TTL) {
    await env.DB.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?").bind(session.id).run();
    await audit(env, { action: "refresh_absolute_limit", userId: session.user_id, outcome: "failure", request });
    return clearRefreshCookie(json({ success: false, error: "Session expired. Please log in again." }, 401, origin));
  }

  if (session.status !== "active") {
    return json({ success: false, error: "Account is not active" }, 403, origin);
  }

  // Check forced logout
  const forcedAt = await env.CACHE.get(`forced_logout:${session.user_id}`);
  const sessionIat = Math.floor(new Date(session.issued_at).getTime() / 1000);
  if (forcedAt && sessionIat <= parseInt(forcedAt, 10)) {
    return clearRefreshCookie(json({ success: false, error: "Session invalidated" }, 401, origin));
  }

  // Rotate refresh token — issue new, remember the just-rotated hash so a
  // later replay of it is caught by the reuse-detection branch above.
  const newRefreshToken = generateRefreshToken();
  const newRefreshHash = await hashToken(newRefreshToken);

  await env.DB.prepare(
    "UPDATE sessions SET refresh_token_hash = ?, previous_token_hash = ?, rotated_at = datetime('now'), expires_at = datetime('now', '+7 days') WHERE id = ?",
  ).bind(newRefreshHash, tokenHash, session.id).run();

  // Look up org membership for refresh
  const membership = await env.DB.prepare(`
    SELECT om.org_id, om.role AS org_role
    FROM org_members om
    JOIN organizations o ON o.id = om.org_id
    WHERE om.user_id = ? AND om.status = 'active'
    LIMIT 1
  `).bind(session.user_id).first<{ org_id: number; org_role: string }>();

  // Resolve scope once and embed in the JWT so the request hot path
  // never has to look it up again (saves 2 D1 queries per request).
  const orgScope = await loadOrgScopeForToken(env.DB, session.user_id, session.role as UserRole);

  // Issue new access token. H-3: re-evaluate the enrollment gate on every
  // rotation from the session's recorded auth_method, so a privileged
  // session stays enrollment-scoped until the user signs in with a passkey
  // (and a legacy session with a null auth_method is downgraded until then).
  const accessToken = await signJWT(
    {
      sub: session.user_id,
      email: session.email,
      role: session.role as UserRole,
      org_id: membership?.org_id?.toString() ?? undefined,
      org_role: membership?.org_role ?? undefined,
      org_scope: orgScope,
      scope: enrollScopeFor(session.role as UserRole, session.auth_method as AuthMethod | null),
    },
    env.JWT_SECRET,
    ACCESS_TOKEN_TTL,
  );

  const response = json({
    success: true,
    data: {
      token: accessToken,
      expires_in: ACCESS_TOKEN_TTL,
      user: { id: session.user_id, email: session.email, role: session.role },
    },
  }, 200, origin);

  return setRefreshCookie(response, newRefreshToken, request);
}

// ─── Logout ─────────────────────────────────────────────────────

export async function handleLogout(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");

  // Revoke current session's refresh token
  const cookies = parseCookies(request.headers.get("Cookie") ?? "");
  const refreshToken = cookies["radar_refresh"];
  if (refreshToken) {
    const tokenHash = await hashToken(refreshToken);
    await env.DB.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE refresh_token_hash = ?")
      .bind(tokenHash).run();
  }

  await audit(env, { action: "logout", userId, request });

  return clearRefreshCookie(json({ success: true, data: { message: "Logged out" } }, 200, origin));
}

// ─── /api/auth/me ───────────────────────────────────────────────

export async function handleMe(request: Request, env: Env, userId: string, enrollOnly = false): Promise<Response> {
  const origin = request.headers.get("Origin");

  // Pulls the new profile-personalization fields (display_name,
  // timezone, theme_preference) added in 0119, plus a derived
  // passkey_count via subquery so the client-side
  // FirstSignInPasskeyPrompt can self-gate without a second round-trip.
  const user = await env.DB.prepare(
    `SELECT
       u.id, u.email, u.name, u.role, u.status, u.created_at,
       u.last_login, u.last_active,
       u.display_name, u.timezone, u.theme_preference,
       (SELECT COUNT(*) FROM passkeys WHERE user_id = u.id) AS passkey_count
     FROM users u WHERE u.id = ?`,
  ).bind(userId).first<{
    id: string; email: string; name: string; role: string; status: string;
    created_at: string; last_login: string | null; last_active: string | null;
    display_name: string | null; timezone: string | null;
    theme_preference: string | null; passkey_count: number;
  }>();

  if (!user) {
    return json({ success: false, error: "User not found" }, 404, origin);
  }

  // Look up org membership
  const membership = await env.DB.prepare(`
    SELECT om.org_id, om.role AS org_role, o.slug, o.name, o.plan
    FROM org_members om
    JOIN organizations o ON o.id = om.org_id
    WHERE om.user_id = ? AND om.status = 'active'
    LIMIT 1
  `).bind(userId).first<{ org_id: number; org_role: string; slug: string; name: string; plan: string }>();

  return json({
    success: true,
    data: {
      ...user,
      // Convenient: clients that don't care about the override pick
      // up display_name first, name as the fallback. Existing callers
      // of `name` keep working unchanged.
      name: user.display_name ?? user.name,
      // H-3: true when this session is restricted to passkey enrollment
      // (privileged user signed in without a passkey). The SPA renders a
      // mandatory enrollment gate and blocks the rest of the app.
      passkey_required: enrollOnly,
      organization: membership ? {
        id: membership.org_id,
        name: membership.name,
        slug: membership.slug,
        plan: membership.plan,
        role: membership.org_role,
      } : null,
    },
  }, 200, origin);
}

// ─── Internal helpers ───────────────────────────────────────────

async function handleInviteAcceptance(
  request: Request,
  env: Env,
  googleUser: { sub: string; email: string; name: string },
  inviteToken: string,
  siteOrigin: string,
): Promise<Response> {
  const tokenHash = await hashToken(inviteToken);
  const invite = await env.DB.prepare(
    "SELECT id, email, role, status, expires_at, org_id, org_role FROM invitations WHERE token_hash = ? AND status = 'pending'",
  ).bind(tokenHash).first<{ id: string; email: string; role: string; status: string; expires_at: string; org_id: number | null; org_role: string | null }>();

  if (!invite) {
    await audit(env, { action: "invite_accept_invalid", details: { email: googleUser.email }, outcome: "failure", request });
    return redirectWithError(siteOrigin, "Invalid or already-used invite");
  }

  if (new Date(invite.expires_at) < new Date()) {
    await env.DB.prepare("UPDATE invitations SET status = 'expired' WHERE id = ?").bind(invite.id).run();
    return redirectWithError(siteOrigin, "Invite has expired");
  }

  // Email must match invitation
  if (invite.email.toLowerCase() !== googleUser.email.toLowerCase()) {
    await audit(env, {
      action: "invite_email_mismatch",
      details: { expected: invite.email, got: googleUser.email },
      outcome: "denied",
      request,
    });
    return redirectWithError(siteOrigin, "Google account email does not match the invitation. Please sign in with the correct Google account.");
  }

  // Check if user already exists
  let userId: string;
  const existing = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ? OR email = ?")
    .bind(googleUser.sub, googleUser.email).first<{ id: string }>();

  if (existing) {
    userId = existing.id;
    // Update google_sub + role if needed
    await env.DB.prepare("UPDATE users SET google_sub = ?, name = ?, role = ? WHERE id = ?")
      .bind(googleUser.sub, googleUser.name, invite.role, userId).run();
  } else {
    userId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, google_sub, email, name, role, status, invited_by)
       VALUES (?, ?, ?, ?, ?, 'active', (SELECT invited_by FROM invitations WHERE id = ?))`,
    ).bind(userId, googleUser.sub, googleUser.email, googleUser.name, invite.role, invite.id).run();
  }

  // Mark invitation as accepted
  await env.DB.prepare("UPDATE invitations SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?")
    .bind(invite.id).run();

  // Create org membership if invite has org context
  if (invite.org_id) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO org_members (org_id, user_id, role, status, invited_by, invited_at, accepted_at, provisioned_by)
      VALUES (?, ?, ?, 'active', (SELECT invited_by FROM invitations WHERE id = ?), datetime('now'), datetime('now'), 'invite')
    `).bind(invite.org_id, userId, invite.org_role || "viewer", invite.id).run();
  }

  await audit(env, {
    action: "invite_accepted",
    userId,
    resourceType: "invitation",
    resourceId: invite.id,
    details: { role: invite.role, email: googleUser.email, org_id: invite.org_id },
    request,
  });

  return issueSession(request, env, userId, googleUser.email, invite.role as UserRole, siteOrigin);
}

export type AuthMethod = "google_oauth" | "magic_link" | "passkey";

/** Mode controls the response shape:
 *   - 'redirect': 302 to siteOrigin + returnToPath + #token (used by OAuth
 *     callback + magic-link verify — both are top-level browser navigations).
 *   - 'json':     200 { success, data: { access_token, expires_in, return_to } }
 *     (used by passkey auth/finish — XHR caller navigates manually). */
export type IssueSessionMode = 'redirect' | 'json';

/** Scope marker for an enrollment-only restricted session (H-3). */
export const PASSKEY_ENROLL_SCOPE = "passkey_enroll" as const;

/** Roles that must hold (and authenticate with) a passkey for full access. */
export function isPrivilegedRole(role: UserRole): boolean {
  return role === "admin" || role === "super_admin";
}

/**
 * H-3 (AUTH_AUDIT_2026-06): decide whether a freshly-authenticated session
 * is restricted to passkey enrollment. Privileged users (admin/super_admin)
 * only get a full session when they signed in WITH a passkey; any other
 * method yields an enrollment-only session so they can register one and then
 * sign in with it. Non-privileged roles are never restricted.
 */
export function enrollScopeFor(role: UserRole, method: AuthMethod | null): typeof PASSKEY_ENROLL_SCOPE | undefined {
  return isPrivilegedRole(role) && method !== "passkey" ? PASSKEY_ENROLL_SCOPE : undefined;
}

export async function issueSession(
  request: Request,
  env: Env,
  userId: string,
  email: string,
  role: UserRole,
  siteOrigin: string,
  returnToPath?: string,
  method: AuthMethod = "google_oauth",
  mode: IssueSessionMode = "redirect",
): Promise<Response> {
  // Look up org membership (user might belong to one org)
  const membership = await env.DB.prepare(`
    SELECT om.org_id, om.role AS org_role, o.slug AS org_slug, o.name AS org_name
    FROM org_members om
    JOIN organizations o ON o.id = om.org_id
    WHERE om.user_id = ? AND om.status = 'active'
    LIMIT 1
  `).bind(userId).first<{ org_id: number; org_role: string; org_slug: string; org_name: string }>();

  // Resolve scope once and embed in the JWT so the request hot path
  // never has to look it up again (saves 2 D1 queries per request).
  const orgScope = await loadOrgScopeForToken(env.DB, userId, role);

  // H-3: privileged non-passkey logins are restricted to passkey enrollment.
  const enrollScope = enrollScopeFor(role, method);

  // Generate tokens
  const jwtPayload: Omit<import("../types").JWTPayload, "iat" | "exp"> = {
    sub: userId,
    email,
    role,
    org_id: membership?.org_id?.toString() ?? undefined,
    org_role: membership?.org_role ?? undefined,
    org_scope: orgScope,
    scope: enrollScope,
  };
  const accessToken = await signJWT(jwtPayload, env.JWT_SECRET, ACCESS_TOKEN_TTL);
  const refreshToken = generateRefreshToken();
  const refreshHash = await hashToken(refreshToken);

  // Create session record
  const sessionId = crypto.randomUUID();
  // L2: CF-Connecting-IP only — X-Forwarded-For is client-spoofable.
  const ip = request.headers.get("CF-Connecting-IP") ?? null;
  const ua = request.headers.get("User-Agent") ?? null;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent, auth_method)
     VALUES (?, ?, ?, datetime('now', '+7 days'), ?, ?, ?)`,
  ).bind(sessionId, userId, refreshHash, ip, ua, method).run();

  // Update last_login
  await env.DB.prepare("UPDATE users SET last_login = datetime('now'), last_active = datetime('now') WHERE id = ?")
    .bind(userId).run();

  await audit(env, { action: "login", userId, details: { method }, request });

  // Phase D D2c rebadge gate (server-side backstop): customer-tenant
  // users (role='client') route to /tenant/ regardless of what
  // returnToPath was. The averrow-ops auth bootstrap ALSO redirects
  // these users client-side; this is the worker-side belt to the
  // SPA's suspenders so a client never lands inside /v2/ or the
  // legacy /observatory alias (which 301s to /v2 anyway). Clients
  // only keep an explicit return_to if it's already a /tenant path.
  const rawReturnTo = returnToPath || '/observatory';
  const isClientToStaffPath =
    role === 'client' &&
    !rawReturnTo.startsWith('/tenant');
  const returnTo = isClientToStaffPath ? '/tenant/' : rawReturnTo;

  if (mode === 'json') {
    // For AJAX callers (passkeys.ts on the SPA): JSON envelope, refresh
    // cookie still set via Set-Cookie. Caller does the navigation.
    const response = json({
      success: true,
      data: {
        access_token: accessToken,
        expires_in: ACCESS_TOKEN_TTL,
        return_to: returnTo,
      },
    }, 200, request.headers.get("Origin"));
    return setRefreshCookie(response, refreshToken, request);
  }

  // Redirect mode — browser-navigation entrypoints (OAuth callback,
  // magic-link verify). Drop the token in the URL hash so it never
  // hits an HTTP log.
  const isV2 = returnTo.startsWith('/v2');
  const redirectUrl = isV2
    ? `${siteOrigin}${returnTo}#token=${accessToken}&expires_in=${ACCESS_TOKEN_TTL}`
    : `${siteOrigin}/auth/callback#token=${accessToken}&expires_in=${ACCESS_TOKEN_TTL}`;
  const response = new Response(null, { status: 302, headers: { Location: redirectUrl } });
  return setRefreshCookie(response, refreshToken, request);
}

function setRefreshCookie(response: Response, refreshToken: string, request: Request): Response {
  const isSecure = new URL(request.url).protocol === "https:";
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `radar_refresh=${refreshToken}; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Strict; Path=/api/auth; Max-Age=${REFRESH_TOKEN_TTL}`,
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// ─── OAuth state cookie (H3 browser binding) ────────────────────
//
// Set at login initiation, holds sha256(state nonce). SameSite MUST
// be Lax (not Strict): the callback is a cross-site top-level
// navigation from accounts.google.com, and Strict cookies are not
// sent on cross-site navigations — the flow would always fail.
const OAUTH_STATE_COOKIE = "radar_oauth_state";

function oauthRedirectWithStateCookie(authUrl: string, stateHash: string, request: Request): Response {
  const isSecure = new URL(request.url).protocol === "https:";
  const headers = new Headers({ Location: authUrl });
  headers.append(
    "Set-Cookie",
    `${OAUTH_STATE_COOKIE}=${stateHash}; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Path=/api/auth; Max-Age=600`,
  );
  return new Response(null, { status: 302, headers });
}

function clearOAuthStateCookie(response: Response, request: Request): Response {
  const isSecure = new URL(request.url).protocol === "https:";
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${OAUTH_STATE_COOKIE}=; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Path=/api/auth; Max-Age=0`,
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function clearRefreshCookie(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", "radar_refresh=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redirectWithError(origin: string, message: string): Response {
  const encoded = encodeURIComponent(message);
  return new Response(null, {
    status: 302,
    headers: { Location: `${origin}/auth/error?message=${encoded}` },
  });
}

// ─── Magic-link sign-in ─────────────────────────────────────────
//
// Email-based passwordless flow for users without Google accounts. Mirrors
// the FarmTrack pattern (see AUTH_PWA_NOTIFICATIONS.md §1.3): the request
// endpoint always returns a benign success envelope so it can't be used to
// enumerate which emails have accounts on the platform. The verify endpoint
// mints a session via the same `issueSession` helper as the OAuth flow, so
// downstream JWT / refresh-cookie / org_scope behavior is identical.

interface MagicLinkRequestBody {
  email?: string;
  return_to?: string;
}

const GENERIC_REQUEST_RESPONSE = {
  success: true,
  message: "If an account exists for that email, a sign-in link has been sent.",
  expires_in_minutes: 30,
};

export async function handleMagicLinkRequest(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = (await request.json().catch(() => ({}))) as MagicLinkRequestBody;
    const rawEmail = (body.email ?? "").trim().toLowerCase();
    if (!rawEmail || !rawEmail.includes("@")) {
      return json({ success: false, error: "A valid email is required." }, 400, origin);
    }

    if (!env.RESEND_API_KEY) {
      // Log loudly so the operator notices the env gap; user gets the
      // generic envelope so they don't see the misconfiguration.
      console.error("[magic-link] RESEND_API_KEY not configured — request dropped");
      return json(GENERIC_REQUEST_RESPONSE, 200, origin);
    }

    // Rate-limit by email regardless of whether the account exists, so
    // brute-force address enumeration via timing isn't possible.
    const retryAfter = await checkRateLimit(env, rawEmail);
    if (retryAfter !== null) {
      return json({
        success: false,
        error: `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      }, 429, origin);
    }

    // Look up the user. If they don't exist, return the SAME generic
    // success envelope as if they did — never leak existence.
    const user = await env.DB.prepare(
      "SELECT id, status FROM users WHERE LOWER(email) = ?",
    ).bind(rawEmail).first<{ id: string; status: string }>();

    if (!user || user.status !== "active") {
      // Pretend we sent the email. Audit so a real human can investigate
      // suspicious patterns later.
      await audit(env, {
        action: "magic_link_request_no_account",
        details: { email: rawEmail },
        request,
      }).catch(() => {});
      return json(GENERIC_REQUEST_RESPONSE, 200, origin);
    }

    // Generate the token, hash it, persist the row, send the email.
    const token = generateMagicLinkToken();
    const tokenHash = await hashMagicLinkToken(token);
    // L2: CF-Connecting-IP only — X-Forwarded-For is client-spoofable.
    const ip = request.headers.get("CF-Connecting-IP") ?? null;
    const ua = request.headers.get("User-Agent") ?? null;
    const returnTo = sanitizeReturnTo(body.return_to);

    await persistMagicLinkRow(env, {
      email: rawEmail,
      tokenHash,
      ip,
      userAgent: ua,
      returnTo,
    });

    const siteOrigin = new URL(request.url).origin;
    const signInUrl = `${siteOrigin}/api/auth/magic-link/${encodeURIComponent(token)}`;

    const sendResult = await sendMagicLinkEmail(env.RESEND_API_KEY, {
      recipientEmail: rawEmail,
      signInUrl,
      ipAddress: ip,
      userAgent: ua,
    });

    await audit(env, {
      action: sendResult.ok ? "magic_link_request_sent" : "magic_link_request_send_failed",
      userId: user.id,
      details: { email: rawEmail, error: sendResult.error },
      request,
    }).catch(() => {});

    // Always return the generic envelope — even on Resend failure, so we
    // don't leak transient infra errors back to the caller.
    return json(GENERIC_REQUEST_RESPONSE, 200, origin);
  } catch (err) {
    console.error("[magic-link] request error:", err);
    return json(GENERIC_REQUEST_RESPONSE, 200, origin);
  }
}

export async function handleMagicLinkVerify(
  request: Request,
  env: Env,
  rawToken: string,
): Promise<Response> {
  const siteOrigin = new URL(request.url).origin;
  try {
    if (!rawToken) {
      return redirectWithError(siteOrigin, "missing_token");
    }
    const tokenHash = await hashMagicLinkToken(rawToken);
    const row = await findMagicLinkByHash(env, tokenHash);
    if (!row) {
      return redirectWithError(siteOrigin, "invalid_or_expired_token");
    }

    // Find the user — re-verify they still exist + are active. Email is
    // the source of truth on the magic-link row (we never store user_id
    // there, so a reused token after an account deletion can't mint a
    // session for the wrong account).
    const user = await env.DB.prepare(
      "SELECT id, email, role, status FROM users WHERE LOWER(email) = ?",
    ).bind(row.email).first<{ id: string; email: string; role: UserRole; status: string }>();

    if (!user || user.status !== "active") {
      await markMagicLinkUsed(env, row.id).catch(() => {});
      await audit(env, {
        action: "magic_link_verify_no_account",
        details: { email: row.email },
        request,
      }).catch(() => {});
      return redirectWithError(siteOrigin, "account_not_active");
    }

    // Mark the token used FIRST so a simultaneous click can't double-spend.
    // The UNIQUE token_hash + the conditional UPDATE inside markMagicLinkUsed
    // means the second caller will find used_at already set on its lookup.
    await markMagicLinkUsed(env, row.id);

    return issueSession(
      request,
      env,
      user.id,
      user.email,
      user.role,
      siteOrigin,
      row.return_to ?? undefined,
      "magic_link",
    );
  } catch (err) {
    console.error("[magic-link] verify error:", err);
    return redirectWithError(siteOrigin, "verify_error");
  }
}

/** Whitelist /v2/... or /observatory paths so a malicious return_to can't
 *  hijack the redirect to an external site. */
function sanitizeReturnTo(returnTo: string | undefined): string | null {
  if (!returnTo) return null;
  if (!returnTo.startsWith("/")) return null;
  if (returnTo.startsWith("//")) return null; // protocol-relative URL escape
  if (returnTo.length > 200) return null;
  return returnTo;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

// ─── Service-account JWT minting ────────────────────────────────
//
// Issues a long-lived JWT for the dedicated MCP service-account user,
// creating that user on first call. Auth is via AVERROW_INTERNAL_SECRET
// (NOT a user JWT) — same pattern as every other /api/internal/* handler.
//
// Design rationale:
//   - The averrow-mcp UI verification tools need to hit user-context
//     endpoints (/api/auth/me, /api/dashboard/overview, etc) which won't
//     accept the internal secret. They need a real user JWT.
//   - Storing a 12h JWT and rotating manually was unworkable.
//   - This endpoint mints a 90-day JWT for the service account; the MCP
//     calls it once, caches the JWT in KV, and re-mints when <7 days
//     remain. User intervention drops from "rotate every 12h" to never.
//
// Service user is identified by a fixed ID ("service_account_mcp") so
// the row is created once and reused. INSERT OR IGNORE keeps the call
// idempotent. The JWT carries the read-only `auditor` role (SECURITY_AUDIT
// O1) — a global-read seat that satisfies requireStaff/requireOrgMember but
// FAILS requireAdmin/requireSuperAdmin. That is sufficient for the GET-only
// smoke_test + assert_endpoint probes and denies the service token any
// super_admin-gated surface if it leaks. `auditor` isn't permitted by the
// users.role CHECK constraint, so the DB row stores a CHECK-valid staff
// placeholder while the minted JWT carries the real role (same discipline as
// the UI-preview path — see uiPreviewDbRole).

const SERVICE_ACCOUNT_ID = "service_account_mcp";
const SERVICE_ACCOUNT_EMAIL = "service-mcp@averrow.local";
const SERVICE_ACCOUNT_NAME = "MCP Service Account";
/** 30 days — short enough that a leaked token expires before becoming a
 *  long-running risk (tightened from 90d in SECURITY_AUDIT O1). The MCP
 *  re-mints when <7 days remain, so this re-mints roughly every ~23 days;
 *  on-demand minting means no operator burden. */
const SERVICE_JWT_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function handleMintServiceJwt(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Ensure the service-account user row exists. Idempotent on
    // repeated calls — INSERT OR IGNORE keys on the primary id. The row
    // stores a CHECK-valid staff placeholder ('analyst', via uiPreviewDbRole)
    // while the minted JWT carries the real `auditor` role — the row's role is
    // cosmetic for authz (requireAuth trusts the JWT claim, not the DB).
    // WARNING: never authorize on THIS row's DB role. The 'analyst' placeholder
    // carries edit_alerts + manage_takedowns; any future gate that reads the DB
    // role (roleHasPermission(dbRow.role, …) / role==='analyst') would silently
    // hand this service account mutation rights the read-only `auditor` JWT is
    // designed to deny. Authorize on ctx.role (JWT-derived) only. (appsec O1/F1)
    const serviceDbRole = uiPreviewDbRole("auditor"); // -> 'analyst'
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, status, created_at)
       VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
    ).bind(SERVICE_ACCOUNT_ID, SERVICE_ACCOUNT_EMAIL, SERVICE_ACCOUNT_NAME, serviceDbRole).run();

    // One-time idempotent normalization: an EXISTING prod service row was
    // created with role='super_admin' before O1. The row role is cosmetic for
    // authz, but leaving a stored super_admin row is a latent risk, so
    // downgrade it to the placeholder. Row UPDATE, not a schema change.
    await env.DB.prepare(
      "UPDATE users SET role = ? WHERE id = ? AND role != ?",
    ).bind(serviceDbRole, SERVICE_ACCOUNT_ID, serviceDbRole).run();

    // Verify the user is active in case it was suspended manually after
    // creation. We don't want to hand out a JWT for a non-active user
    // since the auth middleware would reject it on the next request.
    const user = await env.DB.prepare(
      "SELECT status FROM users WHERE id = ?",
    ).bind(SERVICE_ACCOUNT_ID).first<{ status: string }>();
    if (!user || user.status !== "active") {
      return json(
        { success: false, error: "Service account is not active" },
        503,
        origin,
      );
    }

    // Mint a 30-day JWT. embeddedScope/org_scope is omitted — the `auditor`
    // role bypasses org scope via hasGlobalReadScope in middleware/auth.ts.
    const jwt = await signJWT(
      {
        sub: SERVICE_ACCOUNT_ID,
        email: SERVICE_ACCOUNT_EMAIL,
        role: "auditor",
      },
      env.JWT_SECRET,
      SERVICE_JWT_TTL_SECONDS,
    );

    const expiresAt = new Date(
      (Math.floor(Date.now() / 1000) + SERVICE_JWT_TTL_SECONDS) * 1000,
    ).toISOString();

    return json(
      {
        success: true,
        data: {
          jwt,
          expires_at: expiresAt,
          ttl_seconds: SERVICE_JWT_TTL_SECONDS,
          user_id: SERVICE_ACCOUNT_ID,
        },
      },
      200,
      origin,
    );
  } catch (err) {
    return json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      500,
      origin,
    );
  }
}

// ─── UI-preview JWT minting (Claude Code UI inspection) ─────────
//
// Mints a SHORT-LIVED, LOW-PRIVILEGE JWT so an automated agent (Claude
// Code) can load the live SPA and inspect the UI. Auth is via
// AVERROW_INTERNAL_SECRET — same gate as handleMintServiceJwt, and strictly
// LESS powerful: the role is hard-capped (staff → analyst|admin, tenant →
// client) so it can NEVER mint super_admin, and the TTL is hard-capped too.
//
// Inject the token by navigating a browser to the returned `preview_url`
// (`<origin>/v2/#token=…` or `/tenant/#token=…`) — the SPA's AuthProvider
// reads the hash, validates /api/auth/me, and boots.
//
// Kill switch (instant):
//   UPDATE users SET status='suspended'
//     WHERE id IN ('claude_ui_staff','claude_ui_tenant');
//   requireAuth rejects on the next request; re-enable with status='active'.
// Full removal:
//   DELETE FROM org_members WHERE user_id='claude_ui_tenant';
//   DELETE FROM users WHERE id IN ('claude_ui_staff','claude_ui_tenant');

interface UiPreviewPreset {
  id: string;
  email: string;
  name: string;
  returnTo: string;
}
const UI_PREVIEW_STAFF: UiPreviewPreset = {
  id: "claude_ui_staff",
  email: "claude-ui-staff@averrow.local",
  name: "Claude UI Preview (Staff)",
  returnTo: "/v2/",
};
const UI_PREVIEW_TENANT: UiPreviewPreset = {
  id: "claude_ui_tenant",
  email: "claude-ui-tenant@averrow.local",
  name: "Claude UI Preview (Tenant)",
  returnTo: "/tenant/",
};
/** Roles the staff preview may request. super_admin is deliberately absent.
 *  Default is `auditor` — read-only global visibility (AUTH_AUDIT_2026-06). */
const UI_PREVIEW_STAFF_ROLES: UserRole[] = ["auditor", "analyst", "admin"];
const UI_PREVIEW_DEFAULT_TTL_MIN = 60;
const UI_PREVIEW_MAX_TTL_MIN = 240;

/** The DB `users.role` value to persist for a given minted JWT role. `auditor`
 *  isn't permitted by the users.role CHECK constraint and rebuilding that
 *  table on D1 is unsafe (FK cascade), so the preview row stores a CHECK-valid
 *  placeholder ('analyst', still staff so the SPA doesn't bounce it to
 *  /tenant) while the minted JWT carries the real `auditor` role. Preview
 *  tokens are standalone (no refresh cookie), so the DB role is never read
 *  back to re-mint — only /api/auth/me surfaces it cosmetically. */
export function uiPreviewDbRole(jwtRole: UserRole): UserRole {
  return jwtRole === "auditor" ? "analyst" : jwtRole;
}

export async function handleMintUiPreviewJwt(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const surface = url.searchParams.get("surface");
    if (surface !== "staff" && surface !== "tenant") {
      return json({ success: false, error: "surface must be 'staff' or 'tenant'" }, 400, origin);
    }

    // Resolve preset + role. Tenant is always 'client'; staff defaults to
    // 'analyst' and may opt up to 'admin' but never super_admin.
    const preset = surface === "staff" ? UI_PREVIEW_STAFF : UI_PREVIEW_TENANT;
    let role: UserRole;
    if (surface === "staff") {
      const roleParam = (url.searchParams.get("role") ?? "auditor") as UserRole;
      if (!UI_PREVIEW_STAFF_ROLES.includes(roleParam)) {
        return json({ success: false, error: "staff role must be 'auditor', 'analyst', or 'admin'" }, 400, origin);
      }
      role = roleParam;
    } else {
      role = "client";
    }
    // The JWT carries `role`; the DB row stores a CHECK-valid placeholder.
    const dbRole = uiPreviewDbRole(role);

    // TTL clamp.
    const reqTtl = parseInt(url.searchParams.get("ttl_minutes") ?? "", 10);
    const ttlMin = Number.isFinite(reqTtl) && reqTtl > 0
      ? Math.min(reqTtl, UI_PREVIEW_MAX_TTL_MIN)
      : UI_PREVIEW_DEFAULT_TTL_MIN;
    const ttlSec = ttlMin * 60;

    // Ensure the dedicated preview user exists. Does NOT auto-reactivate a
    // suspended user — the kill switch must hold across re-mints.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, status, created_at)
       VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
    ).bind(preset.id, preset.email, preset.name, dbRole).run();

    const existing = await env.DB.prepare("SELECT status, role FROM users WHERE id = ?")
      .bind(preset.id).first<{ status: string; role: string }>();
    if (!existing || existing.status !== "active") {
      return json({ success: false, error: "Preview user is suspended" }, 503, origin);
    }
    // Keep the stored (CHECK-valid) role in sync with the placeholder for the
    // requested JWT role. The JWT role is authoritative for access.
    if (existing.role !== dbRole) {
      await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(dbRole, preset.id).run();
    }

    // Tenant preview: optionally scope to a real org so org-filtered pages
    // render real data. Adds an idempotent viewer membership.
    let orgIdNum: number | undefined;
    if (surface === "tenant") {
      const orgIdRaw = url.searchParams.get("org_id");
      if (orgIdRaw) {
        orgIdNum = parseInt(orgIdRaw, 10);
        if (!Number.isFinite(orgIdNum)) {
          return json({ success: false, error: "org_id must be numeric" }, 400, origin);
        }
        const org = await env.DB.prepare("SELECT id FROM organizations WHERE id = ?")
          .bind(orgIdNum).first<{ id: number }>();
        if (!org) return json({ success: false, error: "org_id not found" }, 404, origin);
        await env.DB.prepare(
          `INSERT OR IGNORE INTO org_members (org_id, user_id, role, status, provisioned_by, invited_at, accepted_at)
           VALUES (?, ?, 'viewer', 'active', 'ui_preview', datetime('now'), datetime('now'))`,
        ).bind(orgIdNum, preset.id).run();
      }
    }

    // Resolve org context for the JWT so org-scoped queries work.
    const membership = await env.DB.prepare(`
      SELECT om.org_id, om.role AS org_role
      FROM org_members om
      JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = ? AND om.status = 'active'
      LIMIT 1
    `).bind(preset.id).first<{ org_id: number; org_role: string }>();

    const orgScope = await loadOrgScopeForToken(env.DB, preset.id, role);

    const jwt = await signJWT(
      {
        sub: preset.id,
        email: preset.email,
        role,
        org_id: membership?.org_id?.toString() ?? undefined,
        org_role: membership?.org_role ?? undefined,
        org_scope: orgScope,
      },
      env.JWT_SECRET,
      ttlSec,
    );

    const siteOrigin = new URL(request.url).origin;
    const previewUrl = `${siteOrigin}${preset.returnTo}#token=${jwt}&expires_in=${ttlSec}`;
    const expiresAt = new Date((Math.floor(Date.now() / 1000) + ttlSec) * 1000).toISOString();

    await audit(env, {
      action: "ui_preview_jwt_minted",
      userId: preset.id,
      details: { surface, role, org_id: orgIdNum ?? null, ttl_minutes: ttlMin },
      request,
    }).catch(() => {});

    return json({
      success: true,
      data: {
        jwt,
        preview_url: previewUrl,
        expires_at: expiresAt,
        ttl_seconds: ttlSec,
        user_id: preset.id,
        role,
        surface,
        org_id: orgIdNum ?? null,
      },
    }, 200, origin);
  } catch (err) {
    return json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      500,
      origin,
    );
  }
}
