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

// ─── Enqueue ─────────────────────────────────────────────────────────

export interface AutoCaptureItem {
  threatId: string;
  maliciousUrl?: string | null;
  maliciousDomain?: string | null;
}

/**
 * Automatic enqueue for one threat: inserts a `queued` row only when the
 * threat has NEVER had a capture row. The feed writers re-see the same
 * threats on every pull (INSERT OR IGNORE duplicates), so an "only if no
 * OPEN row" guard would re-capture every re-pulled threat once per pull;
 * re-capturing an already-captured page is a manual action. The partial
 * unique index (one open row per threat) still backstops races — hence
 * INSERT OR IGNORE. 5 binds.
 */
export function enqueueAutoCaptureStmt(
  db: D1Database,
  threatId: string,
  targetUrl: string,
  now: Date = new Date(),
): D1PreparedStatement {
  const ts = d1Ts(now);
  return db.prepare(
    `INSERT OR IGNORE INTO page_captures (id, threat_id, target_url, status, attempts, queued_at, created_at)
     SELECT ?, ?, ?, 'queued', 0, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM page_captures WHERE threat_id = ?)`,
  ).bind(newCaptureId(), threatId, targetUrl, ts, ts, threatId);
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
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it.threatId || seen.has(it.threatId)) continue;
    const url = captureTargetUrl(it.maliciousUrl, it.maliciousDomain);
    if (!url) continue;
    seen.add(it.threatId);
    stmts.push(enqueueAutoCaptureStmt(db, it.threatId, url, now));
  }
  let queued = 0;
  for (let i = 0; i < stmts.length; i += ENQUEUE_CHUNK) {
    try {
      const res = await db.batch(stmts.slice(i, i + ENQUEUE_CHUNK));
      for (const r of res) queued += r.meta?.changes ?? 0;
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
    `INSERT OR IGNORE INTO page_captures (id, threat_id, target_url, status, attempts, requested_by, queued_at, created_at)
     SELECT ?, ?, ?, 'queued', 0, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM page_captures
                         WHERE threat_id = ? AND status IN ('queued', 'capturing'))`,
  ).bind(id, threatId, targetUrl, requestedBy, ts, ts, threatId).run();
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
      RETURNING id, threat_id, target_url, attempts, requested_by, queued_at`,
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

export type GuardVerdict = { ok: true } | { ok: false; reason: string };
/** Called by the driver for EVERY navigation request (initial + redirects +
 *  frames) before it is allowed to continue. */
export type NavigationGuard = (url: string) => Promise<GuardVerdict>;

export interface CaptureRequest {
  targetUrl: string;
  timeoutMs: number;
  guard: NavigationGuard;
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
  /** Set when the guard refused a navigation hop. */
  blockedNavigation: string | null;
}

export interface CaptureSession {
  capture(req: CaptureRequest): Promise<RawCapture>;
  close(): Promise<void>;
}

export interface CaptureDriver {
  open(): Promise<CaptureSession>;
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
  const cache = new Map<string, string[]>();
  return async (raw: string): Promise<GuardVerdict> => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, reason: "unparseable url" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: `disallowed scheme ${u.protocol}` };
    }
    const check = await assertResolvedHostSafe(u.hostname, deps, cache);
    return check.ok ? { ok: true } : { ok: false, reason: check.reason };
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

/** Run one capture under a hard wall-clock limit. The driver's own timeouts
 *  are best-effort; this one always fires. */
export async function capturePage(
  session: CaptureSession,
  targetUrl: string,
  guard: NavigationGuard,
  timeoutMs: number = CAPTURE_PAGE_TIMEOUT_MS,
): Promise<RawCapture> {
  const pre = await guard(targetUrl);
  if (!pre.ok) throw new CaptureRefusedError(`refused target: ${pre.reason}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = session.capture({ targetUrl, timeoutMs, guard });
  // Swallow a late rejection after the timeout wins the race.
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`capture timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
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
  await env.PHISH_CAPTURES.put(metaKey, JSON.stringify(meta, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: custom,
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
    desktopSha: hashes["desktop"] ?? null,
    mobileSha: hashes["mobile"] ?? null,
    htmlSha: hashes["html"] ?? null,
    htmlBytes: html.bytes.byteLength,
    capturedAt: now,
    expiresAt,
  };

  await env.DB.prepare(
    `UPDATE page_captures
        SET status = ?, final_url = ?, http_status = ?, page_title = ?,
            redirect_chain_json = ?, form_action_hosts_json = ?,
            desktop_key = ?, mobile_key = ?, html_key = ?,
            desktop_sha256 = ?, mobile_sha256 = ?, html_sha256 = ?,
            html_bytes = ?, anti_bot_wall = ?, error = NULL, claimed_at = NULL,
            captured_at = ?, expires_at = ?
      WHERE id = ?`,
  ).bind(
    stored.status, stored.finalUrl, stored.httpStatus, stored.title,
    JSON.stringify(stored.redirectChain), JSON.stringify(stored.formHosts),
    stored.desktopKey, stored.mobileKey, stored.htmlKey,
    stored.desktopSha, stored.mobileSha, stored.htmlSha,
    stored.htmlBytes, stored.antiBotWall,
    d1Ts(now), d1Ts(expiresAt), row.id,
  ).run();

  return stored;
}

// ─── Evidence linking ────────────────────────────────────────────────

/**
 * Attach a stored capture to every takedown drafted from its threat
 * (`source_type='threat'`, partial index idx_takedown_requests_threat_source):
 * one `takedown_evidence` row each (deterministic id → re-runs are no-ops)
 * and `takedown_requests.screenshot_url` when still NULL. The URL is the
 * staff API path, never a public URL. Returns evidence rows inserted.
 */
export async function linkCaptureEvidence(
  db: D1Database,
  captureId: string,
  threatId: string | null,
  stored: Pick<StoredCapture, "status" | "desktopKey" | "mobileKey" | "desktopSha" | "mobileSha" | "finalUrl" | "antiBotWall" | "htmlSha">,
  now: Date = new Date(),
): Promise<number> {
  if (!threatId) return 0;
  const variant: "desktop" | "mobile" | null = stored.desktopKey ? "desktop" : stored.mobileKey ? "mobile" : null;
  if (!variant) return 0;
  const apiPath = screenshotApiPath(captureId, variant);
  const storageKey = variant === "desktop" ? stored.desktopKey : stored.mobileKey;
  const metaJson = JSON.stringify({
    capture_id: captureId,
    status: stored.status,
    final_url: stored.finalUrl,
    anti_bot_wall: stored.antiBotWall,
    sha256: { desktop: stored.desktopSha, mobile: stored.mobileSha, html: stored.htmlSha },
    html_url: htmlApiPath(captureId),
  });
  const title = stored.status === "blocked"
    ? "Page capture (anti-bot wall shown)"
    : "Page capture (rendered screenshot)";
  const [ins] = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO takedown_evidence
         (id, takedown_id, evidence_type, title, storage_key, storage_url, metadata_json, created_at)
       SELECT 'tde_' || ? || '_' || tr.id, tr.id, 'screenshot', ?, ?, ?, ?, ?
         FROM takedown_requests tr
        WHERE tr.source_type = 'threat' AND tr.source_id = ?`,
    ).bind(captureId, title, storageKey, apiPath, metaJson, d1Ts(now), threatId),
    db.prepare(
      `UPDATE takedown_requests SET screenshot_url = ?
        WHERE source_type = 'threat' AND source_id = ? AND screenshot_url IS NULL`,
    ).bind(apiPath, threatId),
  ]);
  return ins?.meta?.changes ?? 0;
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
    const upd = await db.prepare(
      `UPDATE page_captures
          SET status = 'expired', desktop_key = NULL, mobile_key = NULL, html_key = NULL
        WHERE status IN ('captured', 'blocked') AND id IN (${ids.map(() => "?").join(", ")})`,
    ).bind(...ids).run();
    expired += upd.meta?.changes ?? 0;
    if (rows.length < SWEEP_PAGE) break;
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

  stats.reaped = await reapStuckCaptures(env.DB, startedAt);
  stats.sweep = await maybeDailySweep(env, opts.scheduledTime ?? startedAt);

  const claimed = await claimCaptures(env.DB, CAPTURE_BATCH, startedAt);
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
          throw new CaptureRefusedError(`refused navigation: ${raw.blockedNavigation}`);
        }
        const stored = await storeCapture(store, row, raw, clock());
        if (stored.status === "blocked") stats.blocked++;
        else stats.captured++;
        try {
          stats.evidence_linked += await linkCaptureEvidence(env.DB, row.id, row.threat_id, stored, clock());
        } catch (err) {
          console.warn(`[page-capture] evidence link failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } catch (err) {
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
export async function emitPageCaptureEvent(env: Pick<Env, "DB">, runId: string, stats: PageCaptureRunStats): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
       VALUES (?, 'pages_captured', 'page_capture', NULL, ?, 3, 'pending')`,
    ).bind(
      crypto.randomUUID(),
      JSON.stringify({
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
      }),
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
