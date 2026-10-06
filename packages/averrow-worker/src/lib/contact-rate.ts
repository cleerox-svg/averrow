// Atomic counters for the public contact form (POST /api/contact).
//
// Both the per-IP submission limit (handlers/contact.ts) and the daily staff
// email cap (lib/contact-notify.ts) count here. Each bump is ONE D1 statement
// — INSERT ... ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n — so two
// concurrent submissions always see different values. The KV counters this
// replaced did read → check → write, which raced, and KV's ~1 write/sec/key
// limit made the second submission in a second fail closed and lose its email.
//
// Keys are window-scoped (a key is never reused once its window ends), so an
// expired row is dead weight, not stale state. Navigator's hour-0 block
// deletes expired rows in bounded batches (purgeExpiredContactRate).
//
// Privacy (G38): the per-IP key never holds the IP. It holds an HMAC of the
// IP (IPv6: its /64) and the window, keyed off JWT_SECRET with a fixed label,
// so a row can't be reversed to an address or linked across windows.

import type { Env } from "../types";

export const CONTACT_RATE_INCREMENT_SQL = `INSERT INTO contact_rate (key, n, expires_at) VALUES (?, 1, ?)
  ON CONFLICT(key) DO UPDATE SET n = n + 1
  RETURNING n`;

/** Give back one count (failed send, failed insert). Never below zero. */
export const CONTACT_RATE_REFUND_SQL = `UPDATE contact_rate SET n = n - 1 WHERE key = ? AND n > 0`;

export const CONTACT_RATE_PURGE_SQL = `DELETE FROM contact_rate WHERE key IN (
  SELECT key FROM contact_rate WHERE expires_at < datetime('now') LIMIT ?
)`;

export const CONTACT_RATE_PURGE_BATCH = 500;
export const CONTACT_RATE_PURGE_MAX_BATCHES = 5;

/** `YYYY-MM-DD HH:MM:SS` UTC — the format SQLite's datetime() emits. */
export function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Atomically add one to `key` and return the new count. Throws on a D1 error. */
export async function incrementContactRate(
  db: D1Database,
  key: string,
  expiresAtMs: number,
): Promise<number> {
  const row = await db
    .prepare(CONTACT_RATE_INCREMENT_SQL)
    .bind(key, sqliteUtc(expiresAtMs))
    .first<{ n: number }>();
  if (!row || typeof row.n !== "number") throw new Error("contact_rate increment returned no row");
  return row.n;
}

/** Atomically subtract one from `key` (floored at 0). Throws on a D1 error. */
export async function refundContactRate(db: D1Database, key: string): Promise<void> {
  await db.prepare(CONTACT_RATE_REFUND_SQL).bind(key).run();
}

/**
 * The part of the address the per-IP limit keys on: an IPv4 address as-is,
 * an IPv6 address reduced to its /64 (one subscriber usually holds a whole
 * /64, so keying the full address would let them rotate past the limit).
 * Anything unparseable keys as itself, lowercased.
 */
export function contactRateIpPrefix(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(":")) return raw;
  const addr = raw.split("%")[0] ?? raw; // drop a zone id
  const halves = addr.split("::");
  if (halves.length > 2) return raw;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two groups; it sits in the
  // low 64 bits either way, so only its group count matters here.
  const groupCount = (gs: string[]) => gs.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const missing = 8 - groupCount(head) - groupCount(tail);
  if (halves.length === 1 && missing !== 0) return raw;
  if (halves.length === 2 && missing < 1) return raw;
  const groups = [...head, ...Array<string>(Math.max(0, missing)).fill("0"), ...tail];
  const first4 = groups.slice(0, 4);
  if (first4.length < 4 || first4.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return raw;
  return `${first4.map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * contact_rate key for the per-IP limit in the fixed window that contains
 * `nowMs`. The IP is hashed (see the file header); the window index stays in
 * clear so the key is unique per window.
 */
export async function contactIpRateKey(
  env: Pick<Env, "JWT_SECRET">,
  ip: string,
  windowSeconds: number,
  nowMs = Date.now(),
): Promise<{ key: string; expiresAtMs: number }> {
  const windowIndex = Math.floor(nowMs / (windowSeconds * 1000));
  // Domain-separated key derived from JWT_SECRET: the stored digest says
  // nothing about the JWT key, and a digest from one window can't be matched
  // against another.
  const derived = await hmacHex(env.JWT_SECRET || "contact-rate", "averrow:contact-rate:ip:v1");
  const digest = (await hmacHex(derived, `${contactRateIpPrefix(ip)}|${windowIndex}`)).slice(0, 32);
  return {
    key: `contact:ip:${digest}:${windowIndex}`,
    expiresAtMs: (windowIndex + 1) * windowSeconds * 1000,
  };
}

export interface ContactRatePurgeResult {
  deleted: number;
  batches: number;
  more_remaining: boolean;
  error: string | null;
}

/**
 * Delete expired contact_rate rows in bounded batches. Runs from Navigator's
 * hour-0 block; when nothing is due it is one indexed read. Never throws.
 */
export async function purgeExpiredContactRate(
  env: Pick<Env, "DB">,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<ContactRatePurgeResult> {
  const batchSize = opts.batchSize ?? CONTACT_RATE_PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? CONTACT_RATE_PURGE_MAX_BATCHES;
  const result: ContactRatePurgeResult = { deleted: 0, batches: 0, more_remaining: false, error: null };
  try {
    let drained = false;
    while (!drained && result.batches < maxBatches) {
      const r = await env.DB.prepare(CONTACT_RATE_PURGE_SQL).bind(batchSize).run();
      const changes = r.meta?.changes ?? 0;
      result.batches++;
      result.deleted += changes;
      drained = changes < batchSize;
    }
    result.more_remaining = !drained;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
