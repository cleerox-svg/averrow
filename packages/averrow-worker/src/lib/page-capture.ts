// Averrow — Phishing page capture pipeline
// (docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md).
//
// Renders suspected fake login pages in Cloudflare Browser Rendering and
// stores a desktop + mobile screenshot, the rendered HTML and a meta.json in
// the private R2 bucket `averrow-phish-captures` (binding PHISH_CAPTURES),
// with the SHA-256 of every object in D1 (`page_captures`, migration 0290).
//
// Pieces (all SQL lives here — agents/pageCapture.ts is a thin wrapper):
//   * enqueue  — `enqueueAutoCaptures` (IdP tagging call sites; cheap,
//                best-effort, never touches the browser) and
//                `enqueueManualCapture` (POST …/capture).
//   * claim    — `claimCaptures`: queued → capturing, attempts+1.
//   * reaper   — `reapStuckCaptures`: capturing > 15 min → queued, or
//                failed at the attempt cap; stale queued (> 7 d) → failed.
//   * capture  — `capturePage` through an injectable `CaptureDriver`
//                (lib/page-capture-browser.ts is the puppeteer one), behind
//                the SSRF guard (`assertResolvedHostSafe`).
//   * store    — `storeCapture`: R2 objects + hashes + meta.json.
//   * sweep    — `sweepExpiredCaptures`: once per UTC day, rows past
//                `expires_at` → expired, keys nulled, objects deleted.
//   * evidence — `linkCaptureEvidence`: takedown_evidence + screenshot_url.
//
// Security contract: navigation only (the driver never clicks, types or
// submits), non-http(s) navigations and private/loopback targets refused at
// every hop, downloads denied, a hard per-page timeout, HTML capped at 2 MB.
// Objects are only ever served back through the staff API
// (handlers/pageCaptures.ts) — never a public URL.

import { assertResolvedHostSafe, CHALLENGE_PHRASES, defaultResolve, type FetchDeps } from "./page-fetch";
import type { Env } from "../types";

// ─── Tunables ────────────────────────────────────────────────────────

// Rows claimed per cron run (≈720/day max on the every-10-minutes cron).
// Tune down if Browser Rendering spend rises (spec "Risks").
export const CAPTURE_BATCH = 5;
/** Hard per-page wall-clock limit (navigation + both screenshots + HTML). */
export const CAPTURE_PAGE_TIMEOUT_MS = 20_000;
/** Total run budget; rows not started by then are released back to queued. */
export const CAPTURE_RUN_BUDGET_MS = 240_000;
/** Attempts before a row is parked as failed. */
export const CAPTURE_MAX_ATTEMPTS = 3;
/** A `capturing` row older than this is presumed orphaned (worker killed). */
export const CAPTURE_STUCK_MINUTES = 15;
/** A `queued` row never claimed within this window is parked as failed —
 *  the claim order is newest-first, and most phishing pages are dead by then. */
export const CAPTURE_STALE_QUEUE_DAYS = 7;
/** Evidence retention (owner decision 2026-10-12); R2 lifecycle matches. */
export const CAPTURE_RETENTION_DAYS = 180;
/** Rendered-HTML cap. */
export const CAPTURE_HTML_MAX_BYTES = 2 * 1024 * 1024;
/** Auto-enqueue skips a target_key captured within this window. */
export const CAPTURE_TARGET_DEDUP_DAYS = 7;
/** Captures per run for any NON-cron dispatch (internal /run endpoint,
 *  Flight Control recovery) — those run inside ctx.waitUntil, so they must
 *  finish well within its budget. The cron path uses CAPTURE_BATCH. */
export const CAPTURE_NON_CRON_LIMIT = 1;
/** Unique hosts a single page may contact (navigations + sub-resources).
 *  Beyond this every request to a NEW host is aborted (fail closed) so one
 *  page can't burn the Worker's subrequest budget on DoH lookups. */
export const CAPTURE_MAX_HOSTS_PER_PAGE = 40;
/** page_capture_targets aliases older than this are purged by the sweep
 *  (> the 7-day dedup window + the 7-day stale-queue window). */
const TARGET_ALIAS_RETENTION_DAYS = 14;
/** Max alias threats whose takedowns one capture is linked to. */
const MAX_LINKED_THREATS = 200;
/** Detail endpoint: newest N captures per threat. */
export const CAPTURE_DETAIL_LIMIT = 5;
/** Sweep: rows per round / rounds per run. */
const SWEEP_PAGE = 90;
const SWEEP_MAX_ROUNDS = 10;
const MAX_TARGET_URL_LENGTH = 2048;
const MAX_CHAIN = 20;
const MAX_FORM_HOSTS = 20;
const MAX_TITLE = 512;
const MAX_ERROR = 500;
/** D1 caps a statement at 100 bound parameters. */
const ENQUEUE_CHUNK = 50;

/** Note stored in page_captures.error on a successful capture that hit the
 *  per-page host cap (status stays captured/blocked). */
export const HOST_CAP_NOTE = `host cap reached: page contacted more than ${CAPTURE_MAX_HOSTS_PER_PAGE} hosts; further new-host requests were blocked`;

export const CAPTURE_PIPELINE_VERSION = "page-capture/1";
export const SWEEP_STAMP_PREFIX = "page_capture:sweep:";

export const DESKTOP_VIEWPORT = { width: 1366, height: 900 } as const;
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

export const CAPTURE_STATUSES = ["queued", "capturing", "captured", "failed", "blocked", "expired"] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/** Opaque capture id: `pc_` + UUID. Validated on every route. */
export const CAPTURE_ID_PATTERN = /^pc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newCaptureId(): string {
  return `pc_${crypto.randomUUID()}`;
}

/** D1 / SQLite `datetime('now')` shape for a JS Date. */
export function d1Ts(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function clip(s: string | null | undefined, n: number): string | null {
  if (s === null || s === undefined) return null;
  return s.length > n ? s.slice(0, n) : s;
}

// ─── Target URL ──────────────────────────────────────────────────────

/** The URL to render for a threat: its http(s) `malicious_url`, else
 *  `https://<malicious_domain>/`. Null when neither is usable. */
export function captureTargetUrl(maliciousUrl: string | null | undefined, maliciousDomain: string | null | undefined): string | null {
  if (maliciousUrl) {
    try {
      const u = new URL(maliciousUrl);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname && maliciousUrl.length <= MAX_TARGET_URL_LENGTH) {
        return u.toString();
      }
    } catch { /* fall through to the domain */ }
  }
  const d = (maliciousDomain ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!d || /[\s/\\?#@]/.test(d)) return null;
  try {
    const u = new URL(`https://${d}/`);
    return u.hostname ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Normalized dedup key for a target URL: lowercased host + path (no
 *  scheme, port, query or fragment — per-victim tokens in the query string
 *  don't make a different page). Null when unparseable. */
export function captureTargetKey(targetUrl: string): string | null {
  try {
    const u = new URL(targetUrl);
    if (!u.hostname) return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`.slice(0, MAX_TARGET_URL_LENGTH);
  } catch {
    return null;
  }
}

// ─── Enqueue ─────────────────────────────────────────────────────────

export interface AutoCaptureItem {
  threatId: string;
  maliciousUrl?: string | null;
  maliciousDomain?: string | null;
}

/**
 * Automatic enqueue for one threat — ONE statement, two indexed probes:
 *   - the threat has NEVER had a capture row (idx_page_captures_threat_created).
 *     Feed writers re-see the same threats on every pull, so an "only if no
 *     OPEN row" guard would re-capture every re-pulled threat; re-capturing
 *     an already-captured page is a manual action;
 *   - no row for the same normalized target (`target_key`) was created in
 *     the last CAPTURE_TARGET_DEDUP_DAYS (idx_page_captures_target_created),
 *     so one page reported under several threat ids (CertStream duplicates
 *     across CT logs, multi-feed hits) is rendered once.
 * The partial unique index (one open row per threat) still backstops races —
 * hence INSERT OR IGNORE. 9 binds.
 */
export function enqueueAutoCaptureStmt(
  db: D1Database,
  threatId: string,
  targetUrl: string,
  now: Date = new Date(),
): D1PreparedStatement {
  const ts = d1Ts(now);
  const key = captureTargetKey(targetUrl) ?? targetUrl;
  const dedupSince = d1Ts(addDays(now, -CAPTURE_TARGET_DEDUP_DAYS));
  return db.prepare(
    `INSERT OR IGNORE INTO page_captures (id, threat_id, target_url, target_key, status, attempts, queued_at, created_at)
     SELECT ?, ?, ?, ?, 'queued', 0, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM page_captures WHERE threat_id = ?)
        AND NOT EXISTS (SELECT 1 FROM page_captures WHERE target_key = ? AND created_at >= ?)`,
  ).bind(newCaptureId(), threatId, targetUrl, key, ts, ts, threatId, key, dedupSince);
}

/** Record that `threatId` was reported for `targetKey` — whether or not the
 *  dedup let it enqueue — so the capture's evidence reaches its takedowns. */
export function targetAliasStmt(db: D1Database, targetKey: string, threatId: string, now: Date = new Date()): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO page_capture_targets (target_key, threat_id, created_at) VALUES (?, ?, ?)`,
  ).bind(targetKey, threatId, d1Ts(now));
}

/**
 * Best-effort batch enqueue from the IdP tagging call sites. One INSERT per
 * tagged threat (rare — IdP-family hits only), chunked into `db.batch`.
 * Never throws and never awaits the browser: a failure here must not break
 * ingestion (the internal backfill route re-covers the last 7 days).
 * Returns the number of rows actually queued.
 */
export async function enqueueAutoCaptures(
  db: D1Database,
  items: AutoCaptureItem[],
  now: Date = new Date(),
): Promise<number> {
  // Pairs of [alias, enqueue|null] so the queued count reads only enqueues.
  const stmts: D1PreparedStatement[] = [];
  const isEnqueue: boolean[] = [];
  const seen = new Set<string>();
  const seenKeys = new Set<string>();
  for (const it of items) {
    if (!it.threatId || seen.has(it.threatId)) continue;
    const url = captureTargetUrl(it.maliciousUrl, it.maliciousDomain);
    if (!url) continue;
    const key = captureTargetKey(url) ?? url;
    seen.add(it.threatId);
    // Alias always (PK insert) — a deduped threat still gets the evidence.
    stmts.push(targetAliasStmt(db, key, it.threatId, now));
    isEnqueue.push(false);
    // In-call dedup mirrors the SQL guards (and spares the statement).
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    stmts.push(enqueueAutoCaptureStmt(db, it.threatId, url, now));
    isEnqueue.push(true);
  }
  let queued = 0;
  for (let i = 0; i < stmts.length; i += ENQUEUE_CHUNK) {
    try {
      const res = await db.batch(stmts.slice(i, i + ENQUEUE_CHUNK));
      res.forEach((r, k) => { if (isEnqueue[i + k]) queued += r.meta?.changes ?? 0; });
    } catch (err) {
      console.warn(`[page-capture] auto-enqueue chunk failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return queued;
}

/**
 * Manual "Capture now". Inserts only when the threat has no OPEN
 * (queued|capturing) row. Returns the new id, or null when one is already
 * open (→ 409).
 */
export async function enqueueManualCapture(
  db: D1Database,
  threatId: string,
  targetUrl: string,
  requestedBy: string,
  now: Date = new Date(),
): Promise<string | null> {
  const id = newCaptureId();
  const ts = d1Ts(now);
  const res = await db.prepare(
    `INSERT OR IGNORE INTO page_captures (id, threat_id, target_url, target_key, status, attempts, requested_by, queued_at, created_at)
     SELECT ?, ?, ?, ?, 'queued', 0, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM page_captures
                         WHERE threat_id = ? AND status IN ('queued', 'capturing'))`,
  ).bind(id, threatId, targetUrl, captureTargetKey(targetUrl) ?? targetUrl, requestedBy, ts, ts, threatId).run();
  return (res.meta?.changes ?? 0) > 0 ? id : null;
}

// ─── Claim / reap / release ──────────────────────────────────────────

export interface ClaimedCapture {
  id: string;
  threat_id: string | null;
  target_url: string;
  attempts: number;
  requested_by: string | null;
  queued_at: string;
  target_key: string | null;
}

/**
 * Atomically move up to `limit` queued rows to `capturing` (attempts+1).
 * Manual requests first, then newest first (phishing pages die fast).
 */
export async function claimCaptures(db: D1Database, limit: number, now: Date = new Date()): Promise<ClaimedCapture[]> {
  const res = await db.prepare(
    `UPDATE page_captures
        SET status = 'capturing', attempts = attempts + 1, claimed_at = ?
      WHERE status = 'queued'
        AND id IN (SELECT id FROM page_captures
                    WHERE status = 'queued'
                    ORDER BY (requested_by IS NULL), queued_at DESC
                    LIMIT ?)
      RETURNING id, threat_id, target_url, attempts, requested_by, queued_at, target_key`,
  ).bind(d1Ts(now), limit).all<ClaimedCapture>();
  return res.results ?? [];
}

export interface ReapResult {
  requeued: number;
  failed: number;
  stale: number;
}

/** Orphaned `capturing` rows → queued (or failed at the attempt cap);
 *  never-claimed `queued` rows older than CAPTURE_STALE_QUEUE_DAYS → failed. */
export async function reapStuckCaptures(db: D1Database, now: Date = new Date()): Promise<ReapResult> {
  const stuckBefore = d1Ts(new Date(now.getTime() - CAPTURE_STUCK_MINUTES * 60_000));
  const staleBefore = d1Ts(addDays(now, -CAPTURE_STALE_QUEUE_DAYS));
  const [capped, requeued, stale] = await db.batch([
    db.prepare(
      `UPDATE page_captures
          SET status = 'failed', claimed_at = NULL,
              error = 'capture did not finish (attempt cap reached)'
        WHERE status = 'capturing' AND claimed_at < ? AND attempts >= ?`,
    ).bind(stuckBefore, CAPTURE_MAX_ATTEMPTS),
    db.prepare(
      `UPDATE page_captures
          SET status = 'queued', claimed_at = NULL,
              error = 'capture did not finish; re-queued'
        WHERE status = 'capturing' AND claimed_at < ? AND attempts < ?`,
    ).bind(stuckBefore, CAPTURE_MAX_ATTEMPTS),
    db.prepare(
      `UPDATE page_captures
          SET status = 'failed', error = ?
        WHERE status = 'queued' AND queued_at < ?`,
    ).bind(`not captured within ${CAPTURE_STALE_QUEUE_DAYS} days of queueing`, staleBefore),
  ]);
  return {
    failed: capped?.meta?.changes ?? 0,
    requeued: requeued?.meta?.changes ?? 0,
    stale: stale?.meta?.changes ?? 0,
  };
}

/** Put a claimed-but-never-started row back (run budget exhausted, or the
 *  browser session could not be opened) without spending an attempt. */
export async function releaseCaptures(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(ids.map((id) => db.prepare(
    `UPDATE page_captures
        SET status = 'queued', claimed_at = NULL, attempts = MAX(attempts - 1, 0)
      WHERE id = ? AND status = 'capturing'`,
  ).bind(id)));
}

/** A capture attempt failed. Retryable errors go back to the queue until the
 *  attempt cap; policy refusals (SSRF guard) fail immediately. */
export async function failCapture(
  db: D1Database,
  row: Pick<ClaimedCapture, "id" | "attempts">,
  error: string,
  retryable: boolean,
): Promise<CaptureStatus> {
  const next: CaptureStatus = retryable && row.attempts < CAPTURE_MAX_ATTEMPTS ? "queued" : "failed";
  await db.prepare(
    `UPDATE page_captures SET status = ?, error = ?, claimed_at = NULL
      WHERE id = ? AND status = 'capturing'`,
  ).bind(next, clip(error, MAX_ERROR), row.id).run();
  return next;
}

// ─── Capture driver (injectable — puppeteer in prod, fake in tests) ──

/** `retryable` = transient (unresolvable / DNS miss) — the row goes back to
 *  the queue and spends an attempt; false = a real policy hit (private /
 *  loopback / blocked host, disallowed scheme) — failed, never retried. */
export type GuardVerdict = { ok: true } | { ok: false; reason: string; retryable: boolean };
/** Called by the driver for EVERY intercepted http(s) request (navigations
 *  incl. redirects + frames, and sub-resources) before it may continue.
 *  Accepted gap: WebSocket connections are not visible to request
 *  interception and are not guarded (the browser runs on Cloudflare's
 *  network, not ours, so this is not an internal-SSRF path). */
export type NavigationGuard = (url: string) => Promise<GuardVerdict>;

export interface CaptureRequest {
  targetUrl: string;
  timeoutMs: number;
  guard: NavigationGuard;
  /** Aborted when the hard per-page timeout fires — the driver must close
   *  the page so nothing keeps running into the next capture. */
  signal: AbortSignal;
}

export interface RawCapture {
  finalUrl: string | null;
  httpStatus: number | null;
  /** Main-frame navigation URLs in order (initial request first). */
  redirectChain: string[];
  title: string;
  /** Raw `<form action>` attribute values ('' for a missing action). */
  formActions: string[];
  /** Bounded visible-text sample (anti-bot / blank-page detection). */
  bodyText: string;
  html: string;
  desktopPng: Uint8Array | null;
  mobilePng: Uint8Array | null;
  /** Set when the guard refused a main-frame navigation hop. */
  blockedNavigation: string | null;
  /** The refusal above was transient (DNS miss), not a policy hit. */
  blockedRetryable?: boolean;
  /** The page hit CAPTURE_MAX_HOSTS_PER_PAGE; later new-host requests were
   *  aborted (recorded as a note in page_captures.error). */
  hostCapHit?: boolean;
}

export interface CaptureSession {
  capture(req: CaptureRequest): Promise<RawCapture>;
  close(): Promise<void>;
}

export interface CaptureDriver {
  open(): Promise<CaptureSession>;
}

/** The row left `capturing` while we worked (reaped) — nothing to update. */
export class CaptureSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureSupersededError";
  }
}

/** Thrown for policy refusals — never retried. */
export class CaptureRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureRefusedError";
  }
}

/** Scheme allow-list + static block-list + DoH-resolved IP check, shared
 *  with the page-fetch SSRF contract (lib/page-fetch.ts). */
export function makeNavigationGuard(resolve: FetchDeps["resolve"] = defaultResolve): NavigationGuard {
  const deps: FetchDeps = { resolve, fetchImpl: (url, init) => globalThis.fetch(url, init) };
  // Per-run caches (one guard per run). `verdicts` memoizes the outcome per
  // host — positive AND negative — so a page hammering an unresolvable or
  // blocked host costs one DoH lookup per run, not one per request. A DNS
  // miss is still retryable ACROSS runs (each run builds a fresh guard).
  const cache = new Map<string, string[]>();
  const verdicts = new Map<string, GuardVerdict>();
  return async (raw: string): Promise<GuardVerdict> => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, reason: "unparseable url", retryable: false };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: `disallowed scheme ${u.protocol}`, retryable: false };
    }
    const host = u.hostname;
    const memo = verdicts.get(host);
    if (memo) return memo;
    const check = await assertResolvedHostSafe(host, deps, cache);
    // assertResolvedHostSafe: blocked=true is a real policy hit (static
    // block-list / private / loopback resolved IP); blocked=false is a miss.
    const verdict: GuardVerdict = check.ok ? { ok: true } : { ok: false, reason: check.reason, retryable: !check.blocked };
    verdicts.set(host, verdict);
    return verdict;
  };
}

/** Per-page unique-host budget (fail closed past the cap). */
export interface PageHostBudget {
  /** True when `host` may be contacted (already seen, or under the cap). */
  admit(host: string): boolean;
  readonly capped: boolean;
  readonly hosts: number;
}

export function makePageHostBudget(max: number = CAPTURE_MAX_HOSTS_PER_PAGE): PageHostBudget {
  const seen = new Set<string>();
  let capped = false;
  return {
    admit(host: string): boolean {
      const h = host.toLowerCase();
      if (seen.has(h)) return true;
      if (seen.size >= max) {
        capped = true;
        return false;
      }
      seen.add(h);
      return true;
    },
    get capped() { return capped; },
    get hosts() { return seen.size; },
  };
}

// ─── Pure extraction ─────────────────────────────────────────────────

/** Hosts that `<form action>` values post to, resolved against the final
 *  URL (an empty action posts to the page itself). http(s) only. */
export function formActionHosts(actions: string[], baseUrl: string | null): string[] {
  const out: string[] = [];
  for (const a of actions) {
    if (out.length >= MAX_FORM_HOSTS) break;
    let host: string | null = null;
    try {
      const u = baseUrl ? new URL(a ?? "", baseUrl) : new URL(a);
      if (u.protocol === "http:" || u.protocol === "https:") host = u.hostname.toLowerCase();
    } catch {
      host = null;
    }
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

/** Anti-bot wall / cloaking: the shared CHALLENGE_PHRASES (bounded
 *  `.includes`, no regex over attacker text), or an empty decoy page. */
export function detectAntiBotWall(raw: Pick<RawCapture, "title" | "bodyText" | "formActions">): string | null {
  const t = raw.title.toLowerCase().slice(0, 1024);
  const b = raw.bodyText.toLowerCase().slice(0, 8192);
  for (const phrase of CHALLENGE_PHRASES) {
    if (t.includes(phrase) || b.includes(phrase)) return "cf_challenge";
  }
  if (b.trim() === "" && t.trim() === "" && raw.formActions.length === 0) return "blank_page";
  return null;
}

/** UTF-8 encode, capped at CAPTURE_HTML_MAX_BYTES. */
export function capHtml(html: string): { bytes: Uint8Array; truncated: boolean } {
  const all = new TextEncoder().encode(html);
  if (all.byteLength <= CAPTURE_HTML_MAX_BYTES) return { bytes: all, truncated: false };
  return { bytes: all.slice(0, CAPTURE_HTML_MAX_BYTES), truncated: true };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function captureKeyPrefix(captureId: string, capturedAt: Date): string {
  const yyyy = String(capturedAt.getUTCFullYear());
  const mm = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
  return `captures/${yyyy}/${mm}/${captureId}`;
}

/** Staff API paths (never public URLs). */
export function screenshotApiPath(captureId: string, variant: "desktop" | "mobile"): string {
  return `/api/intel/captures/${captureId}/screenshot?variant=${variant}`;
}
export function htmlApiPath(captureId: string): string {
  return `/api/intel/captures/${captureId}/html`;
}

// ─── Capture with hard timeout ───────────────────────────────────────

/** After a timeout, how long to wait for the driver to close the page. */
const CAPTURE_ABORT_GRACE_MS = 3_000;

/** Run one capture under a hard wall-clock limit. The driver's own timeouts
 *  are best-effort; this one always fires. */
export async function capturePage(
  session: CaptureSession,
  targetUrl: string,
  guard: NavigationGuard,
  timeoutMs: number = CAPTURE_PAGE_TIMEOUT_MS,
): Promise<RawCapture> {
  const pre = await guard(targetUrl);
  if (!pre.ok) {
    // A DNS miss is transient (re-queued, spends an attempt); a policy hit
    // is a refusal (failed, never retried).
    if (pre.retryable) throw new Error(`target unresolvable: ${pre.reason}`);
    throw new CaptureRefusedError(`refused target: ${pre.reason}`);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = session.capture({ targetUrl, timeoutMs, guard, signal: controller.signal });
  // Swallow a late rejection after the timeout wins the race.
  const settled = work.then(() => undefined, () => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`capture timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (!controller.signal.aborted) {
      // Timeout (or failure): tell the driver to close the page, and give the
      // close a bounded moment to land before the next capture starts.
      controller.abort();
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settled, new Promise<void>((r) => { grace = setTimeout(r, CAPTURE_ABORT_GRACE_MS); })]);
      if (grace !== undefined) clearTimeout(grace);
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── Store ───────────────────────────────────────────────────────────

export interface StoredCapture {
  status: "captured" | "blocked";
  finalUrl: string | null;
  httpStatus: number | null;
  title: string | null;
  redirectChain: string[];
  formHosts: string[];
  antiBotWall: string | null;
  desktopKey: string | null;
  mobileKey: string | null;
  htmlKey: string | null;
  metaKey: string;
  metaSha: string;
  desktopSha: string | null;
  mobileSha: string | null;
  htmlSha: string | null;
  htmlBytes: number;
  capturedAt: Date;
  expiresAt: Date;
}

/** Write the objects + meta.json to R2 and finalize the D1 row. */
export async function storeCapture(
  env: Pick<Env, "DB"> & { PHISH_CAPTURES: R2Bucket },
  row: ClaimedCapture,
  raw: RawCapture,
  now: Date = new Date(),
): Promise<StoredCapture> {
  const prefix = captureKeyPrefix(row.id, now);
  const finalUrl = clip(raw.finalUrl, MAX_TARGET_URL_LENGTH);
  const formHosts = formActionHosts(raw.formActions, raw.finalUrl ?? row.target_url);
  const antiBotWall = detectAntiBotWall(raw);
  const chain = raw.redirectChain.slice(0, MAX_CHAIN).map((u) => u.slice(0, MAX_TARGET_URL_LENGTH));
  const title = clip(raw.title.trim(), MAX_TITLE);
  const html = capHtml(raw.html);
  const custom = { threat_id: row.threat_id ?? "", capture_id: row.id };

  const objects: Array<{ name: "desktop" | "mobile" | "html"; key: string; bytes: Uint8Array; contentType: string }> = [];
  if (raw.desktopPng && raw.desktopPng.byteLength > 0) {
    objects.push({ name: "desktop", key: `${prefix}/desktop.png`, bytes: raw.desktopPng, contentType: "image/png" });
  }
  if (raw.mobilePng && raw.mobilePng.byteLength > 0) {
    objects.push({ name: "mobile", key: `${prefix}/mobile.png`, bytes: raw.mobilePng, contentType: "image/png" });
  }
  // Stored as octet-stream: the bucket is never served directly, and the
  // staff download route forces an attachment regardless.
  objects.push({ name: "html", key: `${prefix}/page.html`, bytes: html.bytes, contentType: "application/octet-stream" });

  if (!objects.some((o) => o.name !== "html")) {
    throw new Error("browser returned no screenshot");
  }

  const hashes: Record<string, string> = {};
  for (const o of objects) {
    const sha = await sha256Hex(o.bytes);
    hashes[o.name] = sha;
    await env.PHISH_CAPTURES.put(o.key, o.bytes, {
      httpMetadata: { contentType: o.contentType },
      customMetadata: { ...custom, sha256: sha },
    });
  }

  const status: StoredCapture["status"] = antiBotWall ? "blocked" : "captured";
  const expiresAt = addDays(now, CAPTURE_RETENTION_DAYS);
  const key = (n: string): string | null => objects.find((o) => o.name === n)?.key ?? null;
  const meta = {
    capture_id: row.id,
    threat_id: row.threat_id,
    target_url: row.target_url,
    final_url: finalUrl,
    http_status: raw.httpStatus,
    redirect_chain: chain,
    form_action_hosts: formHosts,
    page_title: title,
    anti_bot_wall: antiBotWall,
    status,
    html_truncated: html.truncated,
    objects: Object.fromEntries(objects.map((o) => [o.name, { key: o.key, sha256: hashes[o.name], bytes: o.bytes.byteLength }])),
    user_agents: { desktop: DESKTOP_UA, mobile: MOBILE_UA },
    viewports: { desktop: DESKTOP_VIEWPORT, mobile: MOBILE_VIEWPORT },
    queued_at: row.queued_at,
    captured_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    attempt: row.attempts,
    engine: "cloudflare-browser-rendering",
    worker: "averrow",
    pipeline_version: CAPTURE_PIPELINE_VERSION,
  };
  const metaKey = `${prefix}/meta.json`;
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta, null, 2));
  const metaSha = await sha256Hex(metaBytes);
  await env.PHISH_CAPTURES.put(metaKey, metaBytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { ...custom, sha256: metaSha },
  });

  const stored: StoredCapture = {
    status,
    finalUrl,
    httpStatus: raw.httpStatus,
    title,
    redirectChain: chain,
    formHosts,
    antiBotWall,
    desktopKey: key("desktop"),
    mobileKey: key("mobile"),
    htmlKey: key("html"),
    metaKey,
    metaSha,
    desktopSha: hashes["desktop"] ?? null,
    mobileSha: hashes["mobile"] ?? null,
    htmlSha: hashes["html"] ?? null,
    htmlBytes: html.bytes.byteLength,
    capturedAt: now,
    expiresAt,
  };

  const upd = await env.DB.prepare(
    `UPDATE page_captures
        SET status = ?, final_url = ?, http_status = ?, page_title = ?,
            redirect_chain_json = ?, form_action_hosts_json = ?,
            desktop_key = ?, mobile_key = ?, html_key = ?,
            desktop_sha256 = ?, mobile_sha256 = ?, html_sha256 = ?, meta_sha256 = ?,
            html_bytes = ?, anti_bot_wall = ?, error = ?, claimed_at = NULL,
            captured_at = ?, expires_at = ?
      WHERE id = ? AND status = 'capturing'`,
  ).bind(
    stored.status, stored.finalUrl, stored.httpStatus, stored.title,
    JSON.stringify(stored.redirectChain), JSON.stringify(stored.formHosts),
    stored.desktopKey, stored.mobileKey, stored.htmlKey,
    stored.desktopSha, stored.mobileSha, stored.htmlSha, metaSha,
    stored.htmlBytes, stored.antiBotWall,
    raw.hostCapHit ? HOST_CAP_NOTE : null,
    d1Ts(now), d1Ts(expiresAt), row.id,
  ).run();
  if ((upd.meta?.changes ?? 0) === 0) {
    // The reaper took the row back mid-capture (it will be re-captured);
    // the objects written above are orphans the lifecycle rule deletes.
    throw new CaptureSupersededError(`capture ${row.id} was reaped while capturing`);
  }

  return stored;
}

// ─── Evidence linking ────────────────────────────────────────────────

type EvidenceSource = Pick<StoredCapture, "status" | "desktopKey" | "mobileKey" | "desktopSha" | "mobileSha" | "finalUrl" | "antiBotWall" | "htmlSha">;

/** The takedown_evidence payload for a stored capture (null when no
 *  screenshot was stored). Shared by the success-time linker and catch-up. */
function evidencePayload(captureId: string, stored: EvidenceSource):
  { apiPath: string; storageKey: string | null; metaJson: string; title: string } | null {
  const variant: "desktop" | "mobile" | null = stored.desktopKey ? "desktop" : stored.mobileKey ? "mobile" : null;
  if (!variant) return null;
  return {
    apiPath: screenshotApiPath(captureId, variant),
    storageKey: variant === "desktop" ? stored.desktopKey : stored.mobileKey,
    metaJson: JSON.stringify({
      capture_id: captureId,
      status: stored.status,
      final_url: stored.finalUrl,
      anti_bot_wall: stored.antiBotWall,
      sha256: { desktop: stored.desktopSha, mobile: stored.mobileSha, html: stored.htmlSha },
      html_url: htmlApiPath(captureId),
    }),
    title: stored.status === "blocked" ? "Page capture (anti-bot wall shown)" : "Page capture (rendered screenshot)",
  };
}

/**
 * Attach a stored capture to every takedown drafted from its threat — AND
 * from every other threat recorded for the same `target_key` in
 * page_capture_targets (threats the 7-day target dedup skipped; capped at
 * MAX_LINKED_THREATS) — `source_type='threat'`, partial index
 * idx_takedown_requests_threat_source:
 * one `takedown_evidence` row each (deterministic id → re-runs are no-ops)
 * and `takedown_requests.screenshot_url` when still NULL. The URL is the
 * staff API path, never a public URL. Returns evidence rows inserted.
 *
 * Takedowns drafted LATER (Sparrow), and threats deduped onto the target
 * after the capture finished, are linked by `catchUpCaptureEvidence`, which
 * every page_capture run executes before claiming.
 */
export async function linkCaptureEvidence(
  db: D1Database,
  captureId: string,
  threatId: string | null,
  stored: EvidenceSource,
  now: Date = new Date(),
  targetKey: string | null = null,
): Promise<number> {
  if (!threatId && !targetKey) return 0;
  const ev = evidencePayload(captureId, stored);
  if (!ev) return 0;
  const { apiPath, storageKey, metaJson, title } = ev;
  // The capturing threat + every alias threat for the target (PK range).
  const threatSet =
    `SELECT ? AS threat_id
      UNION
     SELECT threat_id FROM (SELECT threat_id FROM page_capture_targets WHERE target_key = ? LIMIT ?)`;
  const [ins] = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO takedown_evidence
         (id, takedown_id, evidence_type, title, storage_key, storage_url, metadata_json, created_at)
       SELECT 'tde_' || ? || '_' || tr.id, tr.id, 'screenshot', ?, ?, ?, ?, ?
         FROM takedown_requests tr
        WHERE tr.source_type = 'threat' AND tr.source_id IN (${threatSet})`,
    ).bind(captureId, title, storageKey, apiPath, metaJson, d1Ts(now), threatId, targetKey, MAX_LINKED_THREATS),
    db.prepare(
      `UPDATE takedown_requests SET screenshot_url = ?
        WHERE source_type = 'threat' AND source_id IN (${threatSet}) AND screenshot_url IS NULL`,
    ).bind(apiPath, threatId, targetKey, MAX_LINKED_THREATS),
  ]);
  return ins?.meta?.changes ?? 0;
}

// ─── Evidence catch-up ───────────────────────────────────────────────

/** Takedowns examined per catch-up pass (bounds the D1 reads per run). */
export const CATCHUP_SCAN = 200;
/** Takedowns linked per catch-up pass. */
export const CATCHUP_LINK = 50;
/** Only takedowns drafted in this window are considered. */
export const CATCHUP_WINDOW_DAYS = 14;
export const CATCHUP_CURSOR_KEY = "page_capture:catchup:cursor";

/**
 * Candidate takedowns: threat-sourced, no screenshot yet, drafted in the
 * window, keyset-walked newest → oldest from a KV cursor (wraps when the
 * window is exhausted) so every candidate is revisited without rescanning
 * the whole window each run. Range on the partial index
 * idx_takedown_requests_catchup (migration 0290). Per candidate, the newest
 * stored (captured|blocked — expired never) capture of its threat, directly
 * (idx_page_captures_threat_created) or via a target alias
 * (idx_page_capture_targets_threat → idx_page_captures_target_created).
 * `CROSS JOIN` pins the alias → capture join order and `+pc.status` keeps
 * the planner off the low-selectivity status indexes (which would walk every
 * stored capture per candidate).
 */
export const CATCHUP_SQL =
  `SELECT tr.id AS takedown_id, tr.created_at,
          COALESCE(
            (SELECT pc.id FROM page_captures pc
              WHERE pc.threat_id = tr.source_id AND +pc.status IN ('captured', 'blocked')
              ORDER BY pc.created_at DESC LIMIT 1),
            (SELECT pc.id FROM page_capture_targets pt
               CROSS JOIN page_captures pc ON pc.target_key = pt.target_key
              WHERE pt.threat_id = tr.source_id AND +pc.status IN ('captured', 'blocked')
              ORDER BY pc.created_at DESC LIMIT 1)
          ) AS capture_id
     FROM takedown_requests tr
    WHERE tr.source_type = 'threat' AND tr.screenshot_url IS NULL
      AND tr.created_at >= ?
      AND (tr.created_at < ? OR (tr.created_at = ? AND tr.id < ?))
    ORDER BY tr.created_at DESC, tr.id DESC
    LIMIT ?`;

export interface CatchUpResult {
  scanned: number;
  linked: number;
  wrapped: boolean;
}

export async function catchUpCaptureEvidence(
  env: Pick<Env, "DB" | "CACHE">,
  now: Date = new Date(),
): Promise<CatchUpResult> {
  const db = env.DB;
  const since = d1Ts(addDays(now, -CATCHUP_WINDOW_DAYS));
  // Cursor = "<created_at>|<id>" of the last takedown examined; "~" sorts
  // above every timestamp/id, i.e. "start from the newest".
  let curTs = "~";
  let curId = "~";
  try {
    const raw = await env.CACHE.get(CATCHUP_CURSOR_KEY);
    const sep = raw ? raw.indexOf("|") : -1;
    if (raw && sep > 0) { curTs = raw.slice(0, sep); curId = raw.slice(sep + 1); }
  } catch { /* start from the newest */ }

  const res = await db.prepare(CATCHUP_SQL)
    .bind(since, curTs, curTs, curId, CATCHUP_SCAN)
    .all<{ takedown_id: string; created_at: string; capture_id: string | null }>();
  const rows = res.results ?? [];
  const wrapped = rows.length < CATCHUP_SCAN;
  const last = rows[rows.length - 1];
  try {
    if (wrapped) await env.CACHE.delete(CATCHUP_CURSOR_KEY);
    else if (last) await env.CACHE.put(CATCHUP_CURSOR_KEY, `${last.created_at}|${last.takedown_id}`, { expirationTtl: CATCHUP_WINDOW_DAYS * 86_400 });
  } catch { /* best-effort */ }

  const matches = rows.filter((r): r is typeof r & { capture_id: string } => !!r.capture_id).slice(0, CATCHUP_LINK);
  if (matches.length === 0) return { scanned: rows.length, linked: 0, wrapped };

  const captureIds = [...new Set(matches.map((m) => m.capture_id))];
  const caps = await db.prepare(
    `SELECT id, status, desktop_key, mobile_key, desktop_sha256, mobile_sha256, html_sha256, final_url, anti_bot_wall
       FROM page_captures WHERE id IN (${captureIds.map(() => "?").join(", ")})`,
  ).bind(...captureIds).all<{
    id: string; status: "captured" | "blocked"; desktop_key: string | null; mobile_key: string | null;
    desktop_sha256: string | null; mobile_sha256: string | null; html_sha256: string | null;
    final_url: string | null; anti_bot_wall: string | null;
  }>();
  const byId = new Map((caps.results ?? []).map((c) => [c.id, c]));

  const ts = d1Ts(now);
  const stmts: D1PreparedStatement[] = [];
  for (const m of matches) {
    const c = byId.get(m.capture_id);
    const ev = c ? evidencePayload(c.id, {
      status: c.status, desktopKey: c.desktop_key, mobileKey: c.mobile_key,
      desktopSha: c.desktop_sha256, mobileSha: c.mobile_sha256, htmlSha: c.html_sha256,
      finalUrl: c.final_url, antiBotWall: c.anti_bot_wall,
    }) : null;
    if (!c || !ev) continue;
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO takedown_evidence
           (id, takedown_id, evidence_type, title, storage_key, storage_url, metadata_json, created_at)
         VALUES (?, ?, 'screenshot', ?, ?, ?, ?, ?)`,
      ).bind(`tde_${c.id}_${m.takedown_id}`, m.takedown_id, ev.title, ev.storageKey, ev.apiPath, ev.metaJson, ts),
      db.prepare(
        `UPDATE takedown_requests SET screenshot_url = ? WHERE id = ? AND screenshot_url IS NULL`,
      ).bind(ev.apiPath, m.takedown_id),
    );
  }
  let linked = 0;
  if (stmts.length > 0) {
    const out = await db.batch(stmts);
    for (let i = 1; i < out.length; i += 2) linked += out[i]?.meta?.changes ?? 0;
  }
  return { scanned: rows.length, linked, wrapped };
}

// ─── Retention sweep ─────────────────────────────────────────────────

export interface SweepResult {
  expired: number;
  objectsDeleted: number;
  ran: boolean;
}

function metaKeyFor(keys: Array<string | null>): string | null {
  const k = keys.find((x): x is string => !!x);
  if (!k) return null;
  const slash = k.lastIndexOf("/");
  return slash > 0 ? `${k.slice(0, slash)}/meta.json` : null;
}

/**
 * Rows past `expires_at` → `expired`, R2 keys nulled (hashes kept as the
 * evidence trail), objects deleted (belt-and-braces over the bucket's 180-day
 * lifecycle rule). Bounded: SWEEP_MAX_ROUNDS × SWEEP_PAGE rows per run.
 */
export async function sweepExpiredCaptures(
  db: D1Database,
  bucket: R2Bucket | undefined,
  now: Date = new Date(),
): Promise<SweepResult> {
  const cutoff = d1Ts(now);
  let expired = 0;
  let objectsDeleted = 0;
  for (let round = 0; round < SWEEP_MAX_ROUNDS; round++) {
    const res = await db.prepare(
      `SELECT id, desktop_key, mobile_key, html_key FROM page_captures
        WHERE status IN ('captured', 'blocked') AND expires_at < ?
        LIMIT ?`,
    ).bind(cutoff, SWEEP_PAGE).all<{ id: string; desktop_key: string | null; mobile_key: string | null; html_key: string | null }>();
    const rows = res.results ?? [];
    if (rows.length === 0) break;

    if (bucket) {
      const keys: string[] = [];
      for (const r of rows) {
        for (const k of [r.desktop_key, r.mobile_key, r.html_key, metaKeyFor([r.desktop_key, r.mobile_key, r.html_key])]) {
          if (k) keys.push(k);
        }
      }
      if (keys.length > 0) {
        try {
          await bucket.delete(keys);
          objectsDeleted += keys.length;
        } catch (err) {
          // The lifecycle rule still deletes them; D1 is marked regardless
          // so the API stops pointing at objects that are going away.
          console.warn(`[page-capture] sweep R2 delete failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const ids = rows.map((r) => r.id);
    // Retention covers the captured page's content too: URL, chain, title
    // and form hosts can carry victim identifiers. Hashes stay (evidence
    // trail without content).
    const upd = await db.prepare(
      `UPDATE page_captures
          SET status = 'expired', desktop_key = NULL, mobile_key = NULL, html_key = NULL,
              final_url = NULL, redirect_chain_json = NULL, page_title = NULL,
              form_action_hosts_json = NULL
        WHERE status IN ('captured', 'blocked') AND id IN (${ids.map(() => "?").join(", ")})`,
    ).bind(...ids).run();
    expired += upd.meta?.changes ?? 0;

    // Every takedown this capture was linked to — the capturing threat's,
    // alias threats', catch-up links — has a takedown_evidence row with the
    // deterministic id 'tde_<capture_id>_<takedown_id>' (PK range per
    // capture). Per capture, in order: (1) clear screenshot_url on exactly
    // those takedowns when it still points at THIS capture (PK lookups, 4
    // binds); (2) tombstone the evidence rows (metadata carried final_url /
    // API paths) and null their links.
    await db.batch(ids.flatMap((cid) => [
      db.prepare(
        `UPDATE takedown_requests SET screenshot_url = NULL
          WHERE id IN (SELECT takedown_id FROM takedown_evidence WHERE id > ? AND id < ?)
            AND screenshot_url IN (?, ?)`,
      ).bind(`tde_${cid}_`, `tde_${cid}\``, screenshotApiPath(cid, "desktop"), screenshotApiPath(cid, "mobile")),
      db.prepare(
        `UPDATE takedown_evidence
            SET storage_key = NULL, storage_url = NULL, metadata_json = '{"expired":true}'
          WHERE id > ? AND id < ?`,
      ).bind(`tde_${cid}_`, `tde_${cid}\``),
    ]));
    if (rows.length < SWEEP_PAGE) break;
  }
  // Dedup aliases are only needed while their capture can still run.
  try {
    await db.prepare(`DELETE FROM page_capture_targets WHERE created_at < ?`)
      .bind(d1Ts(addDays(now, -TARGET_ALIAS_RETENTION_DAYS))).run();
  } catch (err) {
    console.warn(`[page-capture] alias purge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { expired, objectsDeleted, ran: true };
}

/** Once per UTC day, on the first capture run in hour 0 (hour-only gate —
 *  cron-audit-safe: no minute check; a KV day stamp dedups the other five
 *  hour-0 ticks). KV unavailable → run anyway (the sweep is idempotent). */
export async function maybeDailySweep(
  env: Pick<Env, "DB" | "CACHE"> & { PHISH_CAPTURES?: R2Bucket },
  scheduledTime: Date,
): Promise<SweepResult> {
  if (scheduledTime.getUTCHours() !== 0) return { expired: 0, objectsDeleted: 0, ran: false };
  const stampKey = `${SWEEP_STAMP_PREFIX}${scheduledTime.toISOString().slice(0, 10)}`;
  try {
    if (await env.CACHE.get(stampKey)) return { expired: 0, objectsDeleted: 0, ran: false };
  } catch { /* fall through */ }
  const result = await sweepExpiredCaptures(env.DB, env.PHISH_CAPTURES, scheduledTime);
  try {
    await env.CACHE.put(stampKey, "1", { expirationTtl: 2 * 86_400 });
  } catch { /* best-effort */ }
  return result;
}

// ─── The run (AgentModule body) ──────────────────────────────────────

export interface PageCaptureRunStats {
  skipped: string | null;
  claimed: number;
  captured: number;
  blocked: number;
  failed: number;
  requeued: number;
  released: number;
  evidence_linked: number;
  reaped: ReapResult;
  sweep: SweepResult;
  [key: string]: unknown;
}

export interface PageCaptureRunOptions {
  /** Max rows to claim (default CAPTURE_BATCH). Non-cron dispatches pass
   *  CAPTURE_NON_CRON_LIMIT. */
  limit?: number;
  /** Defaults to the puppeteer driver over env.BROWSER. */
  driver?: CaptureDriver;
  /** Cron fire time (hour-gate for the sweep). Defaults to now. */
  scheduledTime?: Date;
  /** Clock for timestamps + the run budget (tests). */
  now?: () => Date;
  /** DoH resolver for the SSRF guard (tests). */
  resolve?: FetchDeps["resolve"];
}

function isRefusal(err: unknown): boolean {
  return err instanceof CaptureRefusedError;
}

export async function runPageCapture(env: Env, opts: PageCaptureRunOptions = {}): Promise<PageCaptureRunStats> {
  const clock = opts.now ?? (() => new Date());
  const startedAt = clock();
  const stats: PageCaptureRunStats = {
    skipped: null, claimed: 0, captured: 0, blocked: 0, failed: 0, requeued: 0,
    released: 0, evidence_linked: 0,
    reaped: { requeued: 0, failed: 0, stale: 0 },
    sweep: { expired: 0, objectsDeleted: 0, ran: false },
  };

  // Clean no-op when either binding is absent (staging / dev / tests).
  const bucket = env.PHISH_CAPTURES;
  if (!env.BROWSER || !bucket) {
    stats.skipped = !env.BROWSER && !bucket ? "bindings_absent:BROWSER,PHISH_CAPTURES"
      : !env.BROWSER ? "bindings_absent:BROWSER" : "bindings_absent:PHISH_CAPTURES";
    return stats;
  }

  // Housekeeping failures must never block claims.
  try {
    stats.reaped = await reapStuckCaptures(env.DB, startedAt);
  } catch (err) {
    stats.reap_error = err instanceof Error ? err.message : String(err);
  }
  try {
    stats.sweep = await maybeDailySweep(env, opts.scheduledTime ?? startedAt);
  } catch (err) {
    stats.sweep_error = err instanceof Error ? err.message : String(err);
  }
  // Late links: takedowns drafted after their capture, threats deduped onto
  // an already-captured target. Bounded; never blocks claims.
  try {
    const cu = await catchUpCaptureEvidence(env, startedAt);
    stats.evidence_linked += cu.linked;
    stats.catchup_scanned = cu.scanned;
  } catch (err) {
    stats.catchup_error = err instanceof Error ? err.message : String(err);
  }

  const limit = Math.max(1, Math.min(opts.limit ?? CAPTURE_BATCH, CAPTURE_BATCH));
  const claimed = await claimCaptures(env.DB, limit, startedAt);
  stats.claimed = claimed.length;
  if (claimed.length === 0) return stats;

  let driver = opts.driver;
  if (!driver) {
    const { puppeteerCaptureDriver } = await import("./page-capture-browser");
    driver = puppeteerCaptureDriver(env.BROWSER);
  }

  let session: CaptureSession;
  try {
    session = await driver.open();
  } catch (err) {
    await releaseCaptures(env.DB, claimed.map((r) => r.id));
    stats.released = claimed.length;
    throw new Error(`browser session unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const guard = makeNavigationGuard(opts.resolve);
  const store = { DB: env.DB, PHISH_CAPTURES: bucket };
  try {
    for (let i = 0; i < claimed.length; i++) {
      const row = claimed[i]!;
      // Leave room for one more full page inside the run budget.
      if (clock().getTime() - startedAt.getTime() > CAPTURE_RUN_BUDGET_MS - CAPTURE_PAGE_TIMEOUT_MS) {
        const rest = claimed.slice(i).map((r) => r.id);
        await releaseCaptures(env.DB, rest);
        stats.released += rest.length;
        break;
      }
      try {
        const raw = await capturePage(session, row.target_url, guard);
        // A refused hop with nothing rendered is a policy refusal (never
        // retried). A page that rendered before a later hop was refused is
        // still evidence — stored, with the refused hop absent from the chain.
        if (raw.blockedNavigation && !raw.desktopPng && !raw.mobilePng) {
          if (raw.blockedRetryable) throw new Error(`navigation unresolvable: ${raw.blockedNavigation}`);
          throw new CaptureRefusedError(`refused navigation: ${raw.blockedNavigation}`);
        }
        const stored = await storeCapture(store, row, raw, clock());
        if (stored.status === "blocked") stats.blocked++;
        else stats.captured++;
        try {
          stats.evidence_linked += await linkCaptureEvidence(env.DB, row.id, row.threat_id, stored, clock(), row.target_key);
        } catch (err) {
          console.warn(`[page-capture] evidence link failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } catch (err) {
        if (err instanceof CaptureSupersededError) {
          stats.requeued++;
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const next = await failCapture(env.DB, row, msg, !isRefusal(err));
        if (next === "queued") stats.requeued++;
        else stats.failed++;
      }
    }
  } finally {
    try {
      await session.close();
    } catch { /* already gone */ }
  }
  return stats;
}

/** Telemetry-only completion event (target_agent NULL — no dispatch). */
export async function emitPageCaptureEvent(
  env: Pick<Env, "DB">,
  runId: string,
  stats: PageCaptureRunStats | null,
  error: string | null = null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
       VALUES (?, 'pages_captured', 'page_capture', NULL, ?, 3, 'pending')`,
    ).bind(
      crypto.randomUUID(),
      JSON.stringify(stats
        ? {
            run_id: runId,
            skipped: stats.skipped,
            claimed: stats.claimed,
            captured: stats.captured,
            blocked: stats.blocked,
            failed: stats.failed,
            requeued: stats.requeued,
            released: stats.released,
            evidence_linked: stats.evidence_linked,
            reaped: stats.reaped,
            expired: stats.sweep.expired,
            error,
          }
        : { run_id: runId, error }),
    ).run();
  } catch (err) {
    console.warn(`[page-capture] agent_events emit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Read model (detail endpoint) ────────────────────────────────────

export interface CaptureRow {
  id: string;
  status: CaptureStatus;
  queued_at: string;
  captured_at: string | null;
  expires_at: string | null;
  final_url: string | null;
  http_status: number | null;
  page_title: string | null;
  redirect_chain_json: string | null;
  form_action_hosts_json: string | null;
  anti_bot_wall: string | null;
  error: string | null;
  desktop_key: string | null;
  mobile_key: string | null;
  html_key: string | null;
  desktop_sha256: string | null;
  mobile_sha256: string | null;
  html_sha256: string | null;
}

export interface CaptureView {
  id: string;
  status: CaptureStatus;
  queued_at: string;
  captured_at: string | null;
  expires_at: string | null;
  final_url: string | null;
  http_status: number | null;
  page_title: string | null;
  redirect_chain: string[];
  form_action_hosts: string[];
  anti_bot_wall: string | null;
  error: string | null;
  screenshot_desktop_url: string | null;
  screenshot_mobile_url: string | null;
  html_download_url: string | null;
  sha256: { desktop: string | null; mobile: string | null; html: string | null };
}

export const CAPTURE_DETAIL_SQL =
  `SELECT id, status, queued_at, captured_at, expires_at, final_url, http_status, page_title,
          redirect_chain_json, form_action_hosts_json, anti_bot_wall, error,
          desktop_key, mobile_key, html_key, desktop_sha256, mobile_sha256, html_sha256
     FROM page_captures
    WHERE threat_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?`;

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function iso(v: string | null): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
}

export function toCaptureView(r: CaptureRow): CaptureView {
  return {
    id: r.id,
    status: r.status,
    queued_at: iso(r.queued_at) ?? r.queued_at,
    captured_at: iso(r.captured_at),
    expires_at: iso(r.expires_at),
    final_url: r.final_url,
    http_status: r.http_status,
    page_title: r.page_title,
    redirect_chain: parseStringArray(r.redirect_chain_json),
    form_action_hosts: parseStringArray(r.form_action_hosts_json),
    anti_bot_wall: r.anti_bot_wall,
    error: r.error,
    screenshot_desktop_url: r.desktop_key ? screenshotApiPath(r.id, "desktop") : null,
    screenshot_mobile_url: r.mobile_key ? screenshotApiPath(r.id, "mobile") : null,
    html_download_url: r.html_key ? htmlApiPath(r.id) : null,
    sha256: { desktop: r.desktop_sha256, mobile: r.mobile_sha256, html: r.html_sha256 },
  };
}
