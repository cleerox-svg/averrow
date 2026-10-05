// Averrow — per-user forced-logout gate (KV `forced_logout:<user_id>`).
//
// requireAuth (middleware/auth.ts) already reads this key once per
// authenticated request, so everything the gate needs lives in that ONE
// value — revoking a single device never costs a second KV read per request.
//
// Two value shapes are accepted:
//
//   legacy  "1759600000"                      — plain epoch seconds. Every
//           token / session with iat <= ts is rejected. Still written by the
//           admin force-logout, the admin role PATCH, invite acceptance and
//           refresh-token reuse detection.
//   v2      {"ts":1759600000|null,"sids":{"<session id>":<expires epoch>}}
//           `ts` keeps the legacy meaning. `sids` lists individually revoked
//           sessions: an access token whose `sid` claim is listed is rejected
//           regardless of iat. Written by the self-service session endpoints.
//
// A legacy writer overwriting a v2 value drops `sids`, which is safe: its new
// `ts` is "now" and every token of an already-revoked session was minted
// before that (a revoked session can no longer refresh), so the ts gate
// covers them.

import { ACCESS_TOKEN_TTL, ABSOLUTE_SESSION_TTL } from "./jwt";
import type { Env } from "../types";

export interface ForcedLogoutState {
  /** Tokens/sessions with iat <= ts are rejected. null = no blanket stamp. */
  ts: number | null;
  /** Revoked session ids → epoch seconds after which the entry can be pruned. */
  sids: Record<string, number>;
}

/**
 * How long a revoked sid must stay listed: the longest an access token minted
 * for that session can outlive the revocation (one access-token TTL), plus
 * margin for verifyJWT's 60s iat skew and a refresh racing the revoke.
 */
export const REVOKED_SID_RETENTION = ACCESS_TOKEN_TTL + 120;

/** Cloudflare KV rejects expirationTtl below 60 seconds. */
const KV_MIN_TTL = 60;

export function forcedLogoutKey(userId: string): string {
  return `forced_logout:${userId}`;
}

/**
 * Parse a stored value. Returns null for a missing key. A malformed value
 * yields an empty state — the same outcome as the pre-v2 reader, whose
 * `parseInt` produced NaN and never rejected (failing closed here would lock
 * the user out for up to 30 days on a write bug).
 */
export function parseForcedLogout(raw: string | null): ForcedLogoutState | null {
  if (raw === null || raw === "") return null;
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) return { ts: parseInt(trimmed, 10), sids: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ts: null, sids: {} };
    const obj = parsed as Record<string, unknown>;
    const ts = typeof obj.ts === "number" && Number.isFinite(obj.ts) ? Math.floor(obj.ts) : null;
    const sids: Record<string, number> = {};
    if (typeof obj.sids === "object" && obj.sids !== null && !Array.isArray(obj.sids)) {
      for (const [sid, exp] of Object.entries(obj.sids as Record<string, unknown>)) {
        if (typeof exp === "number" && Number.isFinite(exp)) sids[sid] = exp;
      }
    }
    return { ts, sids };
  } catch {
    return { ts: null, sids: {} };
  }
}

/**
 * True when a token (or session) with this iat / sid has been forced out.
 * A listed sid is rejected regardless of its recorded expiry: the expiry only
 * drives pruning on the next write.
 */
export function isForcedOut(state: ForcedLogoutState | null, iat: number, sid?: string | null): boolean {
  if (!state) return false;
  if (state.ts !== null && iat <= state.ts) return true;
  if (sid && Object.prototype.hasOwnProperty.call(state.sids, sid)) return true;
  return false;
}

/**
 * Read-modify-write the gate: optionally raise `ts` (never lowers an existing
 * one) and add revoked session ids. Expired sid entries are pruned. The KV
 * TTL covers both purposes — never shorter than the legacy writers' TTL for
 * `ts` (ABSOLUTE_SESSION_TTL from the stamp, which the refresh path needs),
 * and at least REVOKED_SID_RETENTION for fresh sids.
 *
 * Concurrent writers can race (KV has no CAS); that eventual-consistency
 * window is accepted platform-wide for this key.
 */
export async function writeForcedLogout(
  env: Env,
  userId: string,
  update: { ts?: number; revokeSids?: readonly string[] },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const key = forcedLogoutKey(userId);
  const current = parseForcedLogout(await env.CACHE.get(key)) ?? { ts: null, sids: {} };

  let ts = current.ts;
  if (update.ts !== undefined) ts = ts === null ? update.ts : Math.max(ts, update.ts);

  const sids: Record<string, number> = {};
  for (const [sid, exp] of Object.entries(current.sids)) {
    if (exp > now) sids[sid] = exp;
  }
  const sidExpiry = now + REVOKED_SID_RETENTION;
  for (const sid of update.revokeSids ?? []) {
    sids[sid] = Math.max(sids[sid] ?? 0, sidExpiry);
  }

  let ttl = KV_MIN_TTL;
  for (const exp of Object.values(sids)) ttl = Math.max(ttl, exp - now);
  if (ts !== null) ttl = Math.max(ttl, ts + ABSOLUTE_SESSION_TTL + 60 - now);

  const value: ForcedLogoutState = { ts, sids };
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
}
