// Google Cloud Web Risk — Lookup API (uris.search) client with a monthly cap.
//
// Replaces the Safe Browsing v4 Lookup API (safebrowsing.googleapis.com),
// whose terms allow non-commercial use only. Averrow is a paid product, so
// every URL-reputation lookup goes through Web Risk instead. Callers:
//   - feeds/googleSafeBrowsing.ts — the `google_safe_browsing` enrichment feed
//   - lib/contact-link-scan.ts    — contact-form link scan (via
//                                   checkGoogleSafeBrowsing)
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │ NEVER call threatLists.computeDiff or hashes.search (the Update API)  │
// │ from this project. computeDiff is itself free, but once it is used in │
// │ the same GCP project Google bills uris.search at $50 per 1,000 calls  │
// │ instead of the Lookup API's free tier ($0 for 1–100,000 calls/month,  │
// │ then $0.50 per 1,000). Only uris.search is allowed here.              │
// └───────────────────────────────────────────────────────────────────────┘
//
// API: GET https://webrisk.googleapis.com/v1/uris:search
//        ?uri=<url-encoded>&threatTypes=MALWARE&threatTypes=SOCIAL_ENGINEERING
//        &threatTypes=UNWANTED_SOFTWARE
// One URI per call (no batching). Response `{}` = not listed, or
// `{ "threat": { "threatTypes": [...], "expireTime": "..." } }`.
// Auth: OAuth2 bearer from the shared service account
// (GOOGLE_SERVICE_ACCOUNT_JSON, lib/google-service-account.ts — the same
// credential the Web Risk takedown submitter uses). No service account →
// nothing is looked up and every URL comes back checked=false.
//
// Monthly cap (free tier guard): WEB_RISK_LOOKUP_MONTHLY_CAP_DEFAULT = 90,000
// uris.search calls per UTC calendar month, 10,000 below the free 100,000.
// Override with the WEB_RISK_LOOKUP_MONTHLY_CAP var (non-negative integer;
// 0 = no lookups). Every HTTP call to uris.search counts, whatever its
// outcome. Cache hits (`gsb:<url>`, 24h) never count.
//
// Counter design: one KV key per month, `web_risk_lookup:calls:<YYYY-MM>`,
// read-modify-written to RESERVE a block of calls (≤ LOOKUP_BLOCK_SIZE)
// before that block is sent; a reservation is never refunded, so a block
// cut short (deadline, auth error, 429) only over-counts. KV is eventually
// consistent and the read-modify-write is not atomic, so two isolates
// reserving at the same moment can under-count by up to one block each —
// with ~2 writers (the hourly feed and the contact form) that is far below
// the 10,000-call headroom. Fails CLOSED: no CACHE binding, a KV read that
// throws or returns a non-integer, or a KV write that throws → no calls.
//
// Expected volume (2026-11, from code): the feed runs in the hourly `:07`
// enrichment loop (feed_configs `*/30` interval, but the loop only runs once
// an hour) and checks ≤ 100 threats per run, de-duplicated by URL, minus
// cache hits → ≤ 24 × 100 = 2,400 calls/day ≈ 74,400 per 31-day month at
// the very most. The contact form sends ≤ CONTACT_NOTIFY_DAILY_CAP (50)
// notifications/day with ≤ MAX_SCANNED_LINKS (10) uncached links each →
// ≤ 500/day ≈ 15,500/month worst case (in practice a handful). Worst case
// combined ≈ 89,900 < 90,000; typical well under. If the cap is ever hit,
// the feed simply waits (rows stay gsb_checked = 0) until the next month.

import type { Env } from "../types";
import { getGoogleAccessToken } from "./google-service-account";
import { logger } from "./logger";

export const WEB_RISK_LOOKUP_MONTHLY_CAP_DEFAULT = 90_000;
/** Calls reserved from the monthly counter per KV round-trip. */
export const LOOKUP_BLOCK_SIZE = 25;
/** Parallel uris.search requests in flight (Google quota: 6,000/min/project). */
export const LOOKUP_CONCURRENCY = 4;
/** Per-request timeout. */
export const LOOKUP_CALL_TIMEOUT_MS = 10_000;

const ENDPOINT = "https://webrisk.googleapis.com/v1/uris:search";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const THREAT_TYPES = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"] as const;
/** Most severe first — the reported threatType when several are listed. */
const THREAT_PRIORITY: readonly string[] = THREAT_TYPES;
const COUNTER_TTL_S = 40 * 86_400;

export interface LookupVerdict {
  flagged: boolean;
  threatType: string | null;
  checked: boolean;
}

export interface LookupRunStats {
  /** uris.search HTTP calls made (each one counted against the cap). */
  calls: number;
  /** The monthly cap stopped the run (some URLs left unchecked). */
  capped: boolean;
  /** The counter could not be read/written; no further calls were made. */
  quotaUnavailable: boolean;
  /** No access token (no service account, or token exchange failed). */
  noToken: boolean;
  /** Calls that failed (HTTP error / network / bad body). */
  errors: number;
  /** URLs not attempted because the deadline passed. */
  deadlineSkipped: number;
}

/** Parse WEB_RISK_LOOKUP_MONTHLY_CAP (non-negative integer), else the default. */
export function webRiskLookupMonthlyCap(env: Env): number {
  const raw = env.WEB_RISK_LOOKUP_MONTHLY_CAP?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return WEB_RISK_LOOKUP_MONTHLY_CAP_DEFAULT;
}

export function lookupCounterKey(now: Date = new Date()): string {
  return `web_risk_lookup:calls:${now.toISOString().slice(0, 7)}`;
}

/** Calls used this month, or null when the counter is unreadable (fail closed). */
async function readUsed(env: Env, key: string): Promise<number | null> {
  if (!env.CACHE) return null;
  try {
    const raw = await env.CACHE.get(key);
    if (raw === null) return 0;
    return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Calls left this month: a number, or null when the counter is unreadable.
 * Read-only — use it to skip work up front; reserveLookups() is the gate.
 */
export async function webRiskLookupsRemaining(env: Env, now: Date = new Date()): Promise<number | null> {
  const cap = webRiskLookupMonthlyCap(env);
  if (cap === 0) return 0;
  const used = await readUsed(env, lookupCounterKey(now));
  return used === null ? null : Math.max(0, cap - used);
}

/**
 * Reserve up to `wanted` calls from this month's counter. Returns the number
 * granted (0 at the cap), or null when the counter can't be read or written
 * (fail closed: the caller makes no calls).
 */
export async function reserveLookups(env: Env, wanted: number, now: Date = new Date()): Promise<number | null> {
  if (wanted <= 0) return 0;
  const cap = webRiskLookupMonthlyCap(env);
  if (cap === 0) return 0;
  const key = lookupCounterKey(now);
  const used = await readUsed(env, key);
  if (used === null) return null;
  const grant = Math.min(wanted, Math.max(0, cap - used));
  if (grant === 0) return 0;
  try {
    await env.CACHE.put(key, String(used + grant), { expirationTtl: COUNTER_TTL_S });
  } catch {
    return null;
  }
  return grant;
}

interface SearchResponse {
  threat?: { threatTypes?: unknown; expireTime?: string };
}

/** Map a uris.search body to a verdict. Exported for tests. */
export function mapSearchResponse(body: unknown): LookupVerdict {
  const types = (body as SearchResponse | null)?.threat?.threatTypes;
  const list = Array.isArray(types) ? types.filter((t): t is string => typeof t === "string") : [];
  if (list.length === 0) return { flagged: false, threatType: null, checked: true };
  const ranked = [...list].sort((a, b) => rank(a) - rank(b));
  return { flagged: true, threatType: ranked[0] ?? null, checked: true };
}

function rank(t: string): number {
  const i = THREAT_PRIORITY.indexOf(t);
  return i === -1 ? THREAT_PRIORITY.length : i;
}

export function searchUrl(uri: string): string {
  const qs = new URLSearchParams({ uri });
  for (const t of THREAT_TYPES) qs.append("threatTypes", t);
  return `${ENDPOINT}?${qs.toString()}`;
}

const UNCHECKED: LookupVerdict = { flagged: false, threatType: null, checked: false };

/**
 * Look up unique URIs through uris.search, within the monthly cap.
 * Returns one verdict per input (same order); anything not answered by
 * Google is `checked: false`. Never throws.
 *
 * `deadline` (epoch ms): no new call is started after it.
 */
export async function webRiskLookup(
  env: Env,
  uris: string[],
  opts: { deadline?: number } = {},
): Promise<{ verdicts: LookupVerdict[]; stats: LookupRunStats }> {
  const verdicts: LookupVerdict[] = uris.map(() => UNCHECKED);
  const stats: LookupRunStats = {
    calls: 0, capped: false, quotaUnavailable: false, noToken: false, errors: 0, deadlineSkipped: 0,
  };
  if (uris.length === 0) return { verdicts, stats };
  if (webRiskLookupMonthlyCap(env) === 0) {
    stats.capped = true;
    logger.warn("web_risk_lookup_quota_stop", { reason: "monthly_cap", cap: 0, calls: 0, unchecked: uris.length });
    return { verdicts, stats };
  }

  const token = await getGoogleAccessToken(env, SCOPE).catch(() => null);
  if (!token) {
    stats.noToken = true;
    return { verdicts, stats };
  }

  const pastDeadline = (): boolean => opts.deadline !== undefined && Date.now() >= opts.deadline;
  let stop = false;
  let deadlineHit = false;
  let next = 0;
  while (next < uris.length && !stop) {
    if (pastDeadline()) { deadlineHit = true; break; }
    const blockSize = Math.min(LOOKUP_BLOCK_SIZE, uris.length - next);
    const granted = await reserveLookups(env, blockSize);
    if (granted === null) { stats.quotaUnavailable = true; break; }
    if (granted === 0) { stats.capped = true; break; }
    if (granted < blockSize) stats.capped = true;

    const block = Array.from({ length: granted }, (_, k) => next + k);
    next += granted;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < block.length && !stop) {
        if (pastDeadline()) { deadlineHit = true; return; }
        const idx = block[cursor++]!;
        stats.calls++;
        try {
          const res = await fetch(searchUrl(uris[idx]!), {
            method: "GET",
            headers: { Authorization: `Bearer ${token.access_token}` },
            signal: AbortSignal.timeout(LOOKUP_CALL_TIMEOUT_MS),
          });
          if (!res.ok) {
            stats.errors++;
            // Auth / quota errors will repeat for every URL: stop spending calls.
            if (res.status === 401 || res.status === 403 || res.status === 429) stop = true;
            logger.warn("web_risk_lookup_http_error", { status: res.status });
            continue;
          }
          verdicts[idx] = mapSearchResponse(await res.json());
        } catch (err) {
          stats.errors++;
          logger.warn("web_risk_lookup_error", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, block.length) }, worker));
    if (stats.capped) break;
  }

  if (deadlineHit) stats.deadlineSkipped = uris.length - stats.calls;
  // One log line per run when the cap or counter stopped it.
  if (stats.capped || stats.quotaUnavailable) {
    logger.warn("web_risk_lookup_quota_stop", {
      reason: stats.quotaUnavailable ? "counter_unavailable" : "monthly_cap",
      cap: webRiskLookupMonthlyCap(env),
      calls: stats.calls,
      unchecked: verdicts.filter((v) => !v.checked).length,
    });
  }
  return { verdicts, stats };
}
