/**
 * Constant-time secret comparison for Bearer-style and bare-token
 * Authorization checks (PR-BQ, post-Glasswing static review).
 *
 * Why this exists:
 *   The default JS `===` / `!==` operator on strings short-circuits
 *   at the first mismatching byte. For attacker-controlled input that
 *   is compared against a server-side secret, this leaks the length
 *   of the matching prefix via timing. Cloudflare's network jitter
 *   dominates in practice, but the canonical defense is so cheap
 *   that there's no reason not to apply it — particularly to the
 *   highest-value secret in the codebase (AVERROW_INTERNAL_SECRET
 *   unlocks every `/api/internal/*` endpoint and is referenced from
 *   15+ call sites in index.ts).
 *
 * Why a per-byte XOR loop rather than crypto.subtle.timingSafeEqual:
 *   `crypto.subtle` has no string-aware constant-time compare. The
 *   stdlib does have `crypto.timingSafeEqual` (Node) but it's not
 *   available in the Workers runtime. A hand-rolled XOR loop is the
 *   standard pattern for this on Workers — it compiles to a tight
 *   inner loop that does NOT short-circuit, so the work done per
 *   call is O(len) regardless of where the first mismatching byte
 *   sits.
 *
 * Length check first:
 *   The length check itself is timing-distinguishable, but lengths
 *   of server-side secrets are not the secret bytes. The token is
 *   server-generated and lives in Worker secrets — length leak is
 *   information-equivalent to "is this the right format".
 */

/**
 * Constant-time string comparison.
 *
 * @returns `true` when `a` and `b` are byte-identical, otherwise
 *          `false`. Length mismatch is detected before the byte loop;
 *          equal-length comparison runs all bytes regardless of where
 *          the first mismatch occurs.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Constant-time check of an `Authorization: Bearer <secret>` header.
 *
 * Verifies the header is exactly `"Bearer "` followed by the secret.
 * Returns `false` for null/undefined headers, missing prefix, or
 * any byte mismatch in the secret portion.
 *
 * Accepts the secret as `string | undefined` so callers can pass the
 * env binding directly without a null check — an unset secret always
 * returns `false`.
 */
export function timingSafeBearerEq(
  authHeader: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  if (!authHeader) return false;
  const expected = `Bearer ${secret}`;
  return timingSafeEqual(authHeader, expected);
}
