/**
 * Magic-link token primitives — generation, hashing, rate-limit, validate.
 *
 * Used by `handlers/auth.ts` for the email-based passwordless sign-in path.
 * Mirrors the existing invite-token pattern (SHA-256 hash storage; raw
 * token only travels in the email body) so a DB breach can't be turned
 * into session minting.
 */

import type { Env } from '../types';

const TOKEN_BYTES = 32;          // 256 bits — same as session refresh tokens
const EXPIRY_MINUTES = 30;       // short enough to limit replay risk, long enough for slow inboxes
const RATE_LIMIT_PER_EMAIL = 3;  // requests
const RATE_LIMIT_WINDOW_SEC = 15 * 60;

// ─── Token generation + hashing ─────────────────────────────────────────

export function generateMagicLinkToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  // base64url so it's safe in URLs and fits a one-line email button.
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashMagicLinkToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Rate limiting (KV-backed) ──────────────────────────────────────────

/** Returns null if allowed, or the seconds-until-allowed if rate-limited. */
export async function checkRateLimit(env: Env, email: string): Promise<number | null> {
  const key = `magiclink:rl:${email.toLowerCase()}`;
  const raw = await env.CACHE.get(key);
  const now = Math.floor(Date.now() / 1000);
  let timestamps: number[] = raw ? JSON.parse(raw) : [];
  timestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_SEC);
  if (timestamps.length >= RATE_LIMIT_PER_EMAIL) {
    const oldest = timestamps[0]!;
    return RATE_LIMIT_WINDOW_SEC - (now - oldest);
  }
  timestamps.push(now);
  await env.CACHE.put(key, JSON.stringify(timestamps), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
  return null;
}

// ─── DB row creation + lookup ───────────────────────────────────────────

export interface CreateMagicLinkRow {
  email: string;
  tokenHash: string;
  ip: string | null;
  userAgent: string | null;
  returnTo: string | null;
}

export async function persistMagicLinkRow(env: Env, row: CreateMagicLinkRow): Promise<{ id: string; expiresAt: string }> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO magic_link_tokens (id, email, token_hash, expires_at, ip_address, user_agent, return_to)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, row.email, row.tokenHash, expiresAt, row.ip, row.userAgent, row.returnTo).run();
  return { id, expiresAt };
}

export interface MagicLinkLookup {
  id: string;
  email: string;
  expires_at: string;
  used_at: string | null;
  return_to: string | null;
}

/** Look up a token by its hash. Returns null on miss. Also enforces expiry +
 *  single-use semantics — a token marked used or past its expiry is treated
 *  as not-found from the caller's perspective. */
export async function findMagicLinkByHash(env: Env, tokenHash: string): Promise<MagicLinkLookup | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, expires_at, used_at, return_to
       FROM magic_link_tokens WHERE token_hash = ?`,
  ).bind(tokenHash).first<MagicLinkLookup>();
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** Mark a token as used. Idempotent — calling twice is a no-op. */
export async function markMagicLinkUsed(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE magic_link_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`,
  ).bind(id).run();
}

// ─── Constants exported for the email template + handler messaging ─────

export const MAGIC_LINK_EXPIRY_MINUTES = EXPIRY_MINUTES;
