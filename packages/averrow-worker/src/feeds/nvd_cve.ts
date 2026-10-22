import type { FeedModule, FeedContext, FeedResult } from "./types";
import { logFeedDiagnostic } from "../lib/feedDiagnostic";

/**
 * NIST National Vulnerability Database — CVE 2.0 JSON API.
 *
 * https://services.nvd.nist.gov/rest/json/cves/2.0
 *
 * Public. An optional API key (`env.NVD_API_KEY`, sent as the `apiKey`
 * header, never in the URL) raises NVD's rate limit from 5 to 50 requests
 * per rolling 30 seconds. Without it we space requests 6.5s apart.
 *
 * Why this complements cisa_kev:
 *   - CISA KEV is the curated "known exploited" subset.
 *   - NVD is the FULL CVE catalog — every published CVE, including those
 *     that may be exploited later, so the correlation surface covers vulns
 *     BEFORE they hit KEV.
 *
 * Storage convention (2026-06-18): a CVE is NOT an IP/URL/domain, so it
 * never goes into `threats`. Each run writes ONE aggregated insight digest
 * to `agent_outputs` (agent_id='sentinel', type='insight', summary prefix
 * `NVD CVE Update:`). The Observer reads only `summary` (last 24h of
 * non-observer outputs), so every critical CVE id is named in the summary
 * text, not just in `details`.
 *
 * ── Cursor + catch-up (fix 2026-10-22, PHP2Shell miss) ──────────────────
 * The old module pulled a fixed sliding 24h published window in ONE
 * 2000-result request with a 30s timeout. Three failures followed:
 *   1. A 2000-row page on a slow NVD routinely took >30s → every attempt
 *      timed out → 5 consecutive failures → auto-pause.
 *   2. Any outage longer than 24h lost CVEs permanently (no backfill), and
 *      any 24h window holding >2000 CVEs was silently truncated.
 *   3. Only CVSS v3.1/v3.0/v2 were read, so a CVE carrying only a v4.0
 *      score (common for CNA-scored CVEs before NVD analysis) read as
 *      "unscored" and sorted last.
 *
 * Now two lanes, each with a cursor persisted in KV (`CURSOR_KEY`, same
 * convention as circl_osint's cursor):
 *   - `pub` (priority): CVEs by PUBLISHED date, from the cursor forward.
 *     Each window is fixed ([start, end], end ≤ start + 120 days — NVD's
 *     max range) and paginated with startIndex/totalResults. The cursor
 *     moves to the window end only once every page of the window is in;
 *     a run that runs out of budget mid-window stores the resume index.
 *   - `mod` (best effort, only when `pub` is caught up): CVEs by
 *     LAST-MODIFIED date. NVD enrichment lags publication — a CVE can be
 *     published unscored and get its score days later. This lane surfaces
 *     CVEs published in the last 30 days, modified ≥6h after publication,
 *     that are now high/critical, as "updated" entries. It never counts
 *     toward the "new" totals.
 */

const NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0";

/** KV key holding the per-lane cursor state (JSON, `NvdCursorState`). */
export const CURSOR_KEY = "nvd_cve:cursor:v1";

/** Results per page. Smaller pages return well inside the request timeout. */
export const PAGE_SIZE = 500;
/** Floor for the adaptive page size (halved after a timed-out attempt). */
const MIN_PAGE_SIZE = 100;
/** Per-request timeout. */
export const FETCH_TIMEOUT_MS = 25_000;
/** Attempts per page (transient failures only: timeout, network, 429, 5xx). */
export const FETCH_ATTEMPTS = 3;
/** Extra backoff before a retry, on top of the rate-limit spacing. */
const RETRY_BACKOFF_MS = [2_000, 5_000];
/** Minimum spacing between requests: 5 req / 30s without a key, 50 with. */
export const SPACING_NO_KEY_MS = 6_500;
export const SPACING_WITH_KEY_MS = 700;

/**
 * Wall-clock budget for one run (the feed runs inside the hourly
 * orchestrator tick). No new PAGE starts after SOFT_BUDGET_MS; no new
 * REQUEST (incl. a retry) starts unless it can time out before
 * HARD_BUDGET_MS. Unfinished work resumes from the cursor next run.
 */
export const SOFT_BUDGET_MS = 120_000;
export const HARD_BUDGET_MS = 180_000;

/** NVD rejects a date range longer than 120 days. Stay a minute under. */
const MAX_RANGE_MS = 120 * 86_400_000 - 60_000;
/** Re-read this much before the cursor: absorbs NVD indexing lag. */
const CURSOR_OVERLAP_MS = 15 * 60_000;
/** On a mid-window resume, re-read this many results before the stored index
 *  (absorbs index shifts when a CVE inside the window is re-modified). */
const RESUME_OVERLAP = 25;
/** Cold start from feed_status.last_successful_pull: re-read its 24h window + 1h. */
const COLD_START_REREAD_MS = 25 * 3_600_000;
/** Cold start with no cursor and no feed_status history. */
const COLD_START_LOOKBACK_MS = 7 * 86_400_000;
/** The `mod` lane never reaches back further than this. */
const MOD_MAX_LOOKBACK_MS = 30 * 86_400_000;
/** `mod` lane: only CVEs published within this window are "updated" entries. */
const UPDATED_MAX_AGE_MS = 30 * 86_400_000;
/** `mod` lane: modified at least this long after publication. */
const UPDATED_MIN_LAG_MS = 6 * 3_600_000;

/** Entries serialized into `details` (criticals may extend it, see below). */
export const DETAILS_LIMIT = 50;
/** Every critical is kept in `details` up to this cap, even past DETAILS_LIMIT. */
export const CRITICAL_DETAILS_CAP = 150;
/** Critical ids named in the summary text (the Observer reads only summary). */
const SUMMARY_CRITICAL_IDS = 15;

// ─── NVD 2.0 response shape ─────────────────────────────────────────

export interface NvdCvssMetric {
  source?: string;
  type?: string; // 'Primary' (NVD) | 'Secondary' (CNA / other)
  cvssData?: { version?: string; baseScore?: number; baseSeverity?: string };
  /** v2 carries baseSeverity on the metric, not in cvssData. */
  baseSeverity?: string;
}

export interface NvdCve {
  id: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  descriptions?: Array<{ lang: string; value: string }>;
  metrics?: {
    cvssMetricV40?: NvdCvssMetric[];
    cvssMetricV31?: NvdCvssMetric[];
    cvssMetricV30?: NvdCvssMetric[];
    cvssMetricV2?: NvdCvssMetric[];
  };
  references?: Array<{ url?: string }>;
}

interface NvdResponse {
  resultsPerPage?: number;
  startIndex?: number;
  totalResults?: number;
  vulnerabilities?: Array<{ cve?: NvdCve }>;
}

// ─── CVSS selection ─────────────────────────────────────────────────

type Severity = "critical" | "high" | "medium" | "low" | "info";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

const METRIC_ORDER = [
  ["cvssMetricV40", "4.0"],
  ["cvssMetricV31", "3.1"],
  ["cvssMetricV30", "3.0"],
  ["cvssMetricV2", "2.0"],
] as const;

export interface CvssPick {
  score: number;
  version: string;
  sourceType: "Primary" | "Secondary";
  source: string | null;
  band: string | null;
}

function hasScore(m: NvdCvssMetric): boolean {
  return typeof m.cvssData?.baseScore === "number";
}

/**
 * Preferred CVSS metric: v4.0 > v3.1 > v3.0 > v2; within a version NVD's
 * own ('Primary') score, else the CNA-provided ('Secondary') one — a
 * freshly published CVE often carries only the CNA's score.
 */
export function pickCvss(cve: NvdCve): CvssPick | null {
  for (const [key, version] of METRIC_ORDER) {
    const list = (cve.metrics?.[key] ?? []).filter(hasScore);
    const m = list.find((x) => x.type === "Primary") ?? list[0];
    if (m) {
      return {
        score: m.cvssData?.baseScore as number,
        version: m.cvssData?.version ?? version,
        sourceType: m.type === "Primary" ? "Primary" : "Secondary",
        source: m.source ?? null,
        band: m.cvssData?.baseSeverity ?? m.baseSeverity ?? null,
      };
    }
  }
  return null;
}

/** Highest base score any source assigns under any CVSS version. */
export function maxCvss(cve: NvdCve): number | null {
  let max: number | null = null;
  for (const [key] of METRIC_ORDER) {
    for (const m of cve.metrics?.[key] ?? []) {
      const s = m.cvssData?.baseScore;
      if (typeof s === "number" && (max === null || s > max)) max = s;
    }
  }
  return max;
}

function cvssToSeverity(score: number | null | undefined): Severity {
  if (score === undefined || score === null) return "info";
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  return "low";
}

/**
 * Severity tier from the preferred score, escalated to critical when ANY
 * version/source scores it ≥ 9.0 — a version preference must never hide a
 * 9.x from the digest.
 */
export function classifyCve(cve: NvdCve): Severity {
  const preferred = cvssToSeverity(pickCvss(cve)?.score);
  const max = maxCvss(cve);
  return max !== null && max >= 9.0 ? "critical" : preferred;
}

// ─── Cursor state ───────────────────────────────────────────────────

type LaneName = "pub" | "mod";

interface LaneWindow {
  start: string;
  end: string;
  nextIndex: number;
}

interface LaneState {
  /** Everything up to this instant is fully drained. null = cold. */
  cursor: string | null;
  /** In-flight window (budget ran out mid-window). */
  window: LaneWindow | null;
}

export interface NvdCursorState {
  v: 1;
  pub: LaneState;
  mod: LaneState;
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

function parseLane(raw: unknown): LaneState {
  const lane: LaneState = { cursor: null, window: null };
  if (!raw || typeof raw !== "object") return lane;
  const r = raw as Record<string, unknown>;
  if (isIso(r.cursor)) lane.cursor = r.cursor;
  const w = r.window;
  if (w && typeof w === "object") {
    const ww = w as Record<string, unknown>;
    if (
      isIso(ww.start) &&
      isIso(ww.end) &&
      typeof ww.nextIndex === "number" &&
      Number.isInteger(ww.nextIndex) &&
      ww.nextIndex >= 0
    ) {
      lane.window = { start: ww.start, end: ww.end, nextIndex: ww.nextIndex };
    }
  }
  return lane;
}

export function parseCursorState(raw: string | null): NvdCursorState {
  let obj: unknown = null;
  if (raw) {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  const o = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  return { v: 1, pub: parseLane(o.pub), mod: parseLane(o.mod) };
}

/** feed_status stores 'YYYY-MM-DD HH:MM:SS' (UTC, no zone). */
function parseD1Utc(v: string | null | undefined): number | null {
  if (!v) return null;
  const ms = Date.parse(v.includes("T") ? v : v.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? ms : null;
}

// ─── Run machinery ──────────────────────────────────────────────────

export interface NvdDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const defaultDeps: NvdDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetch: (url, init) => fetch(url, init),
};

class NonTransientError extends Error {}

interface RunCtx {
  ctx: FeedContext;
  deps: NvdDeps;
  baseUrl: string;
  apiKey: string | null;
  spacingMs: number;
  startedAt: number;
  lastRequestAt: number | null;
  pageSize: number;
  requests: number;
}

function elapsed(run: RunCtx): number {
  return run.deps.now() - run.startedAt;
}

function buildUrl(run: RunCtx, lane: LaneName, w: LaneWindow, startIndex: number): string {
  const params = new URLSearchParams(
    lane === "pub"
      ? { pubStartDate: w.start, pubEndDate: w.end }
      : { lastModStartDate: w.start, lastModEndDate: w.end },
  );
  params.set("resultsPerPage", String(run.pageSize));
  params.set("startIndex", String(startIndex));
  return run.baseUrl + "?" + params.toString();
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * One page with bounded retry on transient failures. Waits out the
 * rate-limit spacing before every request and never starts a request that
 * could outlive HARD_BUDGET_MS. Returns null when the budget ends the
 * retries; throws on a non-transient error or after the last attempt.
 */
async function fetchPage(
  run: RunCtx,
  lane: LaneName,
  w: LaneWindow,
  startIndex: number,
): Promise<NvdResponse | null> {
  let lastError = "";
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const backoff = attempt > 1 ? (RETRY_BACKOFF_MS[attempt - 2] ?? 5_000) : 0;
    const sinceLast = run.lastRequestAt === null ? Infinity : run.deps.now() - run.lastRequestAt;
    const wait = Math.max(backoff, run.spacingMs - sinceLast, 0);
    if (elapsed(run) + wait + FETCH_TIMEOUT_MS > HARD_BUDGET_MS) {
      if (attempt === 1) return null;
      throw new Error(`NVD ${lane} page failed, budget exhausted before retry: ${lastError}`);
    }
    if (wait > 0) await run.deps.sleep(wait);

    const url = buildUrl(run, lane, w, startIndex);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Averrow-ThreatIntel/1.0",
    };
    if (run.apiKey) headers.apiKey = run.apiKey;

    run.lastRequestAt = run.deps.now();
    run.requests++;
    try {
      const res = await run.deps.fetch(url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        try {
          return (await res.json()) as NvdResponse;
        } catch (err) {
          lastError = `NVD JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        lastError = `NVD HTTP ${res.status}`;
        if (!isTransientStatus(res.status)) {
          // 4xx other than 429 (bad params, bad apiKey) won't fix itself.
          throw new NonTransientError(lastError);
        }
      }
    } catch (err) {
      if (err instanceof NonTransientError) {
        await logFeedDiagnostic(run.ctx.env.DB, {
          feedName: "nvd_cve", url, method: "GET", httpStatus: null, bodyPreview: "", errorMessage: err.message,
        });
        throw err;
      }
      lastError =
        typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : String(err);
      const errName = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
      const timedOut = errName === "TimeoutError" || /timeout|timed out|aborted/i.test(lastError);
      if (timedOut) run.pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(run.pageSize / 2));
    }
    await logFeedDiagnostic(run.ctx.env.DB, {
      feedName: "nvd_cve", url, method: "GET", httpStatus: null, bodyPreview: "",
      errorMessage: `attempt ${attempt}/${FETCH_ATTEMPTS}: ${lastError}`,
    });
  }
  throw new Error(`NVD unreachable after ${FETCH_ATTEMPTS} attempts: ${lastError}`);
}

interface LaneOutcome {
  cves: NvdCve[];
  pages: number;
  /** True when the lane reached "now" with nothing pending. */
  caughtUp: boolean;
  /** Set when the lane stopped on a fetch failure. */
  error: string | null;
  /** Set when the lane stopped on the budget. */
  budgetStop: boolean;
}

/**
 * Drain one lane from its cursor. Mutates `state` in place as pages land,
 * so whatever was fetched before a failure or the budget stop is recorded.
 */
async function drainLane(
  run: RunCtx,
  lane: LaneName,
  state: LaneState,
  coldStartMs: number,
): Promise<LaneOutcome> {
  const out: LaneOutcome = { cves: [], pages: 0, caughtUp: false, error: null, budgetStop: false };
  let resumed = state.window !== null && state.window.nextIndex > 0;

  while (true) {
    const now = run.deps.now();
    if (!state.window) {
      let startMs = state.cursor ? Date.parse(state.cursor) - CURSOR_OVERLAP_MS : coldStartMs;
      if (lane === "mod") startMs = Math.max(startMs, now - MOD_MAX_LOOKBACK_MS);
      const endMs = Math.min(now, startMs + MAX_RANGE_MS);
      if (endMs - startMs < 60_000) {
        out.caughtUp = true;
        return out;
      }
      state.window = {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        nextIndex: 0,
      };
    }
    const w = state.window;

    if (elapsed(run) >= SOFT_BUDGET_MS) {
      out.budgetStop = true;
      return out;
    }

    const startIndex = resumed ? Math.max(0, w.nextIndex - RESUME_OVERLAP) : w.nextIndex;
    resumed = false;
    let body: NvdResponse | null;
    try {
      body = await fetchPage(run, lane, w, startIndex);
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
      return out;
    }
    if (body === null) {
      out.budgetStop = true;
      return out;
    }
    out.pages++;

    const vulns = (body.vulnerabilities ?? [])
      .map((v) => v.cve)
      .filter((c): c is NvdCve => !!c?.id);
    for (const c of vulns) out.cves.push(c);

    const returned = body.vulnerabilities?.length ?? 0;
    const total = typeof body.totalResults === "number" ? body.totalResults : 0;
    w.nextIndex = startIndex + returned;

    if (returned === 0 || w.nextIndex >= total) {
      // Window fully drained — commit the cursor to its end.
      state.cursor = w.end;
      state.window = null;
      // A window opened by THIS run ends at (or after) the run start: done.
      // A resumed or 120-day-capped window leaves more to read: loop on.
      if (Date.parse(w.end) >= run.startedAt) {
        out.caughtUp = true;
        return out;
      }
    }
  }
}

// ─── Digest ─────────────────────────────────────────────────────────

interface DigestEntry {
  cve: NvdCve;
  kind: "new" | "updated";
  severity: Severity;
  pick: CvssPick | null;
  max: number | null;
}

function entryOf(cve: NvdCve, kind: "new" | "updated"): DigestEntry {
  return { cve, kind, severity: classifyCve(cve), pick: pickCvss(cve), max: maxCvss(cve) };
}

/** Severity tier first, then preferred score, then max score, then id. */
export function compareEntries(a: DigestEntry, b: DigestEntry): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    (b.pick?.score ?? -1) - (a.pick?.score ?? -1) ||
    (b.max ?? -1) - (a.max ?? -1) ||
    a.cve.id.localeCompare(b.cve.id)
  );
}

/**
 * `details` selection: every critical (up to CRITICAL_DETAILS_CAP), then
 * the rest in rank order up to DETAILS_LIMIT. Sorting by tier BEFORE
 * truncating guarantees a critical is never dropped for a lower tier.
 */
export function selectDetails<T extends DigestEntry>(ranked: T[]): T[] {
  const criticals = ranked.filter((e) => e.severity === "critical").slice(0, CRITICAL_DETAILS_CAP);
  const limit = Math.max(DETAILS_LIMIT, criticals.length);
  return ranked.slice(0, limit);
}

function scoreLabel(e: DigestEntry): string {
  if (!e.pick) return e.max !== null ? `CVSS ${e.max.toFixed(1)}` : "CVSS n/a";
  const base = `CVSS ${e.pick.score.toFixed(1)} v${e.pick.version}${e.pick.sourceType === "Secondary" ? " CNA" : ""}`;
  return e.max !== null && e.max > e.pick.score ? `${base}, max ${e.max.toFixed(1)}` : base;
}

function englishDescription(cve: NvdCve): string {
  return cve.descriptions?.find((d) => d.lang === "en")?.value ?? "";
}

function uniqueById(cves: NvdCve[]): NvdCve[] {
  const seen = new Map<string, NvdCve>();
  for (const c of cves) {
    if (c.vulnStatus === "Rejected") continue;
    const prev = seen.get(c.id);
    // Keep the most recently modified copy (overlap re-reads).
    if (!prev || (c.lastModified ?? "") >= (prev.lastModified ?? "")) seen.set(c.id, c);
  }
  return [...seen.values()];
}

/** `mod`-lane CVE worth surfacing as "updated" (see module header). */
function isLateUpdate(cve: NvdCve, nowMs: number): boolean {
  const pub = Date.parse(cve.published ?? "");
  const mod = Date.parse(cve.lastModified ?? "");
  if (!Number.isFinite(pub) || !Number.isFinite(mod)) return false;
  if (nowMs - pub > UPDATED_MAX_AGE_MS) return false;
  if (mod - pub < UPDATED_MIN_LAG_MS) return false;
  const sev = classifyCve(cve);
  return sev === "critical" || sev === "high";
}

// ─── Feed ───────────────────────────────────────────────────────────

export function createNvdCveFeed(overrides: Partial<NvdDeps> = {}): FeedModule {
  const deps: NvdDeps = { ...defaultDeps, ...overrides };

  return {
    async ingest(ctx: FeedContext): Promise<FeedResult> {
      const env = ctx.env;
      const run: RunCtx = {
        ctx,
        deps,
        baseUrl: ctx.feedUrl || NVD_API,
        apiKey: env.NVD_API_KEY ? env.NVD_API_KEY : null,
        spacingMs: env.NVD_API_KEY ? SPACING_WITH_KEY_MS : SPACING_NO_KEY_MS,
        startedAt: deps.now(),
        lastRequestAt: null,
        pageSize: PAGE_SIZE,
        requests: 0,
      };

      const state = parseCursorState(await env.CACHE.get(CURSOR_KEY));
      const before = JSON.stringify(state);

      // Cold start (no KV cursor): re-read the whole 24h window of the last
      // successful pull of the OLD module (+1h) and everything since. That
      // pull's window may itself have been truncated at 2000 results, so it
      // is re-read rather than trusted. No history → 7 days.
      let coldStartMs = run.startedAt - COLD_START_LOOKBACK_MS;
      if (!state.pub.cursor || !state.mod.cursor) {
        const row = await env.DB.prepare(
          "SELECT last_successful_pull FROM feed_status WHERE feed_name = ?",
        )
          .bind(ctx.feedName || "nvd_cve")
          .first<{ last_successful_pull: string | null }>();
        const last = parseD1Utc(row?.last_successful_pull);
        if (last !== null) coldStartMs = Math.max(last - COLD_START_REREAD_MS, run.startedAt - MAX_RANGE_MS);
      }

      const pub = await drainLane(run, "pub", state.pub, coldStartMs);

      // A first page that never landed = NVD is down: fail the pull so the
      // circuit breaker sees it. Anything fetched before a later failure is
      // kept and the run succeeds with a warning.
      if (pub.error && pub.pages === 0) {
        if (JSON.stringify(state) !== before) await env.CACHE.put(CURSOR_KEY, JSON.stringify(state));
        throw new Error(pub.error);
      }

      let mod: LaneOutcome | null = null;
      if (pub.caughtUp && !pub.error) {
        mod = await drainLane(run, "mod", state.mod, coldStartMs);
      }

      const warnings: string[] = [];
      if (pub.error) warnings.push(`pub lane stopped: ${pub.error}`);
      if (pub.budgetStop) warnings.push(`pub lane budget reached at ${state.pub.window?.start ?? state.pub.cursor} index ${state.pub.window?.nextIndex ?? 0}; resumes next run`);
      if (mod?.error) warnings.push(`mod lane stopped: ${mod.error}`);
      if (mod?.budgetStop) warnings.push("mod lane budget reached; resumes next run");
      if (!mod && !pub.error) warnings.push("mod lane skipped: pub lane catching up");

      const nowMs = deps.now();
      const newCves = uniqueById(pub.cves);
      const newIds = new Set(newCves.map((c) => c.id));
      const updated = uniqueById(mod?.cves ?? []).filter(
        (c) => !newIds.has(c.id) && isLateUpdate(c, nowMs),
      );
      const itemsFetched = pub.cves.length + (mod?.cves.length ?? 0);

      const finish = async (itemsNew: number): Promise<FeedResult> => {
        // Cursor is written AFTER the digest: a failed put means the next
        // run re-reads (duplicates), never that CVEs go undigested.
        if (JSON.stringify(state) !== before) {
          try {
            await env.CACHE.put(CURSOR_KEY, JSON.stringify(state));
          } catch (err) {
            warnings.push(`cursor not saved: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return {
          itemsFetched,
          itemsNew,
          itemsDuplicate: Math.max(0, itemsFetched - itemsNew),
          itemsError: 0,
          ...(warnings.length ? { warning: `${warnings.join("; ")} (${run.requests} requests)` } : {}),
        };
      };

      if (newCves.length === 0 && updated.length === 0) return finish(0);

      const ranked = [
        ...newCves.map((c) => entryOf(c, "new")),
        ...updated.map((c) => entryOf(c, "updated")),
      ].sort(compareEntries);
      const rankedNew = ranked.filter((e) => e.kind === "new");
      const rankedUpdated = ranked.filter((e) => e.kind === "updated");

      const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      for (const e of rankedNew) counts[e.severity]++;

      const newestCve =
        [...newCves].sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""))[0]?.id ?? "none";
      const pubWindowStart = newCves.reduce<string | null>(
        (min, c) => (c.published && (!min || c.published < min) ? c.published : min),
        null,
      );

      const criticals = ranked.filter((e) => e.severity === "critical");
      const criticalList = criticals
        .slice(0, SUMMARY_CRITICAL_IDS)
        .map((e) => `${e.cve.id} (${scoreLabel(e)}${e.kind === "updated" ? ", updated" : ""})`)
        .join(", ");
      const topEntries = ranked
        .slice(0, 5)
        .map((e) => `${e.cve.id} (${scoreLabel(e)}) — ${englishDescription(e.cve).slice(0, 120)}`)
        .join("\n");

      const parts = [
        `NVD CVE Update: ${rankedNew.length} new CVEs published` +
          (pubWindowStart ? ` since ${pubWindowStart.slice(0, 16)}Z` : "") +
          ` (latest ${newestCve}). ${counts.critical} critical, ${counts.high} high, ` +
          `${counts.medium} medium, ${counts.low} low, ${counts.info} unscored.`,
      ];
      if (rankedUpdated.length > 0) {
        parts.push(
          `${rankedUpdated.length} recently published high/critical CVEs newly scored or updated.`,
        );
      }
      if (criticals.length > 0) {
        const more = criticals.length - SUMMARY_CRITICAL_IDS;
        parts.push(`CRITICAL (CVSS >= 9.0): ${criticalList}${more > 0 ? ` [+${more} more]` : ""}.`);
      }
      if (pub.budgetStop || pub.error) parts.push("Backfill in progress — more CVEs follow next run.");
      const summary = `${parts.join(" ")} Most severe:\n${topEntries}`;

      const details = JSON.stringify(
        selectDetails(ranked).map((e) => ({
          cve: e.cve.id,
          cvss: e.pick?.score ?? null,
          severity_band: e.pick?.band ?? null,
          published: e.cve.published,
          description: englishDescription(e.cve).slice(0, 500) || null,
          references: (e.cve.references ?? [])
            .slice(0, 5)
            .map((r) => r.url)
            .filter(Boolean),
          // Additive fields (2026-10-22).
          severity: e.severity,
          cvss_version: e.pick?.version ?? null,
          cvss_source_type: e.pick?.sourceType ?? null,
          cvss_source: e.pick?.source ?? null,
          max_cvss: e.max,
          last_modified: e.cve.lastModified ?? null,
          kind: e.kind,
        })),
      );

      // Digest severity = the worst tier present.
      const digestSeverity: Severity = ranked[0]?.severity === "info" ? "low" : (ranked[0]?.severity ?? "info");

      await env.DB.prepare(
        "INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at) VALUES (?, 'sentinel', 'insight', ?, ?, ?, datetime('now'))",
      )
        .bind(`nvd_${nowMs}`, summary, digestSeverity, details)
        .run();

      return finish(1);
    },
  };
}

export const nvd_cve: FeedModule = createNvdCveFeed();
