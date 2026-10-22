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
 *     toward the "new" totals. An "updated" entry is emitted only when it
 *     is newly reportable — never named in a digest before, or its tier
 *     rose since (`NvdCursorState.reported`, bounded at REPORTED_MAX) — and
 *     the summary names NEW criticals before updated ones.
 *
 * Each fetched page is cut to `SlimCve` at once (no CPE trees, ≤5 refs).
 *
 * Run time is bounded to ~60s (SOFT/HARD_BUDGET_MS) because the feed holds
 * a slot of the inline-awaited `runAllFeeds` pool in the hourly tick; a
 * backlog drains over several hourly runs instead. The previous run's
 * overlap ids (`pubTail`) are dropped from the "new" set, and a cursor that
 * stops moving for STALL_RUN_LIMIT runs fails the pull. That stall check
 * only catches the specific case where page 1 of a run lands but the pub
 * lane makes no forward progress (e.g. a resume page lands, every later
 * page fails); a run whose first page fails throws on its own, and a lane
 * that keeps advancing slowly is never "stalled".
 */

const NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0";

/** KV key holding the per-lane cursor state (JSON, `NvdCursorState`). */
export const CURSOR_KEY = "nvd_cve:cursor:v1";

/** Results per page. Smaller pages return well inside the request timeout. */
export const PAGE_SIZE = 500;
/** Floor for the adaptive page size (halved after a timed-out attempt). */
const MIN_PAGE_SIZE = 100;
/**
 * Per-request timeout. Sized so a page that times out on every attempt
 * still gets all FETCH_ATTEMPTS inside HARD_BUDGET_MS:
 * 18 + 1 + 18 + 3 + 18 = 58s ≤ 60s. Each timeout halves the page size.
 */
export const FETCH_TIMEOUT_MS = 18_000;
/** Attempts per page (transient failures only: timeout, network, 403, 429, 5xx). */
export const FETCH_ATTEMPTS = 3;
/** Extra backoff before a retry, on top of the rate-limit spacing. */
const RETRY_BACKOFF_MS = [1_000, 3_000];
/** Minimum spacing between requests: 5 req / 30s without a key, 50 with. */
export const SPACING_NO_KEY_MS = 6_500;
export const SPACING_WITH_KEY_MS = 700;

/**
 * Wall-clock budget for one run. The feed runs inside the hourly
 * orchestrator tick: `runAllFeeds` holds one of FEED_CONCURRENCY (4) pool
 * slots for the whole run and the orchestrator awaits it inline before
 * Sentinel / agent dispatch, so a long NVD run delays the whole tick.
 * No new PAGE starts at or after SOFT_BUDGET_MS; no REQUEST (incl. a retry)
 * starts unless it can time out by HARD_BUDGET_MS. Without a key that is
 * ~7 requests per run (6.5s spacing → starts at 0, 6.5, …, 39s); unfinished
 * work resumes from the cursor next hour.
 */
export const SOFT_BUDGET_MS = 40_000;
export const HARD_BUDGET_MS = 60_000;

/** NVD rejects a date range longer than 120 days. Stay a minute under. */
const MAX_RANGE_MS = 120 * 86_400_000 - 60_000;
/** Re-read this much before the cursor: absorbs NVD indexing lag. */
const CURSOR_OVERLAP_MS = 15 * 60_000;
/** On a mid-window resume, re-read this many results before the stored index
 *  (absorbs index shifts when a CVE inside the window is re-modified). */
const RESUME_OVERLAP = 25;
/** Max CVE ids carried in `pubTail` (overlap dedupe across runs). */
export const TAIL_MAX = 500;
/** Consecutive runs that fetched a page but moved no cursor → fail the pull. */
export const STALL_RUN_LIMIT = 3;
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

export interface NvdMetrics {
  cvssMetricV40?: NvdCvssMetric[];
  cvssMetricV31?: NvdCvssMetric[];
  cvssMetricV30?: NvdCvssMetric[];
  cvssMetricV2?: NvdCvssMetric[];
}

/**
 * A CVE as the NVD 2.0 API returns it. Only the fields this module reads
 * are typed; `configurations` / `weaknesses` (large CPE trees) are listed so
 * fixtures can carry them, and are dropped by `slimCve` on arrival.
 */
export interface NvdCve {
  id: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  descriptions?: Array<{ lang: string; value: string }>;
  metrics?: NvdMetrics;
  references?: Array<{ url?: string }>;
  configurations?: unknown[];
  weaknesses?: unknown[];
}

/**
 * What a run keeps in memory per CVE until the digest: classification and
 * digest fields only. A full NVD object carries the CPE configuration tree
 * and every reference, which for a multi-page backlog run is most of the
 * memory; `slimCve` cuts each page down right after `res.json()`.
 */
export interface SlimCve {
  id: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  /** Scored CVSS entries only (unscored ones are ignored by pickCvss/maxCvss). */
  metrics: NvdMetrics;
  /** English description, cut to DESCRIPTION_MAX chars. */
  description: string;
  /** First REFERENCE_MAX reference URLs. */
  references: string[];
}

interface NvdResponse {
  resultsPerPage?: number;
  startIndex?: number;
  totalResults?: number;
  vulnerabilities?: Array<{ cve?: NvdCve }>;
}

/** Longest description any digest field uses (`details[].description`). */
const DESCRIPTION_MAX = 500;
/** References kept per CVE (`details[].references`). */
const REFERENCE_MAX = 5;

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

/** Anything carrying NVD `metrics` — a raw `NvdCve` or a `SlimCve`. */
type HasMetrics = { metrics?: NvdMetrics };

/** Keep only the CVSS fields pickCvss / maxCvss read, scored entries only. */
function slimMetrics(metrics: NvdMetrics | undefined): NvdMetrics {
  const out: NvdMetrics = {};
  for (const [key] of METRIC_ORDER) {
    const list = (metrics?.[key] ?? []).filter(hasScore).map((m): NvdCvssMetric => {
      const slim: NvdCvssMetric = {
        cvssData: {
          baseScore: m.cvssData?.baseScore,
          ...(m.cvssData?.version !== undefined ? { version: m.cvssData.version } : {}),
          ...(m.cvssData?.baseSeverity !== undefined ? { baseSeverity: m.cvssData.baseSeverity } : {}),
        },
      };
      if (m.source !== undefined) slim.source = m.source;
      if (m.type !== undefined) slim.type = m.type;
      if (m.baseSeverity !== undefined) slim.baseSeverity = m.baseSeverity;
      return slim;
    });
    if (list.length > 0) out[key] = list;
  }
  return out;
}

/** Cut a raw NVD CVE down to what classification and the digest use. */
export function slimCve(raw: NvdCve): SlimCve {
  const slim: SlimCve = {
    id: raw.id,
    metrics: slimMetrics(raw.metrics),
    description: (raw.descriptions?.find((d) => d.lang === "en")?.value ?? "").slice(0, DESCRIPTION_MAX),
    references: (raw.references ?? [])
      .map((r) => r.url)
      .filter((u): u is string => typeof u === "string" && u.length > 0)
      .slice(0, REFERENCE_MAX),
  };
  if (raw.published !== undefined) slim.published = raw.published;
  if (raw.lastModified !== undefined) slim.lastModified = raw.lastModified;
  if (raw.vulnStatus !== undefined) slim.vulnStatus = raw.vulnStatus;
  return slim;
}

/**
 * Preferred CVSS metric: v4.0 > v3.1 > v3.0 > v2; within a version NVD's
 * own ('Primary') score, else the CNA-provided ('Secondary') one — a
 * freshly published CVE often carries only the CNA's score.
 */
export function pickCvss(cve: HasMetrics): CvssPick | null {
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
export function maxCvss(cve: HasMetrics): number | null {
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
export function classifyCve(cve: HasMetrics): Severity {
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
  /**
   * Ids of `pub` CVEs the next run will re-read (cursor overlap / resume
   * overlap). Dropped from the next digest's "new" set so an overlap
   * re-read is not reported twice. Bounded by TAIL_MAX.
   */
  pubTail: string[];
  /** Consecutive runs where page 1 landed but the pub lane didn't advance. */
  stalledRuns: number;
  /**
   * High/critical CVEs already named in a digest, with the SEVERITY_RANK of
   * the tier they were last reported at, least recently reported first.
   * A `mod`-lane CVE is reported as "updated" only when it is absent here or
   * its tier rose, so an NVD reference/CPE/status touch (and the mod lane's
   * 15-min overlap re-read) doesn't re-report it. Bounded by REPORTED_MAX:
   * the oldest entries are evicted. Serialized as [id, rank] pairs.
   */
  reported: Array<[string, number]>;
}

/**
 * Max ids in `NvdCursorState.reported`. ~21 bytes per `["CVE-2026-109618",4]`
 * pair → ≤ ~110 KB of KV value. Only high/critical CVEs are recorded (tens
 * per day), so 5,000 covers well past UPDATED_MAX_AGE_MS (30 days) — the
 * oldest a CVE can be and still be reported as "updated".
 */
export const REPORTED_MAX = 5_000;

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
  const tail = Array.isArray(o.pubTail)
    ? o.pubTail.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 40).slice(-TAIL_MAX)
    : [];
  const stalled =
    typeof o.stalledRuns === "number" && Number.isInteger(o.stalledRuns) && o.stalledRuns >= 0 ? o.stalledRuns : 0;
  const reported = new Map<string, number>();
  if (Array.isArray(o.reported)) {
    for (const e of o.reported) {
      if (
        Array.isArray(e) &&
        typeof e[0] === "string" &&
        e[0].length > 0 &&
        e[0].length <= 40 &&
        typeof e[1] === "number" &&
        Number.isInteger(e[1]) &&
        e[1] >= 0 &&
        e[1] <= SEVERITY_RANK.critical
      ) {
        // Re-insert so a duplicate id keeps its LAST position (most recent).
        reported.delete(e[0]);
        reported.set(e[0], e[1]);
      }
    }
  }
  return {
    v: 1,
    pub: parseLane(o.pub),
    mod: parseLane(o.mod),
    pubTail: tail,
    stalledRuns: stalled,
    reported: [...reported].slice(-REPORTED_MAX),
  };
}

/**
 * Record `entries` as reported at their current tier, most recent last,
 * evicting the oldest past REPORTED_MAX. Only high/critical entries are
 * recorded: lower tiers are never "updated" candidates, and a CVE first
 * reported below high that later turns high/critical is a tier rise anyway.
 */
export function recordReported(
  reported: Array<[string, number]>,
  entries: Array<{ id: string; severity: Severity }>,
): Array<[string, number]> {
  const map = new Map(reported);
  for (const e of entries) {
    const rank = SEVERITY_RANK[e.severity];
    if (rank < SEVERITY_RANK.high) continue;
    map.delete(e.id);
    map.set(e.id, rank);
  }
  return [...map].slice(-REPORTED_MAX);
}

/** A `mod`-lane CVE is newly reportable when never reported or its tier rose. */
function isNewlyReportable(reported: Map<string, number>, id: string, severity: Severity): boolean {
  const prev = reported.get(id);
  return prev === undefined || SEVERITY_RANK[severity] > prev;
}

/** NVD timestamps carry no zone ("2026-10-22T11:50:00.000"); they are UTC. */
function parseNvdTime(v: string | undefined): number {
  if (!v) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + "Z");
}

/** Did the pub lane move forward between `b` (run start) and `a` (run end)? */
export function pubProgressed(b: LaneState, a: LaneState): boolean {
  const bc = b.cursor ? Date.parse(b.cursor) : -Infinity;
  const ac = a.cursor ? Date.parse(a.cursor) : -Infinity;
  if (ac !== bc) return ac > bc;
  const ai = a.window?.nextIndex ?? 0;
  const sameWindow =
    !!b.window && !!a.window && b.window.start === a.window.start && b.window.end === a.window.end;
  return sameWindow ? ai > (b.window?.nextIndex ?? 0) : ai > 0;
}

/**
 * Ids the NEXT run will re-read from the pub lane, i.e. what must not be
 * reported as new again:
 *   - window part-read (nextIndex > 0): the last RESUME_OVERLAP results
 *     fetched (the resume re-reads them by index);
 *   - fresh window (nextIndex 0, opened just before the budget stop): CVEs
 *     published at or after the window start — the next run reads it from
 *     index 0, i.e. from cursor − CURSOR_OVERLAP_MS;
 *   - no window: CVEs published at or after cursor − CURSOR_OVERLAP_MS (the
 *     next window starts there).
 * Derived from THIS run's fetch only (re-read ids included), so it can't grow
 * without bound; capped at TAIL_MAX, keeping the most recent.
 */
function computePubTail(fetched: SlimCve[], lane: LaneState): string[] {
  const ids = new Set<string>();
  if (lane.window && lane.window.nextIndex > 0) {
    for (const c of fetched.slice(-RESUME_OVERLAP)) ids.add(c.id);
  } else {
    const cut = lane.window
      ? Date.parse(lane.window.start)
      : lane.cursor
        ? Date.parse(lane.cursor) - CURSOR_OVERLAP_MS
        : NaN;
    if (Number.isFinite(cut)) {
      for (const c of fetched) {
        if (parseNvdTime(c.published) >= cut) ids.add(c.id);
      }
    }
  }
  return [...ids].slice(-TAIL_MAX);
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

/**
 * Retryable HTTP statuses. NVD has historically answered rate limiting
 * with 403 rather than 429, and the Worker's egress IPs are shared, so a
 * 403 is treated as a rate-limit hit and retried with the usual backoff.
 */
function isTransientStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

/** One fetched page, CVEs already slimmed. */
interface NvdPage {
  cves: SlimCve[];
  /** Raw result count (pagination math), incl. entries without an id. */
  returned: number;
  totalResults: number;
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
): Promise<NvdPage | null> {
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
          const body = (await res.json()) as NvdResponse;
          // Slim at once: the raw page (CPE trees, every reference) is
          // dropped here instead of living until the digest.
          const vulns = body.vulnerabilities ?? [];
          return {
            cves: vulns
              .map((v) => v.cve)
              .filter((c): c is NvdCve => !!c?.id)
              .map(slimCve),
            returned: vulns.length,
            totalResults: typeof body.totalResults === "number" ? body.totalResults : 0,
          };
        } catch (err) {
          lastError = `NVD JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        lastError = `NVD HTTP ${res.status}`;
        if (!isTransientStatus(res.status)) {
          // 4xx other than 403/429 (bad params, bad apiKey) won't fix itself.
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
  cves: SlimCve[];
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
    let page: NvdPage | null;
    try {
      page = await fetchPage(run, lane, w, startIndex);
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
      return out;
    }
    if (page === null) {
      out.budgetStop = true;
      return out;
    }
    out.pages++;

    for (const c of page.cves) out.cves.push(c);

    const returned = page.returned;
    const total = page.totalResults;
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
  cve: SlimCve;
  kind: "new" | "updated";
  severity: Severity;
  pick: CvssPick | null;
  max: number | null;
}

function entryOf(cve: SlimCve, kind: "new" | "updated"): DigestEntry {
  return { cve, kind, severity: classifyCve(cve), pick: pickCvss(cve), max: maxCvss(cve) };
}

/**
 * Severity tier first, then new before updated (a newly published CVE is
 * the headline; an "updated" one is a re-score of something older), then
 * preferred score, then max score, then id.
 */
export function compareEntries(a: DigestEntry, b: DigestEntry): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    (a.kind === b.kind ? 0 : a.kind === "new" ? -1 : 1) ||
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

/**
 * One copy per id: the most recently modified one (overlap re-reads), chosen
 * BEFORE dropping Rejected — a CVE rejected after an earlier copy was read
 * must disappear, not fall back to the stale pre-rejection copy.
 */
function uniqueById(cves: SlimCve[]): SlimCve[] {
  const seen = new Map<string, SlimCve>();
  for (const c of cves) {
    const prev = seen.get(c.id);
    if (!prev) {
      seen.set(c.id, c);
      continue;
    }
    const tc = parseNvdTime(c.lastModified);
    const tp = parseNvdTime(prev.lastModified);
    // Later copy wins ties and an unparseable previous timestamp.
    if (!Number.isFinite(tp) || (Number.isFinite(tc) && tc >= tp)) seen.set(c.id, c);
  }
  return [...seen.values()].filter((c) => c.vulnStatus !== "Rejected");
}

/** `mod`-lane CVE worth surfacing as "updated" (see module header). */
function isLateUpdate(cve: SlimCve, nowMs: number): boolean {
  const pub = parseNvdTime(cve.published);
  const mod = parseNvdTime(cve.lastModified);
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
      const pubBefore: LaneState = {
        cursor: state.pub.cursor,
        window: state.pub.window ? { ...state.pub.window } : null,
      };
      const prevTail = new Set(state.pubTail);

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

      // Failure paths save the cursor, then fail the pull. A KV error while
      // saving is logged, never thrown: the NVD / stall error is the one the
      // circuit breaker and feed_pull_history must see.
      const saveCursorThenThrow = async (original: Error): Promise<never> => {
        try {
          await env.CACHE.put(CURSOR_KEY, JSON.stringify(state));
        } catch (kvErr) {
          await logFeedDiagnostic(env.DB, {
            feedName: "nvd_cve", url: CURSOR_KEY, method: "KV_PUT", httpStatus: null, bodyPreview: "",
            errorMessage: `cursor not saved while failing the pull (${original.message}): ${
              kvErr instanceof Error ? kvErr.message : String(kvErr)
            }`,
          });
        }
        throw original;
      };

      const pub = await drainLane(run, "pub", state.pub, coldStartMs);

      // A first page that never landed = NVD is down: fail the pull so the
      // circuit breaker sees it. Anything fetched before a later failure is
      // kept and the run succeeds with a warning.
      if (pub.error && pub.pages === 0) {
        if (JSON.stringify(state) !== before) await saveCursorThenThrow(new Error(pub.error));
        throw new Error(pub.error);
      }

      // Page 1 landed. Track whether the pub lane moved; STALL_RUN_LIMIT runs
      // in a row without movement fail the pull, so the circuit breaker and
      // Flight Control see a stuck cursor instead of a warning forever.
      state.pubTail = computePubTail(pub.cves, state.pub);
      state.stalledRuns = pubProgressed(pubBefore, state.pub) ? 0 : state.stalledRuns + 1;
      if (state.stalledRuns >= STALL_RUN_LIMIT) {
        await saveCursorThenThrow(
          new Error(
            `NVD pub cursor stalled: no forward progress for ${state.stalledRuns} consecutive runs ` +
              `(cursor ${state.pub.cursor ?? "none"}, window ${state.pub.window?.start ?? "none"} ` +
              `index ${state.pub.window?.nextIndex ?? 0})` +
              (pub.error ? `: ${pub.error}` : ""),
          ),
        );
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
      // Overlap re-reads of CVEs the previous run already digested are
      // fetched (cheap) but not reported as new again.
      const pubCves = uniqueById(pub.cves);
      const newCves = pubCves.filter((c) => !prevTail.has(c.id));
      const pubIds = new Set(pubCves.map((c) => c.id));
      // "updated" only when newly reportable: never named before, or its tier
      // rose since (e.g. unscored → critical, high → critical). NVD touches a
      // CVE for reference adds, CPE passes and status changes too; those, and
      // the mod lane's own overlap re-read, must not re-report it.
      const reportedMap = new Map(state.reported);
      const updated = uniqueById(mod?.cves ?? []).filter(
        (c) => !pubIds.has(c.id) && isLateUpdate(c, nowMs) && isNewlyReportable(reportedMap, c.id, classifyCve(c)),
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

      // Summary criticals: NEW ones take the slots first; "updated" ones only
      // fill what is left, in their own labelled sentence. The Observer reads
      // only the summary, so a burst of re-scored CVEs must never push a newly
      // published critical into "[+N more]".
      const newCriticals = rankedNew.filter((e) => e.severity === "critical");
      const updatedCriticals = rankedUpdated.filter((e) => e.severity === "critical");
      const shownNew = newCriticals.slice(0, SUMMARY_CRITICAL_IDS);
      const shownUpdated = updatedCriticals.slice(0, SUMMARY_CRITICAL_IDS - shownNew.length);
      const listOf = (es: DigestEntry[]) => es.map((e) => `${e.cve.id} (${scoreLabel(e)})`).join(", ");
      const topEntries = ranked
        .slice(0, 5)
        .map(
          (e) =>
            `${e.cve.id} (${scoreLabel(e)}${e.kind === "updated" ? ", updated" : ""}) — ${e.cve.description.slice(0, 120)}`,
        )
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
      if (newCriticals.length > 0) {
        const more = newCriticals.length - shownNew.length;
        parts.push(`CRITICAL (CVSS >= 9.0): ${listOf(shownNew)}${more > 0 ? ` [+${more} more]` : ""}.`);
      }
      if (updatedCriticals.length > 0) {
        const more = updatedCriticals.length - shownUpdated.length;
        parts.push(
          shownUpdated.length > 0
            ? `UPDATED to CRITICAL (re-scored, published earlier): ${listOf(shownUpdated)}${more > 0 ? ` [+${more} more]` : ""}.`
            : `UPDATED to CRITICAL (re-scored, published earlier): ${more} (see details).`,
        );
      }
      if (pub.budgetStop || pub.error) parts.push("Backfill in progress — more CVEs follow next run.");
      const summary = `${parts.join(" ")} Most severe:\n${topEntries}`;

      const detailEntries = selectDetails(ranked);
      const details = JSON.stringify(
        detailEntries.map((e) => ({
          cve: e.cve.id,
          cvss: e.pick?.score ?? null,
          severity_band: e.pick?.band ?? null,
          published: e.cve.published,
          description: e.cve.description || null,
          references: e.cve.references,
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

      // Digest landed: remember the CVEs it named (saved with the cursor by
      // finish). Entries cut from `details` aren't recorded, so a later
      // "updated" copy of one of them can still be reported.
      state.reported = recordReported(
        state.reported,
        detailEntries.map((e) => ({ id: e.cve.id, severity: e.severity })),
      );

      return finish(1);
    },
  };
}

export const nvd_cve: FeedModule = createNvdCveFeed();
