import type { FeedModule, FeedContext, FeedResult } from "./types";
import { loadSafeDomainSet, isSafeDomain } from "../lib/safeDomains";
import { toSqliteDatetime } from "../lib/backoff";
import type { Env } from "../types";
import { agentOutputsStore } from "../db/agent-outputs";
import { isValidIPv4, isValidIPv6 } from "../lib/abuse-mailbox-iocs";

/**
 * Cloudflare URL Scanner — two-phase enrichment of recent threat URLs.
 *
 * Step 0 (AUTH GATE, before any D1 read): one cheap authenticated GET on
 *   the URL Scanner API (CF_AUTH_PROBE_PATH), EVERY run. 401/403 → the pull
 *   THROWS `CfScannerAuthError` (401: token invalid or expired; 403: token
 *   lacks Account › URL Scanner › Edit; both name the secret used). Nothing
 *   is cached: the D1 saving comes from probing first, and a cached denial
 *   could outlive a permission fix on the same token value or be poisoned by
 *   a transient 403. The breaker's backoff already spaces failed runs out.
 *   (The shared CF_API_TOKEN lacked the permission from 2026-07-26: HTTP 403
 *   code 10000.) Any other probe failure (5xx, 429, network) also throws.
 *   The probe only proves read access, so a 401/403 on the FIRST submit or
 *   the FIRST Phase 2 poll fails the pull the same way.
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
 *   CF_SCAN_WINDOW_DAYS days (at ~14K new threats/day the 2,000-row cap
 *   usually binds well inside 3 days — roughly the last 3-4 hours; the
 *   window only matters when ingest is quiet), prioritised brand-matched > phishing >
 *   typosquat > C2 > rest, newest first. The candidate read is an index range
 *   on created_at capped at CF_SCAN_CANDIDATE_CAP rows; priority ordering is
 *   applied to that bounded set only. (It used to order ALL ~1.1M threats
 *   with `cf_scan_id IS NULL` — an unindexed full scan + sort per run that
 *   tripped D1's overload window.) Older threats are not submitted: a scan of
 *   a weeks-old phishing URL is mostly a dead page.
 *   v2 submit answers 200 with a TOP-LEVEL body `{ uuid, api, visibility,
 *   url, message, result: "<report URL>" }` — no `success`/`result.uuid`
 *   envelope (`parseSubmitUuid`; the v1 envelope is still tolerated). Until
 *   2026-11-23 the module read only the v1 envelope, so every accepted scan
 *   counted as an error, cf_scan_id was never stored and the same URLs were
 *   resubmitted every run, burning the URL Scanner quota. A 400 / 422 (CF
 *   refuses that URL: unresolvable / blocked / invalid) is terminal for the
 *   threat: cf_verdict = 'failed' with cf_scan_id still NULL, and the
 *   candidate read skips rows with a verdict, so it is never resubmitted —
 *   unless the run's first SYSTEMIC_REJECTION_SAMPLE rejections are
 *   identical (our request is wrong, not the URLs): then nothing is retired
 *   and submitting stops. 409 is an ordinary error (undocumented in v2). A
 *   429 (quota) stops submitting for the run.
 * Phase 2 (COLLECT): polls up to CF_SCAN_POLL_LIMIT submitted scans with no
 *   verdict yet (`cf_scan_id IS NOT NULL AND cf_verdict IS NULL`, served by
 *   the partial index idx_threats_cf_scan, which holds only submitted rows —
 *   a few thousand at most), oldest first, stores the verdict, adjusts
 *   confidence and auto-remediates low-confidence threats whose CF verdict
 *   is clean. A scan pending > CF_SCAN_PENDING_EXPIRE_DAYS is marked
 *   cf_verdict = 'expired' without a poll, and a 200 with no scan body is
 *   marked 'failed' (no confidence/status change for either), so
 *   it leaves the pending set. cf_verdict has no reader outside this module
 *   (audit 0253), so the extra value is safe. v2 `GET /v2/result/{uuid}`
 *   answers 404 while the scan runs (still pending — neither an error nor
 *   expired before the expiry window) and 200 with top-level `task`, `page`,
 *   `verdicts` when done (`parseScanResult`); a not-Finished task.status is
 *   still pending; `task.success === false` (DNS error, blocked fetch), no
 *   `verdicts`, or a non-boolean `verdicts.overall.malicious` is 'failed' —
 *   only an explicit `malicious === false` reads as clean.
 *
 * Writes one summary agent_outputs diagnostic per completed run; its
 * `details` JSON carries the counters plus the FIRST submit error / rejection
 * / poll error (HTTP status + Cloudflare's message, truncated) so a failing
 * run is diagnosable from D1, not only from worker logs. Uses the
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
/**
 * The auth probe: a result lookup for the nil UUID. A token with URL
 * Scanner access gets 404 (no such scan); one without gets 401/403. Same
 * endpoint family Phase 2 polls, so it needs no extra permission.
 */
export const CF_AUTH_PROBE_PATH = "/v2/result/00000000-0000-0000-0000-000000000000";

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
    super(
      httpStatus === 401
        ? `CF URL Scanner: ${tokenName} is invalid or expired (HTTP 401)`
        : `CF URL Scanner: ${tokenName} lacks Account › URL Scanner › Edit (HTTP ${httpStatus})`,
    );
    this.name = "CfScannerAuthError";
  }
}

/** Phase 1 candidate read: bounded index range, priority sort on the bounded set. */
export const CF_SCAN_CANDIDATES_SQL = `
  SELECT id, malicious_url FROM (
    SELECT id, malicious_url, target_brand_id, threat_type, created_at, cf_scan_id, cf_verdict
      FROM threats
     WHERE created_at >= ?
     ORDER BY created_at DESC
     LIMIT ?
  ) AS recent
  WHERE cf_scan_id IS NULL
    AND cf_verdict IS NULL
    AND malicious_url IS NOT NULL
  ORDER BY
    CASE WHEN target_brand_id IS NOT NULL THEN 0 ELSE 1 END,
    CASE WHEN threat_type = 'phishing' THEN 0
         WHEN threat_type = 'typosquatting' THEN 1
         WHEN threat_type = 'c2' THEN 2
         ELSE 3 END,
    created_at DESC
  LIMIT ?`;

/**
 * A scan still without a verdict this many days after it could have been
 * submitted is given up on (cf_verdict = 'expired'). Cloudflare scans finish
 * in minutes, so a day is generous; a longer window lets a handful of stuck
 * scans fill every oldest-first poll slot and delay all newer verdicts.
 */
export const CF_SCAN_PENDING_EXPIRE_DAYS = 1;

/**
 * Phase 2 pending-verdict read (partial index idx_threats_cf_scan; the sort
 * is a temp B-tree over the small pending set). Oldest first, so a scan
 * that never returns a verdict reaches the head of the queue and is expired
 * (see CF_SCAN_PENDING_EXPIRE_DAYS) instead of permanently holding one of
 * the CF_SCAN_POLL_LIMIT slots. Without an ORDER BY, >100 stuck scans could
 * starve every newer one. Newest-first would starve the stuck ones instead,
 * so they would never be seen to expire.
 *
 * `+created_at` (the same unary-plus pin as `ORDER BY +threat_count` in
 * lib/cluster-status.ts readers) stops the planner from walking a created_at
 * index to satisfy the ORDER BY — with stats where most rows look pending it
 * chose `SCAN threats USING INDEX idx_threats_created_brand`, a full index
 * walk. A Postgres port drops the `+` (no unary + on timestamps) and relies
 * on a partial index there.
 */
export const CF_SCAN_PENDING_SQL = `
  SELECT id, cf_scan_id, created_at FROM threats
   WHERE cf_scan_id IS NOT NULL AND cf_verdict IS NULL
   ORDER BY +created_at ASC
   LIMIT ?`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const SCAN_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

/**
 * The scan id from a submit 2xx body. v2 (`POST /v2/scan`) returns it
 * top-level: `{ uuid, api, visibility, url, message, result: "<report URL>" }`
 * (`result` is a string there). The v1 envelope `{ success: true, result:
 * { uuid } }` is still accepted. Anything else → null.
 */
export function parseSubmitUuid(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.uuid === "string" && SCAN_ID_RE.test(body.uuid)) return body.uuid;
  if (body.success === true && isRecord(body.result)) {
    const legacy = body.result.uuid;
    if (typeof legacy === "string" && SCAN_ID_RE.test(legacy)) return legacy;
  }
  return null;
}

/** Cloudflare's error text from a non-2xx body (v4 `errors[]` or top-level fields), truncated. */
export function cfErrorMessage(raw: string, max = 200): string {
  let msg = "";
  try {
    const body: unknown = JSON.parse(raw);
    if (isRecord(body)) {
      const errs = Array.isArray(body.errors) ? body.errors : [];
      const parts: string[] = [];
      for (const e of errs) {
        if (!isRecord(e)) continue;
        for (const k of ["message", "title", "detail"] as const) {
          if (typeof e[k] === "string" && e[k]) { parts.push(e[k] as string); break; }
        }
      }
      if (parts.length === 0) {
        for (const k of ["message", "title", "description", "error"] as const) {
          if (typeof body[k] === "string" && body[k]) { parts.push(body[k] as string); break; }
        }
      }
      msg = parts.join("; ");
    }
  } catch { /* not JSON — fall back to the raw text */ }
  if (!msg) msg = raw;
  msg = msg.replace(/\s+/g, " ").trim();
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

export type CfScanResult =
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "verdict"; malicious: boolean; categories: string[]; ip: string | null; country: string | null };

/**
 * An address safe to COALESCE into threats.ip_address: a strict IPv4 / IPv6
 * (the abuse-mailbox validators), never an unspecified all-zero address
 * ("::", "0.0.0.0") — a junk value there would block DNS resolution.
 */
export function isStorableIp(ip: string): boolean {
  if (!(isValidIPv4(ip) || isValidIPv6(ip))) return false;
  return !/^[0:.]+$/.test(ip);
}

/**
 * A result 200 body → pending / failed / verdict. v2 (`GET /v2/result/{uuid}`)
 * is top-level `{ task, page, verdicts, … }`; the v1 envelope
 * `{ success, result: { scan: { verdicts, page } } }` is still accepted.
 *
 * - `task.status` present and not `Finished` → pending (the expiry window
 *   bounds a scan that never finishes).
 * - `task.success === false`, no `verdicts`, or `verdicts.overall.malicious`
 *   not a boolean → failed (no confidence / status change). Only an explicit
 *   `malicious === false` is clean: clean can auto-remediate a threat, so a
 *   malformed or changed response must never read as clean.
 * - `page.country` is stored only when it is a 2-letter code (the docs call
 *   it a country name in places), `page.ip` only when `isStorableIp`.
 */
export function parseScanResult(body: unknown): CfScanResult {
  if (!isRecord(body)) return { kind: "failed" };
  let scan: Record<string, unknown> = body;
  if (!("verdicts" in body) && !("task" in body) && "success" in body) {
    // v1 envelope.
    const result = isRecord(body.result) ? body.result : null;
    const legacyScan = result && isRecord(result.scan) ? result.scan : null;
    if (body.success !== true || !legacyScan) return { kind: "failed" };
    scan = legacyScan;
  }
  const task = isRecord(scan.task) ? scan.task : null;
  if (task) {
    const st = typeof task.status === "string" ? task.status.trim().toLowerCase() : "";
    if (st !== "" && st !== "finished") return { kind: "pending" };
    if (task.success === false) return { kind: "failed" };
  }
  const verdicts = isRecord(scan.verdicts) ? scan.verdicts : null;
  const overall = verdicts && isRecord(verdicts.overall) ? verdicts.overall : null;
  if (!overall || typeof overall.malicious !== "boolean") return { kind: "failed" };
  const categories = Array.isArray(overall.categories)
    ? overall.categories.filter((c): c is string => typeof c === "string" && c.length > 0)
    : [];
  const page = isRecord(scan.page) ? scan.page : {};
  const rawIp = typeof page.ip === "string" ? page.ip.trim() : "";
  const cc = typeof page.country === "string" ? page.country.trim().toUpperCase() : "";
  return {
    kind: "verdict",
    malicious: overall.malicious,
    categories,
    ip: rawIp && isStorableIp(rawIp) ? rawIp : null,
    country: /^[A-Z]{2}$/.test(cc) ? cc : null,
  };
}

/**
 * Submit statuses where Cloudflare refuses this URL for good (unresolvable /
 * blocked / invalid). 409 is NOT terminal: its v2 meaning is undocumented and
 * plausibly "already scanned / in progress" (several threats can share one
 * malicious_url), so it is an ordinary error and the row stays a candidate.
 */
const TERMINAL_SUBMIT_STATUSES = new Set([400, 422]);

/**
 * Systemic-rejection guard: the first SYSTEMIC_REJECTION_SAMPLE terminal
 * rejections of a run are held, not retired. If they all carry the same
 * status + message, the rejection is about our request (body shape, a CF
 * validation change), not the URLs: nothing is retired, they count as
 * errors and submitting stops for the run. Otherwise they are retired and
 * later rejections retire at once.
 */
export const SYSTEMIC_REJECTION_SAMPLE = 3;

interface FirstError { status: number; message: string }

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
    // 404 = no such scan / still in progress; any other non-2xx is reported
    // by the caller (first error lands in the run diagnostic).
    if (!res.ok) return { parsed: null, raw, status: res.status };
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

/** Throws unless the token can use the URL Scanner API: one probe request, every run. */
async function assertScannerAccess(
  accountId: string,
  token: string,
  tokenName: ScannerTokenName,
): Promise<void> {
  const { status, raw } = await cfFetch<unknown>(accountId, token, CF_AUTH_PROBE_PATH);
  if (isAuthStatus(status)) throw new CfScannerAuthError(status, tokenName);
  // 2xx / 404 (no such scan) / other 4xx = the token got past auth.
  // 429, 5xx and network errors (0) mean the API is unusable right now:
  // fail the pull (breaker backoff).
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
    await assertScannerAccess(accountId, token, tokenName);

    // Threats are core-DB rows; one handle for every read and write below.
    const db = ctx.env.DB;

    let submitted = 0, rejected = 0, collected = 0, errors = 0, maliciousCount = 0;
    let firstSubmitError: FirstError | null = null;
    let firstSubmitRejection: FirstError | null = null;
    let firstPollError: FirstError | null = null;
    let quotaHit = false;

    // ─── Phase 1: SUBMIT recent unscanned URLs ───────────────────
    const windowStart = toSqliteDatetime(new Date(Date.now() - CF_SCAN_WINDOW_DAYS * 86_400_000));
    const toScan = await db.prepare(CF_SCAN_CANDIDATES_SQL)
      .bind(windowStart, CF_SCAN_CANDIDATE_CAP, CF_SCAN_SUBMIT_LIMIT)
      .all<{ id: string; malicious_url: string }>();

    // Filter out threats whose URL domain is in the safe domain allowlist.
    // The allowlist is only loaded when there is something to submit.
    const safeSet = toScan.results.length > 0 ? await loadSafeDomainSet(db) : new Set<string>();
    const filteredToScan = toScan.results.filter((row) => {
      try {
        const domain = new URL(row.malicious_url).hostname;
        if (isSafeDomain(domain, safeSet)) {
          return false;
        }
      } catch {
        // Unparseable URL: let Cloudflare judge it (a 400 retires it).
      }
      return true;
    });

    const retireRejected = async (id: string): Promise<void> => {
      await db.prepare(
        "UPDATE threats SET cf_verdict = 'failed' WHERE id = ? AND cf_scan_id IS NULL AND cf_verdict IS NULL",
      ).bind(id).run();
      rejected++;
    };
    let heldRejections: Array<{ id: string; status: number; message: string }> | null = [];
    let systemicRejection: FirstError | null = null;

    let first = true;
    for (const row of filteredToScan) {
      const { parsed, raw, status } = await cfFetch<unknown>(accountId, token, "/v2/scan", {
        method: "POST",
        body: JSON.stringify({ url: row.malicious_url, visibility: "Unlisted" }),
      });

      // The probe only proves read access; submitting needs Edit. A 401/403
      // on the first submit fails the pull the same way.
      if (first) {
        first = false;
        if (isAuthStatus(status)) throw new CfScannerAuthError(status, tokenName);
      }

      const uuid = status >= 200 && status < 300 ? parseSubmitUuid(parsed) : null;
      if (uuid) {
        const updateResult = await db.prepare(
          "UPDATE threats SET cf_scan_id = ? WHERE id = ?",
        ).bind(uuid, row.id).run();

        if (updateResult.meta.changes === 0) {
          errors++;
          firstSubmitError ??= { status, message: `cf_scan_id UPDATE changed 0 rows for ${row.id}` };
        } else {
          submitted++;
        }
      } else if (TERMINAL_SUBMIT_STATUSES.has(status)) {
        // Cloudflare refuses this URL (unresolvable / blocked / invalid):
        // retire it so it is never resubmitted (the candidate read skips
        // rows with a verdict; cf_scan_id stays NULL, so Phase 2 never sees
        // it) — unless the systemic-rejection guard trips.
        const rejection = { status, message: cfErrorMessage(raw) };
        firstSubmitRejection ??= rejection;
        if (heldRejections) {
          heldRejections.push({ id: row.id, ...rejection });
          if (heldRejections.length >= SYSTEMIC_REJECTION_SAMPLE) {
            const head = heldRejections[0]!;
            if (heldRejections.every((r) => r.status === head.status && r.message === head.message)) {
              errors += heldRejections.length;
              systemicRejection = { status: head.status, message: head.message };
              heldRejections = null;
              break;
            }
            for (const held of heldRejections) await retireRejected(held.id);
            heldRejections = null;
          }
        } else {
          await retireRejected(row.id);
        }
      } else {
        errors++;
        firstSubmitError ??= {
          status,
          message: status >= 200 && status < 300 ? `no scan uuid in response: ${cfErrorMessage(raw)}` : cfErrorMessage(raw),
        };
        if (status === 429) {
          // Quota / rate limit: every further submit this run would fail too.
          quotaHit = true;
          break;
        }
      }

      // Brief pause between submissions
      await new Promise((r) => setTimeout(r, 200));
    }

    // Fewer than SYSTEMIC_REJECTION_SAMPLE rejections this run: too few to
    // call systemic, so retire them (at most SAMPLE - 1 rows).
    if (heldRejections) {
      for (const held of heldRejections) await retireRejected(held.id);
      heldRejections = null;
    }

    // ─── Phase 2: COLLECT results ────────────────────────────────
    const pending = await db.prepare(CF_SCAN_PENDING_SQL)
      .bind(CF_SCAN_POLL_LIMIT)
      .all<{ id: string; cf_scan_id: string; created_at: string }>();

    // Threats are submitted within CF_SCAN_WINDOW_DAYS of creation, so one
    // created before this has been pending > CF_SCAN_PENDING_EXPIRE_DAYS.
    const expireBefore = toSqliteDatetime(
      new Date(Date.now() - (CF_SCAN_WINDOW_DAYS + CF_SCAN_PENDING_EXPIRE_DAYS) * 86_400_000),
    );
    let expired = 0, stillPending = 0, failed = 0;
    let firstPoll = true;
    for (const row of pending.results) {
      if (row.created_at < expireBefore) {
        await db.prepare(
          "UPDATE threats SET cf_verdict = 'expired' WHERE id = ? AND cf_verdict IS NULL",
        ).bind(row.id).run();
        expired++;
        continue;
      }
      const { parsed, raw, status } = await cfFetch<unknown>(accountId, token, `/v2/result/${encodeURIComponent(row.cf_scan_id)}`);

      // Same rule as the first submit: a 401/403 here is an auth failure
      // (e.g. the token was revoked mid-run), not a per-scan error.
      if (firstPoll) {
        firstPoll = false;
        if (isAuthStatus(status)) throw new CfScannerAuthError(status, tokenName);
      }

      if (status === 404) {
        // v2: the scan is still running. Not an error; expiry handles a
        // scan that never finishes.
        stillPending++;
        continue;
      }
      if (status < 200 || status >= 300 || parsed === null) {
        errors++;
        firstPollError ??= { status, message: cfErrorMessage(raw) };
        if (status === 429) break;
        continue;
      }

      const res = parseScanResult(parsed);
      if (res.kind === "pending") {
        stillPending++;
        continue;
      }
      if (res.kind === "failed") {
        // A finished scan with no usable verdict (dead URL, blocked fetch,
        // DNS error): retire it now so it can't hold a poll slot.
        failed++;
        await db.prepare(
          "UPDATE threats SET cf_verdict = 'failed' WHERE id = ? AND cf_verdict IS NULL",
        ).bind(row.id).run();
        continue;
      }

      const isMalicious = res.malicious;
      const verdict = isMalicious ? "malicious" : "clean";
      if (isMalicious) maliciousCount++;

      // Update threat with verdict and adjust confidence + auto-remediate
      await db.prepare(
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
        res.categories.length > 0 ? JSON.stringify(res.categories) : null,
        isMalicious ? 1 : 0,
        isMalicious ? 1 : 0,
        isMalicious ? 1 : 0,
        row.id,
      ).run();

      collected++;

      // If CF provides hosting IP/country, update if missing
      if (res.ip || res.country) {
        try {
          await db.prepare(
            `UPDATE threats SET
              ip_address = COALESCE(ip_address, ?),
              country_code = COALESCE(country_code, ?)
            WHERE id = ? AND (ip_address IS NULL OR country_code IS NULL)`,
          ).bind(res.ip, res.country, row.id).run();
        } catch { /* non-fatal */ }
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    if (firstSubmitError || firstPollError) {
      console.error(`[cf_scanner] run errors=${errors}`, { firstSubmitError, firstPollError });
    }

    // The one diagnostic per run: a summary of a run that got past the auth gate.
    const summary = `CF Scanner done: candidates=${toScan.results.length}, submitted=${submitted}, rejected=${rejected}, collected=${collected}, pending=${stillPending}, failed=${failed}, expired=${expired}, malicious=${maliciousCount}, errors=${errors}`;
    const details = JSON.stringify({
      candidates: toScan.results.length,
      submitted,
      rejected,
      collected,
      pending: stillPending,
      failed,
      expired,
      malicious: maliciousCount,
      errors,
      quota_hit: quotaHit,
      systemic_rejection: systemicRejection,
      first_submit_error: firstSubmitError,
      first_submit_rejection: firstSubmitRejection,
      first_poll_error: firstPollError,
    });
    try {
      await (await agentOutputsStore(ctx.env)).prepare(
        "INSERT INTO agent_outputs (id, agent_id, type, summary, details, created_at) VALUES (?, 'sentinel', 'diagnostic', ?, ?, datetime('now'))"
      ).bind('diag_cf_done_' + Date.now(), summary, details).run();
    } catch { /* non-fatal */ }

    return {
      itemsFetched: toScan.results.length + pending.results.length,
      itemsNew: collected,
      itemsDuplicate: 0,
      itemsError: errors,
    };
  },
};
