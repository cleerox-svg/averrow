import type { JWTPayload } from "../types";

const encoder = new TextEncoder();

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * 30-minute access token.
 *
 * H-1 (AUTH_AUDIT_2026-06): shortened from 12h. Access tokens are
 * memory-only in the SPA and silently refreshed via the HttpOnly
 * `radar_refresh` cookie on 401 / reload, so a short TTL is invisible
 * to users but sharply bounds the exposure window of a token leaked
 * via XSS or the `#token=` redirect hash. Best practice is 15–60 min
 * for SPA bearer tokens.
 */
export const ACCESS_TOKEN_TTL = 60 * 30;
/** 7-day refresh token */
export const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 7;
/** 30-day absolute session limit */
export const ABSOLUTE_SESSION_TTL = 60 * 60 * 24 * 30;

export async function signJWT(
  payload: Omit<JWTPayload, "iat" | "exp">,
  secret: string,
  expiresInSeconds = ACCESS_TOKEN_TTL
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JWTPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const header = b64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })).buffer as ArrayBuffer);
  const body = b64url(encoder.encode(JSON.stringify(fullPayload)).buffer as ArrayBuffer);
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`));

  return `${header}.${body}.${b64url(sig)}`;
}

export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  // PR-BP: hardened — explicitly locks alg to HS256 + handles malformed
  // input via try/catch + rejects future-dated iat (limits replay window
  // if the signing secret leaks). All failures return null so callers
  // can treat verifyJWT as a single boolean gate.
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, body, sig] = parts as [string, string, string];

    // Lock the algorithm. Without this check, a future change that
    // accepts asymmetric tokens (e.g. RS256) would let attackers craft
    // HS256 tokens signed with the public key — alg-confusion attack.
    // Also rejects "alg: none" explicitly.
    const headerJson = JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/"))) as {
      alg?: string;
      typ?: string;
    };
    if (headerJson.alg !== "HS256") return null;
    if (headerJson.typ !== "JWT") return null;

    const key = await getKey(secret);

    const sigBuf = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBuf,
      encoder.encode(`${header}.${body}`)
    );
    if (!valid) return null;

    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as JWTPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    // Reject future-dated iat (60s clock-skew tolerance). Without this
    // check, a leaked secret could mint a token with `iat: 99999999999`
    // that forever bypasses the forced_logout `iat <= forcedAt` gate.
    if (typeof payload.iat === "number" && payload.iat > now + 60) return null;

    return payload;
  } catch {
    // Any decode/parse failure (malformed base64, invalid UTF-8, bad
    // JSON) lands here — treat as verification failure rather than
    // surfacing a 500 to the caller.
    return null;
  }
}
