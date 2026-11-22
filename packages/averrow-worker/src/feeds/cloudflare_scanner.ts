import type { FeedModule, FeedContext, FeedResult } from "./types";
import { loadSafeDomainSet, isSafeDomain } from "../lib/safeDomains";
import { hashToken } from "../lib/hash";
import { toSqliteDatetime } from "../lib/backoff";
import type { Env } from "../types";

/**
 * Cloudflare URL Scanner — two-phase enrichment of recent threat URLs.
 *
 * Step 0 (AUTH GATE, before any D1 read): one cheap authenticated GET on
 *   the URL Scanner API (CF_AUTH_PROBE_PATH). 401/403 → the pull THROWS
 *   `CfScannerAuthError`, and the verdict is cached in KV for
 *   CF_AUTH_DENIED_TTL_S, keyed on a fingerprint of the token, so later
 *   ticks fail just as fast without even probing. A rotated token gets a
 *   new key and is probed at once. (The token needs Account > URL Scanner >
 *   Edit; the shared CF_API_TOKEN lacked it from 2026-07-26: HTTP 403 code
 *   10000.) Any other probe failure (5xx, 429, network) also throws, uncached.
 *
 *   Token: the dedicated CF_OPS_API_TOKEN (Account › URL Scanner › Edit +
 *   Account › D1 › Read) if set, else the shared CF_API_TOKEN
 *   (resolveScannerToken, same pattern as cf_radar_bots' CF_RADAR_API_TOKEN).
 *   The auth error names the secret that was used.
 *
 *   Why throw rather than return `itemsError`: runFeed treats a returned
 *   result as a SUCCESSFUL pull — it resets consecutive_failures and clears
 *   next_retry_at, so the breaker never backs off, never auto-pauses and
 *   never alerts, and the feed ran its D1 reads every 30 min for months
 *   while broken. A throw is a failed pull: exponential backoff
 *   (5 → 15 → 45 → 120 min), "Feed degraded" notification on the first
 *   failure, auto-pause at the threshold. Re-enabling after the token is
 *   fixed works as for any auto-paused feed.
 *
 * Phase 1 (SUBMIT): up to CF_SCAN_SUBMIT_LIMIT unscanned URLs per run, from
 *   the newest CF_SCAN_CANDIDATE_CAP threats created in the last
 *   CF_SCAN_WINDOW_DAYS days, prioritised brand-matched > phishing >
 *   typosquat > C2 > rest, newest first. The candidate read is an index range
 *   on created_at capped at CF_SCAN_CANDIDATE_CAP rows; priority ordering is
 *   applied to that bounded set only. (It used to order ALL ~1.1M threats
 *   with `cf_scan_id IS NULL` — an unindexed full scan + sort per run that
 *   tripped D1's overload window.) Older threats are not submitted: a scan of
 *   a weeks-old phishing URL is mostly a dead page.
 * Phase 2 (COLLECT): polls up to CF_SCAN_POLL_LIMIT submitted scans with no
 *   verdict yet (`cf_scan_id IS NOT NULL AND cf_verdict IS NULL`, served by
 *   the partial index idx_threats_cf_scan, which holds only submitted rows —
 *   a few thousand at most), stores the verdict, adjusts confidence and
 *   auto-remediates low-confidence threats whose CF verdict is clean.
 *
 * Writes one summary agent_outputs diagnostic per completed run. Uses the
 * CF_ACCOUNT_ID secret + CF_OPS_API_TOKEN (fallback CF_API_TOKEN). Schedule:
 * feed_configs interval.
 */

/** Phase 1 looks back this many days of threat creation. */
export const CF_SCAN_WINDOW_DAYS = 3;
/** Phase 1 reads at most this many of the newest threats in the window. */
export const CF_SCAN_CANDIDATE_CAP = 2000;
/** Phase 1 submits at most this many URLs per run. */
export const CF_SCAN_SUBMIT_LIMIT = 50;
/** Phase 2 polls at most this many pending scans per run. */
export const CF_SCAN_POLL_LIMIT = 100;
/** How long a 401/403 verdict for one token is remembered (6h). */
export const CF_AUTH_DENIED_TTL_S = 21_600;
/**
 * The auth probe: a result lookup for the nil UUID. A token with URL
 * Scanner access gets 404 (no such scan); one without gets 401/403. Same
 * endpoint family Phase 2 polls, so it needs no extra permission.
 */
export const CF_AUTH_PROBE_PATH = "/v2/result/00000000-0000-0000-0000-000000000000";

const AUTH_DENIED_KEY_PREFIX = "cf_scanner:auth_denied:";

export type ScannerTokenName = "CF_OPS_API_TOKEN" | "CF_API_TOKEN";

/**
 * Prefer the dedicated ops token; fall back to the shared worker-wide
 * CF_API_TOKEN so existing deployments keep working. A whitespace-only
 * secret never shadows the fallback.
 */
export function resolveScannerToken(
  env: Pick<Env, "CF_OPS_API_TOKEN" | "CF_API_TOKEN">,
): { token: string | undefined; tokenName: ScannerTokenName } {
  const ops = env.CF_OPS_API_TOKEN?.trim();
  if (ops) return { token: ops, tokenName: "CF_OPS_API_TOKEN" };
  return { token: env.CF_API_TOKEN?.trim() || undefined, tokenName: "CF_API_TOKEN" };
}

/** Thrown when the scanner token cannot use the URL Scanner API. */
export class CfScannerAuthError extends Error {
  constructor(readonly httpStatus: number, readonly tokenName: ScannerTokenName) {
    super(`CF URL Scanner: ${tokenName} lacks Account › URL Scanner › Edit (HTTP ${httpStatus})`);
    this.name = "CfScannerAuthError";
  }
}

/** Phase 1 candidate read: bounded index range, priority sort on the bounded set. */
export const CF_SCAN_CANDIDATES_SQL = `
  SELECT id, malicious_url FROM (
    SELECT id, malicious_url, target_brand_id, threat_type, created_at, cf_scan_id
      FROM threats
     WHERE created_at >= ?
     ORDER BY created_at DESC
     LIMIT ?
  ) AS recent
  WHERE cf_scan_id IS NULL
    AND malicious_url IS NOT NULL
  ORDER BY
    CASE WHEN target_brand_id IS NOT NULL THEN 0 ELSE 1 END,
    CASE WHEN threat_type = 'phishing' THEN 0
         WHEN threat_type = 'typosquatting' THEN 1
         WHEN threat_type = 'c2' THEN 2
         ELSE 3 END,
    created_at DESC
  LIMIT ?`;

/** Phase 2 pending-verdict read (partial index idx_threats_cf_scan). */
export const CF_SCAN_PENDING_SQL = `
  SELECT id, cf_scan_id FROM threats
   WHERE cf_scan_id IS NOT NULL AND cf_verdict IS NULL
   LIMIT ?`;

interface CfScanSubmitResponse {
  success: boolean;
  result?: { uuid: string };
  errors?: Array<{ message: string }>;
}

interface CfScanResultResponse {
  success: boolean;
  result?: {
    scan?: {
      verdicts?: {
        overall?: {
          malicious: boolean;
          categories?: string[];
        };
      };
      meta?: {
        processors?: {
          phishing?: { phishingDetected?: boolean; brand?: string };
          rank?: { bucket?: string; rank?: number };
        };
      };
      page?: {
        url?: string;
        country?: string;
        ip?: string;
      };
    };
  };
  errors?: Array<{ message: string }>;
}

async function cfFetch<T>(accountId: string, token: string, path: string, init?: RequestInit): Promise<{ parsed: T | null; raw: string; status: number }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/urlscanner${path}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const raw = await res.text();
    if (res.status === 404) return { parsed: null, raw, status: 404 };
    if (!res.ok) {
      console.error(`[cf_scanner] HTTP ${res.status} for ${path}: ${raw.slice(0, 300)}`);
      return { parsed: null, raw, status: res.status };
    }
    try {
      return { parsed: JSON.parse(raw) as T, raw, status: res.status };
    } catch {
      console.error(`[cf_scanner] JSON parse error for ${path}: ${raw.slice(0, 300)}`);
      return { parsed: null, raw, status: res.status };
    }
  } catch (err) {
    console.error(`[cf_scanner] fetch error for ${path}:`, err);
    return { parsed: null, raw: String(err), status: 0 };
  }
}

const isAuthStatus = (status: number): boolean => status === 401 || status === 403;

/** KV key of the cached auth-denied verdict for `token` (never the token itself). */
export async function cfAuthDeniedKey(token: string): Promise<string> {
  return AUTH_DENIED_KEY_PREFIX + (await hashToken(token)).slice(0, 16);
}

async function rememberAuthDenied(kv: KVNamespace, key: string, status: number): Promise<void> {
  try {
    await kv.put(key, String(status), { expirationTtl: CF_AUTH_DENIED_TTL_S });
  } catch {
    // Best-effort: without the marker the next tick just probes again.
  }
}

/**
 * Throws unless the token can use the URL Scanner API. A cached 401/403
 * verdict throws without a request; otherwise one probe request.
 */
async function assertScannerAccess(
  ctx: FeedContext,
  accountId: string,
  token: string,
  tokenName: ScannerTokenName,
  deniedKey: string,
): Promise<void> {
  let cached: string | null = null;
  try {
    cached = await ctx.env.CACHE.get(deniedKey);
  } catch {
    cached = null; // KV transient — probe instead.
  }
  if (cached !== null) {
    const status = Number(cached);
    throw new CfScannerAuthError(isAuthStatus(status) ? status : 403, tokenName);
  }

  const { status, raw } = await cfFetch<unknown>(accountId, token, CF_AUTH_PROBE_PATH);
  if (isAuthStatus(status)) {
    await rememberAuthDenied(ctx.env.CACHE, deniedKey, status);
    throw new CfScannerAuthError(status, tokenName);
  }
  // 2xx / 404 (no such scan) / other 4xx = the token got past auth.
  // 429, 5xx and network errors (0) mean the API is unusable right now:
  // fail the pull (breaker backoff) without caching anything.
  if (status === 0 || status === 429 || status >= 500) {
    throw new Error(`CF URL Scanner: auth probe failed (HTTP ${status}): ${raw.slice(0, 200)}`);
  }
}

export const cloudflare_scanner: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const accountId = ctx.env.CF_ACCOUNT_ID;
    const { token, tokenName } = resolveScannerToken(ctx.env);

    if (!accountId || !token) {
      console.warn("[cf_scanner] CF_ACCOUNT_ID or CF_OPS_API_TOKEN / CF_API_TOKEN not configured — skipping");
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // ─── Step 0: auth gate — before ANY D1 read ──────────────────
    const deniedKey = await cfAuthDeniedKey(token);
    await assertScannerAccess(ctx, accountId, token, tokenName, deniedKey);

    let submitted = 0, collected = 0, errors = 0, maliciousCount = 0;

    // ─── Phase 1: SUBMIT recent unscanned URLs ───────────────────
    const windowStart = toSqliteDatetime(new Date(Date.now() - CF_SCAN_WINDOW_DAYS * 86_400_000));
    const toScan = await ctx.env.DB.prepare(CF_SCAN_CANDIDATES_SQL)
      .bind(windowStart, CF_SCAN_CANDIDATE_CAP, CF_SCAN_SUBMIT_LIMIT)
      .all<{ id: string; malicious_url: string }>();

    // Filter out threats whose URL domain is in the safe domain allowlist.
    // The allowlist is only loaded when there is something to submit.
    const safeSet = toScan.results.length > 0 ? await loadSafeDomainSet(ctx.env.DB) : new Set<string>();
    const filteredToScan = toScan.results.filter((row) => {
      try {
        const domain = new URL(row.malicious_url).hostname;
        if (isSafeDomain(domain, safeSet)) {
          return false;
        }
      } catch (e) {
        console.warn(`[cf_scanner] failed to parse URL for safe-domain check: ${row.malicious_url}`, e);
      }
      return true;
    });

    let first = true;
    for (const row of filteredToScan) {
      const { parsed: resp, raw, status } = await cfFetch<CfScanSubmitResponse>(accountId, token, "/v2/scan", {
        method: "POST",
        body: JSON.stringify({ url: row.malicious_url, visibility: "Unlisted" }),
      });

      // The probe only proves read access; submitting needs Edit. A 401/403
      // on the first submit fails the pull the same way (and is cached).
      if (first) {
        first = false;
        if (isAuthStatus(status)) {
          await rememberAuthDenied(ctx.env.CACHE, deniedKey, status);
          throw new CfScannerAuthError(status, tokenName);
        }
      }

      if (resp?.success && resp.result?.uuid) {
        const updateResult = await ctx.env.DB.prepare(
          "UPDATE threats SET cf_scan_id = ? WHERE id = ?",
        ).bind(resp.result.uuid, row.id).run();

        if (updateResult.meta.changes === 0) {
          console.error(`[cf_scanner] UPDATE cf_scan_id FAILED — 0 rows changed for id=${row.id}`);
          errors++;
        } else {
          submitted++;
        }
      } else {
        errors++;
        console.error(`[cf_scanner] submit failed for ${row.malicious_url}: status=${status}, errors=${JSON.stringify(resp?.errors ?? [])}, raw=${raw.slice(0, 300)}`);
      }

      // Brief pause between submissions
      await new Promise((r) => setTimeout(r, 200));
    }

    // ─── Phase 2: COLLECT results ────────────────────────────────
    const pending = await ctx.env.DB.prepare(CF_SCAN_PENDING_SQL)
      .bind(CF_SCAN_POLL_LIMIT)
      .all<{ id: string; cf_scan_id: string }>();

    for (const row of pending.results) {
      const { parsed: resp, status } = await cfFetch<CfScanResultResponse>(accountId, token, `/v2/result/${row.cf_scan_id}`);

      if (!resp) {
        // 404 = still in progress, skip
        if (status !== 404) console.error(`[cf_scanner] ${row.cf_scan_id}: poll failed status=${status}`);
        continue;
      }

      if (!resp.success || !resp.result?.scan) {
        errors++;
        continue;
      }

      const scan = resp.result.scan;
      const isMalicious = scan.verdicts?.overall?.malicious ?? false;
      const categories = scan.verdicts?.overall?.categories ?? [];
      const verdict = isMalicious ? "malicious" : "clean";
      if (isMalicious) maliciousCount++;

      // Update threat with verdict and adjust confidence + auto-remediate
      await ctx.env.DB.prepare(
        `UPDATE threats SET
          cf_verdict = ?,
          cf_categories = ?,
          confidence_score = CASE
            WHEN ? = 1 THEN MAX(COALESCE(confidence_score, 0), 90)
            WHEN ? = 0 AND COALESCE(confidence_score, 0) > 50 THEN confidence_score - 20
            ELSE confidence_score
          END,
          status = CASE
            WHEN ? = 0 AND COALESCE(confidence_score, 0) <= 50 THEN 'remediated'
            ELSE status
          END
        WHERE id = ?`,
      ).bind(
        verdict,
        categories.length > 0 ? JSON.stringify(categories) : null,
        isMalicious ? 1 : 0,
        isMalicious ? 1 : 0,
        isMalicious ? 1 : 0,
        row.id,
      ).run();

      collected++;

      // If CF provides hosting IP/country, update if missing
      if (scan.page?.ip || scan.page?.country) {
        try {
          await ctx.env.DB.prepare(
            `UPDATE threats SET
              ip_address = COALESCE(ip_address, ?),
              country_code = COALESCE(country_code, ?)
            WHERE id = ? AND (ip_address IS NULL OR country_code IS NULL)`,
          ).bind(scan.page.ip ?? null, scan.page.country ?? null, row.id).run();
        } catch { /* non-fatal */ }
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    // The one diagnostic per run: a summary of a run that got past the auth gate.
    const summary = `CF Scanner done: candidates=${toScan.results.length}, submitted=${submitted}, collected=${collected}, malicious=${maliciousCount}, errors=${errors}`;
    try {
      await ctx.env.DB.prepare(
        "INSERT INTO agent_outputs (id, agent_id, type, summary, created_at) VALUES (?, 'sentinel', 'diagnostic', ?, datetime('now'))"
      ).bind('diag_cf_done_' + Date.now(), summary).run();
    } catch { /* non-fatal */ }

    return {
      itemsFetched: toScan.results.length + pending.results.length,
      itemsNew: collected,
      itemsDuplicate: 0,
      itemsError: errors,
    };
  },
};
