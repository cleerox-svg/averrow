const encoder = new TextEncoder();

// NOTE: hashPassword / verifyPassword (unsalted SHA-256) were removed
// in the 2026-06-10 security audit (finding C4). They had no call
// sites — auth is OAuth/JWT-based. Never reintroduce unsalted
// password hashing here; if password auth is ever needed, use a
// memory-hard KDF (e.g. scrypt/argon2) behind a dedicated module.

export async function hashApiKey(key: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (
    "lrx_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Generate a 48-byte (384-bit) cryptographically secure invite token.
 * Returns URL-safe base64 string.
 */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * SHA-256 hash a raw token string. Returns hex-encoded hash.
 * Used for invite tokens and refresh tokens — only the hash is stored.
 */
export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a cryptographically secure refresh token (32 bytes, hex-encoded).
 */
export function generateRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
