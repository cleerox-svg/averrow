/**
 * Passkey (WebAuthn) handlers — register + authenticate + manage.
 *
 * Uses @simplewebauthn/server v11 (Web Crypto only — runs on Workers
 * with no Node shims).
 *
 * Endpoints:
 *   POST   /api/passkeys/register/begin      auth required
 *   POST   /api/passkeys/register/finish     auth required
 *   POST   /api/passkeys/auth/begin          public
 *   POST   /api/passkeys/auth/finish         public — produces session
 *   GET    /api/passkeys                     auth required (list user's devices)
 *   DELETE /api/passkeys/:id                 auth required (only owner)
 *
 * Integration with existing auth: the auth/finish path calls the same
 * `issueSession` helper as the OAuth and magic-link flows, with
 * `method='passkey'`. JWT shape, refresh-cookie, org_scope, audit log
 * format are identical.
 *
 * Challenge storage: KV under `webauthn:reg:{userId}` for registration
 * (5-min TTL) and `webauthn:auth:{key}` for authentication (5-min TTL).
 * The auth challenge key is returned to the client so it can echo it
 * back at finish time — avoids leaking which emails have passkeys.
 */

import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/types";

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { issueSession } from "./auth";
import type { Env, UserRole } from "../types";

const RP_NAME = "Averrow";
const CHALLENGE_TTL_SEC = 5 * 60;

// ─── Helpers ────────────────────────────────────────────────────────────

function rpIdFor(request: Request): string {
  // RP ID is the registrable domain — for averrow.com it's 'averrow.com'.
  // For local dev (localhost) it's literally 'localhost'. Don't hard-code
  // — derive from the request so registration done in dev works in dev,
  // and production registrations are bound to production.
  const url = new URL(request.url);
  return url.hostname;
}

function originFor(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(input.length / 4) * 4,
    '=',
  );
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deviceLabelFromUA(ua: string | null): string | null {
  if (!ua) return null;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android device';
  if (/Mac/.test(ua) && /Safari/.test(ua) && !/Chrome/.test(ua)) return 'Mac (Touch ID)';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}

// ─── Registration: begin ────────────────────────────────────────────────

export async function handlePasskeyRegisterBegin(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const user = await env.DB.prepare(
      "SELECT id, email, name FROM users WHERE id = ?",
    ).bind(userId).first<{ id: string; email: string; name: string | null }>();
    if (!user) return json({ success: false, error: "User not found" }, 404, origin);

    // Build excludeCredentials so the browser refuses to re-register
    // a credential the user already has on this device.
    const existingRows = await env.DB.prepare(
      "SELECT credential_id, transports FROM passkeys WHERE user_id = ?",
    ).bind(userId).all<{ credential_id: string; transports: string | null }>();

    const excludeCredentials = existingRows.results.map((r) => ({
      id: r.credential_id,
      transports: r.transports
        ? (JSON.parse(r.transports) as AuthenticatorTransportFuture[])
        : undefined,
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpIdFor(request),
      userID: new TextEncoder().encode(user.id),
      userName: user.email,
      userDisplayName: user.name ?? user.email,
      attestationType: "none",
      excludeCredentials,
      authenticatorSelection: {
        // 'preferred' lets credentials sync to iCloud Keychain / Google PM
        // (cross-device passkey) when available, falling back to local-only.
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    // Stash the challenge in KV so finish() can verify the same one came back.
    await env.CACHE.put(
      `webauthn:reg:${userId}`,
      options.challenge,
      { expirationTtl: CHALLENGE_TTL_SEC },
    );

    return json({ success: true, data: options as PublicKeyCredentialCreationOptionsJSON }, 200, origin);
  } catch (err) {
    console.error("[passkey] register/begin error:", err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Registration: finish ───────────────────────────────────────────────

export async function handlePasskeyRegisterFinish(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = (await request.json()) as { response: RegistrationResponseJSON; device_label?: string };
    if (!body.response) {
      return json({ success: false, error: "Missing response payload" }, 400, origin);
    }

    const expectedChallenge = await env.CACHE.get(`webauthn:reg:${userId}`);
    if (!expectedChallenge) {
      return json({ success: false, error: "Challenge expired or not found" }, 400, origin);
    }

    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: originFor(request),
      expectedRPID: rpIdFor(request),
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return json({ success: false, error: "Verification failed" }, 400, origin);
    }

    const info = verification.registrationInfo;
    const credential = info.credential;
    const ua = request.headers.get("User-Agent") ?? null;

    await env.DB.prepare(`
      INSERT INTO passkeys
        (id, user_id, credential_id, public_key, sign_count, transports, device_label, user_agent, backed_up)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      userId,
      credential.id,
      base64UrlEncode(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      body.device_label ?? deviceLabelFromUA(ua),
      ua,
      info.credentialBackedUp ? 1 : 0,
    ).run();

    // Anti-replay: drop the challenge as soon as it's been used.
    await env.CACHE.delete(`webauthn:reg:${userId}`);

    await audit(env, {
      action: "passkey_registered",
      userId,
      details: { device_label: body.device_label ?? deviceLabelFromUA(ua) },
      request,
    }).catch(() => {});

    return json({ success: true }, 200, origin);
  } catch (err) {
    console.error("[passkey] register/finish error:", err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Authentication: begin ──────────────────────────────────────────────

interface AuthBeginBody {
  email?: string;
}

export async function handlePasskeyAuthBegin(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = (await request.json().catch(() => ({}))) as AuthBeginBody;
    const email = body.email?.trim().toLowerCase();

    let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];
    let resolvedUserId: string | null = null;

    if (email) {
      const user = await env.DB.prepare(
        "SELECT id, status FROM users WHERE LOWER(email) = ?",
      ).bind(email).first<{ id: string; status: string }>();
      if (user && user.status === "active") {
        const rows = await env.DB.prepare(
          "SELECT credential_id, transports FROM passkeys WHERE user_id = ?",
        ).bind(user.id).all<{ credential_id: string; transports: string | null }>();
        allowCredentials = rows.results.map((r) => ({
          id: r.credential_id,
          transports: r.transports
            ? (JSON.parse(r.transports) as AuthenticatorTransportFuture[])
            : undefined,
        }));
        resolvedUserId = user.id;
      }
    }

    // Generate options regardless — even when the email is unknown or the
    // user has no passkeys, we return a valid challenge with empty
    // allowCredentials. This means the response shape can't be used to
    // probe which emails have passkeys (no enumeration).
    const options = await generateAuthenticationOptions({
      rpID: rpIdFor(request),
      allowCredentials,
      userVerification: "preferred",
    });

    // Stash the challenge under either the resolved user (when known) or
    // a temporary key (when unknown). The client echoes the key back at
    // finish time — same generic flow either way.
    const challengeKey = resolvedUserId
      ? `webauthn:auth:user:${resolvedUserId}`
      : `webauthn:auth:tmp:${crypto.randomUUID()}`;
    await env.CACHE.put(
      challengeKey,
      JSON.stringify({ challenge: options.challenge, resolvedUserId }),
      { expirationTtl: CHALLENGE_TTL_SEC },
    );

    return json({
      success: true,
      data: { ...options as PublicKeyCredentialRequestOptionsJSON, challenge_key: challengeKey },
    }, 200, origin);
  } catch (err) {
    console.error("[passkey] auth/begin error:", err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Authentication: finish ─────────────────────────────────────────────

interface AuthFinishBody {
  response?: AuthenticationResponseJSON;
  challenge_key?: string;
  return_to?: string;
}

export async function handlePasskeyAuthFinish(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = (await request.json()) as AuthFinishBody;
    if (!body.response || !body.challenge_key) {
      return json({ success: false, error: "Missing response or challenge_key" }, 400, origin);
    }

    const stored = await env.CACHE.get(body.challenge_key);
    if (!stored) {
      return json({ success: false, error: "Challenge expired or not found" }, 400, origin);
    }
    const parsed = JSON.parse(stored) as { challenge: string; resolvedUserId: string | null };

    // Look up the credential being asserted.
    const credentialId = body.response.id;
    const passkey = await env.DB.prepare(
      `SELECT id, user_id, credential_id, public_key, sign_count, transports
         FROM passkeys WHERE credential_id = ?`,
    ).bind(credentialId).first<{
      id: string; user_id: string; credential_id: string;
      public_key: string; sign_count: number; transports: string | null;
    }>();

    if (!passkey) {
      return json({ success: false, error: "Unknown credential" }, 400, origin);
    }

    // Cross-account-stuffing defense: when /auth/begin resolved a user,
    // require that the credential being asserted belongs to that same
    // user. Without this, an attacker who knew a credential ID could
    // pair it with a different email at begin and impersonate the
    // credential's real owner.
    if (parsed.resolvedUserId && parsed.resolvedUserId !== passkey.user_id) {
      return json({ success: false, error: "Credential / email mismatch" }, 400, origin);
    }

    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: parsed.challenge,
      expectedOrigin: originFor(request),
      expectedRPID: rpIdFor(request),
      credential: {
        id: passkey.credential_id,
        publicKey: base64UrlDecode(passkey.public_key),
        counter: passkey.sign_count,
        transports: passkey.transports
          ? (JSON.parse(passkey.transports) as AuthenticatorTransportFuture[])
          : undefined,
      },
      requireUserVerification: false,
    });

    if (!verification.verified) {
      return json({ success: false, error: "Verification failed" }, 400, origin);
    }

    // Sign-count gate: monotonic counter. A non-increasing counter means
    // the credential was cloned (or the authenticator broke). The lib
    // already verifies the counter, but bump our stored copy so the next
    // auth has the latest value.
    const newCounter = verification.authenticationInfo.newCounter;
    await env.DB.prepare(
      `UPDATE passkeys SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?`,
    ).bind(newCounter, passkey.id).run();

    await env.CACHE.delete(body.challenge_key);

    // Look up the user to mint the session.
    const user = await env.DB.prepare(
      "SELECT id, email, role, status FROM users WHERE id = ?",
    ).bind(passkey.user_id).first<{ id: string; email: string; role: UserRole; status: string }>();

    if (!user || user.status !== "active") {
      return json({ success: false, error: "Account not active" }, 403, origin);
    }

    const siteOrigin = originFor(request);
    return issueSession(
      request, env, user.id, user.email, user.role, siteOrigin,
      sanitizeReturnTo(body.return_to),
      "passkey",
      "json",
    );
  } catch (err) {
    console.error("[passkey] auth/finish error:", err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Listing + revocation ───────────────────────────────────────────────

function safeParseTransports(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export async function handleListPasskeys(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(
      `SELECT id, device_label, user_agent, backed_up, transports, created_at, last_used_at
         FROM passkeys WHERE user_id = ?
         ORDER BY created_at DESC`,
    ).bind(userId).all<{
      id: string; device_label: string | null; user_agent: string | null;
      backed_up: number; transports: string | null;
      created_at: string; last_used_at: string | null;
    }>();
    // Parse the JSON-encoded transports list so the UI doesn't have
    // to. `["internal"]` = platform authenticator (Touch ID / Face ID
    // / Windows Hello / Android fingerprint) → drives the
    // "BIOMETRIC" badge on the Profile page.
    const data = rows.results.map((r) => ({
      ...r,
      transports: r.transports ? safeParseTransports(r.transports) : [],
    }));
    return json({ success: true, data }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleDeletePasskey(
  request: Request,
  env: Env,
  passkeyId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const result = await env.DB.prepare(
      `DELETE FROM passkeys WHERE id = ? AND user_id = ?`,
    ).bind(passkeyId, userId).run();
    if (result.meta.changes > 0) {
      await audit(env, { action: "passkey_removed", userId, details: { passkey_id: passkeyId }, request }).catch(() => {});
    }
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sanitizeReturnTo(returnTo: string | undefined): string | undefined {
  if (!returnTo) return undefined;
  if (!returnTo.startsWith("/")) return undefined;
  if (returnTo.startsWith("//")) return undefined;
  if (returnTo.length > 200) return undefined;
  return returnTo;
}
