// Google service-account → OAuth2 access token (JWT-bearer flow).
//
// The Web Risk Submission API (and other Google Cloud APIs) require an
// OAuth2 bearer token, not the simple API key the Safe Browsing Lookup API
// uses. This mints one from a service-account JSON credential:
//
//   1. Build a JWT asserting the SA identity + requested scope.
//   2. RS256-sign it with the SA private key (WebCrypto).
//   3. Exchange it at the token endpoint for a short-lived access token.
//   4. Cache the token in KV until shortly before it expires.
//
// The credential lives in the env.GOOGLE_SERVICE_ACCOUNT_JSON Worker secret
// (the raw service-account JSON Google hands you). Absent secret → null, so
// callers degrade gracefully (e.g. the Web Risk submitter falls back to the
// email channel rather than erroring).
//
// Reusable beyond takedowns — any future Google Cloud integration can call
// getGoogleAccessToken(env, scope).

import type { Env } from "../types";
import { logger } from "./logger";

interface ServiceAccount {
  client_email: string;
  private_key:  string;
  token_uri?:   string;
  project_id?:  string;
}

export interface GoogleToken {
  access_token: string;
  project_id:   string | null;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
// Refresh this many seconds before the real expiry so an in-flight call
// never races the boundary.
const EXPIRY_SKEW_SECONDS = 300;

function base64UrlFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

/** Decode a PEM PKCS#8 private key to the DER bytes WebCrypto wants. */
function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function parseServiceAccount(env: Env): ServiceAccount | null {
  const raw = (env as unknown as Record<string, string | undefined>).GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch {
    logger.warn("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    return null;
  }
}

/** True when a usable service-account credential is configured. */
export function hasServiceAccount(env: Env): boolean {
  return parseServiceAccount(env) !== null;
}

async function signJwt(sa: ServiceAccount, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri ?? DEFAULT_TOKEN_URI;
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss:   sa.client_email,
    scope,
    aud:   tokenUri,
    iat:   now,
    exp:   now + 3600,
  };
  const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlFromBytes(sig)}`;
}

function cacheKey(clientEmail: string, scope: string): string {
  return `gsa_token:${clientEmail}:${scope}`;
}

/**
 * Get a cached-or-freshly-minted Google OAuth2 access token for `scope`.
 * Returns null when no service-account credential is configured or the token
 * exchange fails (caller degrades gracefully). Never throws.
 */
export async function getGoogleAccessToken(
  env:   Env,
  scope: string,
): Promise<GoogleToken | null> {
  const sa = parseServiceAccount(env);
  if (!sa) return null;

  const key = cacheKey(sa.client_email, scope);
  try {
    const cached = await env.CACHE.get(key);
    if (cached) {
      return { access_token: cached, project_id: sa.project_id ?? null };
    }
  } catch {
    /* cache miss / unavailable — mint fresh below */
  }

  try {
    const assertion = await signJwt(sa, scope);
    const res = await fetch(sa.token_uri ?? DEFAULT_TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("google SA token exchange failed", { status: res.status, body: body.slice(0, 200) });
      return null;
    }
    const json = await res.json<{ access_token?: string; expires_in?: number }>();
    if (!json.access_token) return null;

    const ttl = Math.max((json.expires_in ?? 3600) - EXPIRY_SKEW_SECONDS, 60);
    await env.CACHE.put(key, json.access_token, { expirationTtl: ttl }).catch(() => {});
    return { access_token: json.access_token, project_id: sa.project_id ?? null };
  } catch (err) {
    logger.warn("google SA token mint error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
