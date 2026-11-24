// Google Cloud Web Risk — Lookup API (uris.search) client with call quotas.
//
// Replaces the Safe Browsing v4 Lookup API (safebrowsing.googleapis.com),
// whose terms allow non-commercial use only. Averrow is a paid product, so
// every URL-reputation lookup goes through Web Risk instead. Callers:
//   - feeds/googleSafeBrowsing.ts — the `google_safe_browsing` enrichment feed
//   - lib/contact-link-scan.ts    — contact-form link scan (via
//                                   checkGoogleSafeBrowsing, purpose 'contact')
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
// credential the Web Risk takedown submitter uses). No token → nothing is
// looked up and every URL comes back checked=false. A 401/403 drops the
// cached token (invalidateGoogleAccessToken) so the next run re-mints it.
//
// ── Quotas (D1 core table api_quota_counters, migration 0338) ───────────
//   web_risk_lookup:month        per UTC month, every caller.
//                                Default 90,000 (10,000 below the free
//                                100,000); WEB_RISK_LOOKUP_MONTHLY_CAP
//                                overrides it, clamped to ≤ 100,000 so it can
//                                never be configured past the free tier.
//   web_risk_lookup:contact_day  per UTC day, contact-form path only, reserved
//                                BEFORE the monthly bucket. Default 200;
//                                WEB_RISK_LOOKUP_CONTACT_DAILY_CAP overrides,
//                                clamped to ≤ 1,000. It exists because the
//                                contact form's 50/day notify slot is refunded
//                                when the email send fails, but lookups are
//                                not: without it a visitor could drain the
//                                monthly quota through failed sends.
// Overrides: a non-negative integer; 0 = no lookups for that bucket; an
// invalid value is logged (once per isolate) and ignored.
//
// A reservation is ONE D1 statement (RESERVE_SQL): an UPSERT whose SET grants
// min(want, cap − n) — SQLite evaluates every SET expression against the OLD
// row, so `last_grant` and `n` see the same `n` — and RETURNING reads the
// grant back. Concurrent callers therefore can never be granted more than the
// cap between them. Every HTTP call made to uris.search is reserved first,
// whatever its outcome; a reservation is never refunded (a run cut short by a
// deadline or a 401/403 only over-counts). The feed reserves its whole run in
// one statement. Fails CLOSED: any D1 error → no calls.
//
// Expected volume (2026-11, from code): the feed runs in the hourly `:07`
// enrichment loop (feed_configs `*/30` interval, but the loop only runs once
// an hour) and checks ≤ 100 threats per run, de-duplicated by URL, minus
// cache hits → ≤ 24 × 100 = 2,400 calls/day ≈ 74,400 per 31-day month at
// the very most (plus rare manual enrichment runs). The contact form is held
// to its own 200/day bucket → ≤ 6,200/month. Worst case combined ≈ 80,600
// < 90,000; typical far lower. If the monthly cap is ever hit, the feed simply
// waits (rows stay gsb_checked = 0) until the next month.

import type { Env } from "../types";
import { store } from "./db-registry";
import { getGoogleAccessToken, invalidateGoogleAccessToken } from "./google-service-account";
import { logger } from "./logger";

export const WEB_RISK_LOOKUP_MONTHLY_CAP_DEFAULT = 90_000;
/** Google's free tier; the monthly override can never exceed it. */
export const WEB_RISK_LOOKUP_MONTHLY_CAP_MAX = 100_000;
export const WEB_RISK_LOOKUP_CONTACT_DAILY_CAP_DEFAULT = 200;
export const WEB_RISK_LOOKUP_CONTACT_DAILY_CAP_MAX = 1_000;
/** Parallel uris.search requests in flight (Google quota: 6,000/min/project). */
export const LOOKUP_CONCURRENCY = 4;
/** Per-request timeout. */
export const LOOKUP_CALL_TIMEOUT_MS = 10_000;
/** A run whose every call (≥ this many) was a 400 is a request bug, not
 *  bad URLs: nothing is stamped terminal. */
export const SYSTEMIC_REJECT_MIN_CALLS = 5;

export const MONTH_BUCKET = "web_risk_lookup:month";
export const CONTACT_DAY_BUCKET = "web_risk_lookup:contact_day";

const ENDPOINT = "https://webrisk.googleapis.com/v1/uris:search";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const THREAT_TYPES = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"] as const;
/** Most severe first — the reported threatType when several are listed. */
const THREAT_PRIORITY: readonly string[] = THREAT_TYPES;

/**
 * Atomic reservation. Binds: bucket, period, then (want, cap) four times.
 * Insert: grant min(want, cap). Conflict: grant max(0, min(want, cap − n)),
 * computed twice against the same old n.
 */
export const RESERVE_SQL = `INSERT INTO api_quota_counters (bucket, period, n, last_grant)
  VALUES (?, ?, min(?, ?), min(?, ?))
  ON CONFLICT(bucket, period) DO UPDATE SET
    last_grant = max(0, min(?, ? - n)),
    n = n + max(0, min(?, ? - n))
  RETURNING n, last_grant`;

export const READ_USED_SQL = `SELECT n FROM api_quota_counters WHERE bucket = ? AND period = ?`;

export type LookupPurpose = "feed" | "contact";

export interface LookupVerdict {
  flagged: boolean;
  threatType: string | null;
  checked: boolean;
  /** Google answered 400 for this URI: it will never be answerable. */
  rejected?: boolean;
}

export interface LookupRunStats {
  /** uris.search HTTP calls made (each one reserved against the caps). */
  calls: number;
  /** A cap stopped the run (some URLs left unchecked). */
  capped: boolean;
  /** The counter could not be read/written; no calls were made. */
  quotaUnavailable: boolean;
  /** No access token (no service account, or token exchange failed). */
  noToken: boolean;
  /** Google answered 401/403: credential problem, run stopped. */
  authFailed: boolean;
  /** Every call (≥ SYSTEMIC_REJECT_MIN_CALLS) was a 400. */
  systemicReject: boolean;
  /** Calls that failed (any non-2xx, network, bad body). */
  errors: number;
  /** URIs answered 400 (terminal; see LookupVerdict.rejected). */
  rejected: number;
  /** Reserved URIs not attempted because the deadline passed. */
  deadlineSkipped: number;
}

// ── caps ──────────────────────────────────────────────────────────────

const warnedOverrides = new Set<string>();
function warnOnce(name: string, raw: string, why: string): void {
  const k = `${name}=${raw}`;
  if (warnedOverrides.has(k)) return;
  warnedOverrides.add(k);
  logger.warn("web_risk_lookup_cap_override", { var: name, value: raw, problem: why });
}

function parseCap(name: string, raw: string | undefined, dflt: number, max: number): number {
  const v = raw?.trim();
  if (!v) return dflt;
  if (!/^\d+$/.test(v)) {
    warnOnce(name, v, `not a non-negative integer — using default ${dflt}`);
    return dflt;
  }
  const n = Number(v);
  if (n > max) {
    warnOnce(name, v, `above ${max} — clamped to ${max}`);
    return max;
  }
  return n;
}

/** WEB_RISK_LOOKUP_MONTHLY_CAP (0..100,000), else 90,000. */
export function webRiskLookupMonthlyCap(env: Env): number {
  return parseCap("WEB_RISK_LOOKUP_MONTHLY_CAP", env.WEB_RISK_LOOKUP_MONTHLY_CAP,
    WEB_RISK_LOOKUP_MONTHLY_CAP_DEFAULT, WEB_RISK_LOOKUP_MONTHLY_CAP_MAX);
}

/** WEB_RISK_LOOKUP_CONTACT_DAILY_CAP (0..1,000), else 200. */
export function webRiskLookupContactDailyCap(env: Env): number {
  return parseCap("WEB_RISK_LOOKUP_CONTACT_DAILY_CAP", env.WEB_RISK_LOOKUP_CONTACT_DAILY_CAP,
    WEB_RISK_LOOKUP_CONTACT_DAILY_CAP_DEFAULT, WEB_RISK_LOOKUP_CONTACT_DAILY_CAP_MAX);
}

export const monthPeriod = (now: Date): string => now.toISOString().slice(0, 7);
export const dayPeriod = (now: Date): string => now.toISOString().slice(0, 10);

// ── counter ───────────────────────────────────────────────────────────

/** Atomically reserve up to `want` from one bucket. Throws on a D1 error. */
async function reserveBucket(env: Env, bucket: string, period: string, want: number, cap: number): Promise<number> {
  if (want <= 0 || cap <= 0) return 0;
  const row = await store(env, "core").prepare(RESERVE_SQL)
    .bind(bucket, period, want, cap, want, cap, want, cap, want, cap)
    .first<{ n: number; last_grant: number }>();
  if (!row || typeof row.last_grant !== "number") throw new Error("api_quota_counters reserve returned no row");
  return Math.max(0, Math.min(want, row.last_grant));
}

/**
 * Reserve up to `want` lookups. Returns the number granted (0 at a cap), or
 * null when the counter can't be read or written (fail closed: no calls).
 * The contact path reserves its daily bucket first, then the monthly one.
 */
export async function reserveLookups(
  env: Env,
  want: number,
  purpose: LookupPurpose = "feed",
  now: Date = new Date(),
): Promise<number | null> {
  if (want <= 0) return 0;
  try {
    let wanted = want;
    if (purpose === "contact") {
      wanted = await reserveBucket(env, CONTACT_DAY_BUCKET, dayPeriod(now), wanted, webRiskLookupContactDailyCap(env));
      if (wanted === 0) return 0;
    }
    return await reserveBucket(env, MONTH_BUCKET, monthPeriod(now), wanted, webRiskLookupMonthlyCap(env));
  } catch (err) {
    logger.warn("web_risk_lookup_counter_error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Monthly calls left: a number, or null when the counter is unreadable.
 * Read-only — use it to skip work up front; reserveLookups() is the gate.
 */
export async function webRiskLookupsRemaining(env: Env, now: Date = new Date()): Promise<number | null> {
  const cap = webRiskLookupMonthlyCap(env);
  if (cap === 0) return 0;
  try {
    const row = await store(env, "core").prepare(READ_USED_SQL)
      .bind(MONTH_BUCKET, monthPeriod(now)).first<{ n: number }>();
    const used = row?.n ?? 0;
    if (typeof used !== "number" || !Number.isFinite(used)) return null;
    return Math.max(0, cap - used);
  } catch {
    return null;
  }
}

// ── request / response ────────────────────────────────────────────────

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
 * Look up unique URIs through uris.search, within the caps. Returns one
 * verdict per input (same order); anything Google did not answer is
 * `checked: false`. Never throws.
 *
 * `deadline` (epoch ms): no new call is started after it.
 */
export async function webRiskLookup(
  env: Env,
  uris: string[],
  opts: { deadline?: number; purpose?: LookupPurpose } = {},
): Promise<{ verdicts: LookupVerdict[]; stats: LookupRunStats }> {
  const purpose = opts.purpose ?? "feed";
  const verdicts: LookupVerdict[] = uris.map(() => UNCHECKED);
  const stats: LookupRunStats = {
    calls: 0, capped: false, quotaUnavailable: false, noToken: false, authFailed: false,
    systemicReject: false, errors: 0, rejected: 0, deadlineSkipped: 0,
  };
  if (uris.length === 0) return { verdicts, stats };

  const logStop = (reason: string): void => {
    logger.warn("web_risk_lookup_quota_stop", {
      reason, purpose, calls: stats.calls, unchecked: verdicts.filter((v) => !v.checked).length,
    });
  };

  if (webRiskLookupMonthlyCap(env) === 0 || (purpose === "contact" && webRiskLookupContactDailyCap(env) === 0)) {
    stats.capped = true;
    logStop("cap_zero");
    return { verdicts, stats };
  }

  const token = await getGoogleAccessToken(env, SCOPE).catch(() => null);
  if (!token) {
    stats.noToken = true;
    return { verdicts, stats };
  }

  // One atomic reservation for the whole run.
  const granted = await reserveLookups(env, uris.length, purpose);
  if (granted === null) {
    stats.quotaUnavailable = true;
    logStop("counter_unavailable");
    return { verdicts, stats };
  }
  if (granted < uris.length) stats.capped = true;

  const pastDeadline = (): boolean => opts.deadline !== undefined && Date.now() >= opts.deadline;
  let stop = false;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < granted && !stop) {
      if (pastDeadline()) return;
      const idx = cursor++;
      stats.calls++;
      try {
        const res = await fetch(searchUrl(uris[idx]!), {
          method: "GET",
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.timeout(LOOKUP_CALL_TIMEOUT_MS),
        });
        if (!res.ok) {
          stats.errors++;
          if (res.status === 400) {
            // Per-URI rejection (INVALID_ARGUMENT): retrying won't help.
            stats.rejected++;
            verdicts[idx] = { ...UNCHECKED, rejected: true };
          } else if (res.status === 401 || res.status === 403 || res.status === 404) {
            // Credential problem, or (404) a wrong endpoint / project: not
            // about this URI, and every further call would fail the same way.
            stats.authFailed = true;
            stop = true;
          } else if (res.status === 429) {
            stop = true;
          }
          logger.warn("web_risk_lookup_http_error", { status: res.status, purpose });
          continue;
        }
        verdicts[idx] = mapSearchResponse(await res.json());
      } catch (err) {
        stats.errors++;
        logger.warn("web_risk_lookup_error", { error: err instanceof Error ? err.message : String(err), purpose });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, granted) }, worker));

  // Deadline skips only: reserved URIs never attempted, and not stopped by
  // an auth / rate-limit error.
  if (!stop && stats.calls < granted) stats.deadlineSkipped = granted - stats.calls;

  if (stats.authFailed) await invalidateGoogleAccessToken(env, SCOPE);

  if (stats.rejected > 0 && stats.rejected === stats.calls && stats.calls >= SYSTEMIC_REJECT_MIN_CALLS) {
    // Every call rejected: our request is wrong, not the URLs. Don't let the
    // caller stamp anything terminal.
    stats.systemicReject = true;
    for (let i = 0; i < verdicts.length; i++) {
      if (verdicts[i]!.rejected) verdicts[i] = UNCHECKED;
    }
    logger.error("web_risk_lookup_systemic_reject", { calls: stats.calls, purpose });
  }

  if (stats.capped) logStop("cap");
  return { verdicts, stats };
}

/**
 * API rows: `gsb_checked` as 1 only when Google actually answered (1), else 0.
 * The column also holds 2 (Google rejected the URI: unanswerable, NOT clean),
 * which a client treating any non-zero value as "checked" would misread.
 * Use on every response that returns a raw `threats` row (SELECT *).
 */
export function withGsbVerdict<T>(row: T): T {
  if (row === null || typeof row !== "object" || !("gsb_checked" in (row as object))) return row;
  const out = { ...(row as Record<string, unknown>) };
  out.gsb_checked = out.gsb_checked === 1 ? 1 : 0;
  return out as T;
}
