// Averrow — Admin handlers: pipeline
// Split from handlers/admin.ts (S3.4a). Behavior-preserving move.

import { z } from "zod";
import { json, corsHeaders } from "../../lib/cors";
import { audit } from "../../lib/audit";
import type { Env, UserRole, UserStatus } from "../../types";
import { runSyncAgent } from "../../lib/agentRunner";
import { adminClassifyAgent, type AdminClassifyOutput } from "../../agents/admin-classify";
import { callAnthropicJSON } from "../../lib/anthropic";
import { estimateCost } from "../../lib/budgetManager";
import { HOT_PATH_HAIKU } from "../../lib/ai-models";
import { enrichThreatsGeo, PRIVATE_IP_SQL_FILTER } from "../../lib/geoip";
import { fuzzyMatchBrand } from "../../lib/brandDetect";
import { cachedCount } from "../../lib/cached-count";
import { cachedValue } from "../../lib/cached-value";
import { getReadSession, getDbContext } from "../../lib/db";
import { computeFeedSeverity } from "../../lib/feed-severity";
import type { AuthContext } from "../../middleware/auth";
import { classifySaasTechnique } from "../../lib/saas-classifier";
import { BudgetManager, type BudgetStatus } from "../../lib/budgetManager";
import {
  buildGeoCubeForHour,
  buildProviderCubeForHour,
  buildBrandCubeForHour,
  buildStatusCubeForHour,
  buildArcsCubeForHour,
  countGeoCubeForHour,
  countProviderCubeForHour,
  countBrandCubeForHour,
  countStatusCubeForHour,
  countArcsCubeForHour,
} from "../../lib/cube-builder";


// ─── Pipeline Status (reads pre-computed data only — no COUNT queries) ───

// Maps backlog_history names to display labels and owning agents.
// `endpoints` lists the external HTTP services this pipeline calls
// (DNS resolvers, third-party threat-intel APIs, etc.). Surfaced
// in the Pipeline Automation card so operators can see the off-
// platform dependencies for each pipeline.
//
// `description` is a one-line plain-English subtitle rendered under
// the pipeline label on the Agents-Monitor card. It answers "what
// does this pipeline DO?" so an operator who hasn't read the agent
// docs can still triage. Keep these tight (≤80 chars).
type PipelineMeta = {
  label: string;
  description: string;
  agent: string;
  schedule: string;
  endpoints?: Array<{ name: string; url: string }>;
  /** Multi-line plain-English explanation of the pipeline's
   *  dynamics: when does the backlog grow vs drain, what are the
   *  rate-limits or external dependencies, what does an operator
   *  do if it's stuck. Surfaced in the drill-down detail sheet. */
  why_grows?: string;
  /** Optional `feed_pull_history.feed_name` mapping. Used by the
   *  detail sheet to compute 24h failure-rate stats for pipelines
   *  that pull from an external feed. Most agent-driven pipelines
   *  (cartographer, analyst, brand_enrich, domain_geo) have no
   *  feed mapping — they enrich existing rows rather than pulling
   *  new ones. */
  feed_name?: string;
};

const PIPELINE_META: Record<string, PipelineMeta> = {
  cartographer: {
    label: 'Geo Enrichment',
    description: 'IPs awaiting country / lat-lng / ASN resolution.',
    agent: 'cartographer',
    schedule: 'hourly',
    why_grows:
      'Grows when feed inflow exceeds the ~2,500 IPs Cartographer can ' +
      'enrich per hour (5 batches × 500). Phase 0 calls ip-api.com (free ' +
      '15 req/min) and Phase 0.5 falls back to the local MaxMind range ' +
      'table for IPs both APIs miss. Drains naturally as Cartographer ' +
      'catches up; Flight Control scales it up to 3 parallel instances ' +
      'when the queue passes its high-water mark.',
  },
  analyst: {
    label: 'Brand Matching',
    description: 'Threats awaiting brand attribution via Haiku scoring.',
    agent: 'analyst',
    schedule: 'hourly',
    why_grows:
      'Grows when threats land faster than the Analyst can score them. ' +
      'Each call is one Haiku invocation per threat (or per cluster of ' +
      'similar threats). Flight Control scales to 3 parallel Analyst ' +
      'instances when the unlinked-threat backlog passes 50k. Throttled ' +
      'down or paused when AI budget enters hard / emergency state.',
  },
  domain_geo: {
    label: 'DNS Resolution',
    description:
      'Domains awaiting A-record resolution to source IP. Backed by ' +
      'a side-DB queue (trust-radar-dns-queue) populated by the ' +
      'cursor-paginated reconciler and swept daily by the reaper.',
    agent: 'navigator',
    schedule: '5 min',
    endpoints: [
      { name: 'Cloudflare 1.1.1.1', url: 'https://cloudflare-dns.com' },
      { name: 'Google DNS',         url: 'https://dns.google' },
      { name: 'Quad9 DNS',          url: 'https://dns.quad9.net:5053' },
    ],
    why_grows:
      'Grows when Navigator hits resolver rate limits or when feeds ' +
      'emit domains that already 5x-failed resolution (those are skipped ' +
      'after the cap to avoid re-asking dead resolvers). Three resolvers ' +
      'rotate per call so a single resolver outage just slows things ' +
      'rather than halts them. The reconciler enqueues NEW threat ' +
      'candidates each Navigator tick using a KV cursor — old rows ' +
      'whose threats flipped to inactive are cleared by the once-per-' +
      'day reaper (sweeps dns_queue at hour===0 UTC).',
  },
  brand_enrich: {
    label: 'Brand Enrichment',
    description: 'Brands awaiting favicon / HQ geo / exposure-score backfill.',
    agent: 'enricher',
    schedule: 'hourly',
    why_grows:
      'Grows whenever a new brand is registered (Tranco import, manual ' +
      'add, social-discovery) before the Enricher tick lands. Drains ' +
      'within 1–2 hours under normal load. Stuck rows usually mean the ' +
      'brand has a malformed canonical_domain or no public website.',
  },
  surbl: {
    label: 'SURBL',
    description: 'SURBL spam-URL blocklist lookup queue.',
    agent: 'surbl',
    schedule: 'hourly',
    feed_name: 'surbl',
    why_grows:
      'Grows when the SURBL feed pull fails (DNS, HTTP) or when the agent ' +
      'is paused by Flight Control. Re-pulls on the next hourly cron tick.',
  },
  virustotal: {
    label: 'VirusTotal',
    description: 'Domains awaiting VirusTotal verdict (4 req/min on free tier).',
    agent: 'virustotal',
    schedule: 'hourly',
    feed_name: 'virustotal',
    why_grows:
      'Grows when feed inflow exceeds the 4 req/min API quota (free tier) ' +
      'or when VT returns 429s during peak hours. Each domain is checked ' +
      'at most once per 24h — repeat lookups are skipped via the ' +
      '`vt_checked_at` stamp.',
  },
  gsb: {
    label: 'Safe Browsing',
    description: 'Google Safe Browsing lookups for malicious URLs.',
    agent: 'gsb',
    schedule: 'hourly',
    feed_name: 'google_safe_browsing',
    why_grows:
      'Grows when the GSB API returns transient 5xxs or rate-limits. ' +
      'Most threats clear in one tick; persistent backlog usually means ' +
      'the API key has hit its daily quota.',
  },
  dbl: {
    label: 'Spamhaus DBL',
    description: 'Spamhaus Domain Block List reputation lookups.',
    agent: 'dbl',
    schedule: 'hourly',
    feed_name: 'spamhaus_dbl',
    why_grows:
      'Grows when the DBL DNSBL query fails (UDP packet loss is common). ' +
      'Re-runs on the next hourly tick. Spamhaus rate-limits at 100k ' +
      'queries/day for free non-commercial use.',
  },
  abuseipdb: {
    label: 'AbuseIPDB',
    description: 'Malicious IPs awaiting AbuseIPDB reputation (1k req/day cap).',
    agent: 'abuseipdb',
    schedule: 'hourly',
    feed_name: 'abuseipdb',
    why_grows:
      'Grows when threat inflow exceeds the 1,000 req/day quota on the ' +
      'free tier. Resets at 00:00 UTC. Persistent growth means the cap ' +
      'is too tight for current inflow — upgrade the API tier or ' +
      'deprioritize lower-confidence IPs.',
  },
  pdns: {
    label: 'Passive DNS',
    description: 'Historical DNS-records lookup queue.',
    agent: 'pdns',
    schedule: 'hourly',
    why_grows:
      'Grows when Mnemonic / Farsight pDNS APIs throttle. Mostly used ' +
      'for high-severity domains; lower-severity rows wait or get ' +
      'skipped after the retry cap.',
  },
  greynoise: {
    label: 'GreyNoise',
    description: 'Internet-noise classification (filters scanners / honeypot traffic).',
    agent: 'greynoise',
    schedule: 'hourly',
    feed_name: 'greynoise',
    why_grows:
      'Grows when GreyNoise quota is exhausted (free tier: 10k IPs/day). ' +
      'Resets at 00:00 UTC. Persistent backlog suggests inflow > daily ' +
      'quota — most useful as a filter, not a per-threat enrichment.',
  },
  seclookup: {
    label: 'SecLookup',
    description: 'Domain reputation enrichment queue.',
    agent: 'seclookup',
    schedule: 'hourly',
    why_grows:
      'Grows when SecLookup API throttles or when the score-cache window ' +
      'expires for many domains at once. Drains within 2–3 hourly ticks ' +
      'under normal conditions.',
  },
};

/**
 * Verdict pill displayed on each Pipeline Automation card. Replaces
 * the cryptic `↓ 2,424` trend text with a one-word health label.
 *
 * The semantics differ for reference datasets (geoip — more rows is
 * good, "up" → UPDATED) vs backlogs (everything else — fewer rows
 * is good, "down" → DRAINING). Computed server-side so the UI just
 * renders what's there and we keep the encoding rule in one place.
 */
type VerdictTone = 'success' | 'warning' | 'failed' | 'pending' | 'inactive';
type Verdict = { label: string; tone: VerdictTone };

function computeBacklogVerdict(
  count: number,
  trendDirection: 'up' | 'down' | 'flat' | 'unknown',
): Verdict {
  if (count === 0) return { label: 'CLEAR', tone: 'success' };
  switch (trendDirection) {
    case 'down':    return { label: 'DRAINING', tone: 'success' };
    case 'up':      return { label: 'GROWING',  tone: 'failed'  };
    case 'flat':    return { label: 'STEADY',   tone: 'inactive' };
    case 'unknown': return { label: 'STALE',    tone: 'pending' };
  }
}

function computeReferenceDatasetVerdict(
  count: number,
  configured: boolean,
  rowsWritten: number,
  // NX-geoip-card: refresh status + age give the card three more states.
  refreshStatus?: string | null,
  lastRefreshAt?: string | null,
): Verdict {
  if (!configured)  return { label: 'SETUP',   tone: 'pending'  };
  if (count === 0)  return { label: 'EMPTY',   tone: 'failed'   };
  if (refreshStatus === 'running') return { label: 'REFRESHING', tone: 'pending' };
  if (refreshStatus === 'failed' && lastRefreshAt) {
    return { label: 'FAILED', tone: 'failed' };
  }
  // Reference-dataset staleness: MaxMind ships weekly; > 7d is stale,
  // > 14d is stale-critical. Computed in JS to keep the helper pure.
  if (lastRefreshAt) {
    const ageMs = Date.now() - new Date(lastRefreshAt + 'Z').getTime();
    const ageDays = ageMs / 86_400_000;
    if (ageDays > 14) return { label: 'STALE',  tone: 'failed'  };
    if (ageDays > 7)  return { label: 'STALE',  tone: 'pending' };
  }
  if (rowsWritten > 0) return { label: 'UPDATED', tone: 'success' };
  return { label: 'STABLE', tone: 'inactive' };
}

export async function handlePipelineStatus(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  // v4 prefix invalidates v3's pre-sparkline shape so the new
  // per-card sparkline arrays land on first deploy.
  const cacheKey = "pipeline_status_v4";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // Read 24h of snapshots per backlog from backlog_history (pre-computed by FC).
  // ROW_NUMBER over the full window gives us current + previous for
  // trend; the same rows feed the per-pipeline sparkline arrays
  // returned alongside, so cards can render a 24h backlog trend
  // without fanning out a usePipelineDetail call per pipeline.
  const [historyRows, agentRuns] = await Promise.all([
    env.DB.prepare(`
      SELECT backlog_name, count, recorded_at,
             ROW_NUMBER() OVER (PARTITION BY backlog_name ORDER BY recorded_at DESC) AS rn
      FROM backlog_history
      WHERE recorded_at > datetime('now', '-1 day')
    `).all<{ backlog_name: string; count: number; recorded_at: string; rn: number }>(),

    // Last run per agent for "last processed" timestamp and throughput
    env.DB.prepare(`
      SELECT agent_id, MAX(completed_at) AS last_run_at,
             records_processed, duration_ms, status
      FROM agent_runs
      WHERE completed_at > datetime('now', '-24 hours')
      GROUP BY agent_id
    `).all<{ agent_id: string; last_run_at: string; records_processed: number; duration_ms: number; status: string }>(),
  ]);

  // Build latest + previous per backlog
  const latestByName = new Map<string, { count: number; recorded_at: string }>();
  const previousByName = new Map<string, { count: number; recorded_at: string }>();
  // Per-pipeline 24h sparkline series (oldest → newest). Same source
  // rows the latest/previous derivation uses, just collated into
  // an array per pipeline. ~12 samples / 24h × ~15 pipelines = ~180
  // rows total to bucket in JS — negligible.
  const sparklineByName = new Map<string, Array<{ count: number; recorded_at: string }>>();
  for (const row of historyRows.results) {
    if (row.rn === 1) latestByName.set(row.backlog_name, { count: row.count, recorded_at: row.recorded_at });
    if (row.rn === 2) previousByName.set(row.backlog_name, { count: row.count, recorded_at: row.recorded_at });
    const arr = sparklineByName.get(row.backlog_name);
    const sample = { count: row.count, recorded_at: row.recorded_at };
    if (arr) arr.push(sample);
    else sparklineByName.set(row.backlog_name, [sample]);
  }
  // ROW_NUMBER ordered DESC; flip to chronological for the chart.
  for (const arr of sparklineByName.values()) arr.reverse();

  // Build agent last-run map
  const agentLastRun = new Map(agentRuns.results.map(r => [r.agent_id, r]));

  // Assemble pipeline entries
  const pipelines = Object.entries(PIPELINE_META).map(([name, meta]) => {
    const latest = latestByName.get(name);
    const previous = previousByName.get(name);
    const agentRun = agentLastRun.get(meta.agent);

    const count = latest?.count ?? 0;
    const prevCount = previous?.count ?? null;
    const trend = prevCount !== null ? count - prevCount : null;

    const trendDirection: 'up' | 'down' | 'flat' | 'unknown' =
      trend === null ? 'unknown' : trend < 0 ? 'down' : trend > 0 ? 'up' : 'flat';
    return {
      id: name,
      label: meta.label,
      description: meta.description,
      agent: meta.agent,
      schedule: meta.schedule,
      endpoints: meta.endpoints ?? null,
      count,
      prev_count: prevCount,
      trend,                               // negative = draining, positive = growing, null = no data
      trend_direction: trendDirection,
      verdict: computeBacklogVerdict(count, trendDirection),
      last_measured_at: latest?.recorded_at ?? null,
      agent_last_run_at: agentRun?.last_run_at ?? null,
      agent_last_status: agentRun?.status ?? null,
      agent_records_processed: agentRun?.records_processed ?? null,
      sparkline: sparklineByName.get(name) ?? [],
    };
  });

  // GeoIP DB pipeline entry — synthetic because GeoIP isn't a
  // backlog (no rows draining toward zero); it's a reference
  // dataset whose health is "is the table populated and recently
  // refreshed?". Pulling the row count + last refresh from the
  // dedicated GEOIP_DB lets the Pipeline Automation card
  // surface this as one tile alongside Geo Enrichment and DNS
  // Resolution. count=row_count, prev_count=row_count - rows_written
  // so the "trend" arrow shows what the most recent refresh added.
  const geoipAgentRun = agentLastRun.get('geoip_refresh');
  try {
    const { getGeoMmdbStatus } = await import("../../lib/geoip-mmdb");
    const geoipStatus = await getGeoMmdbStatus(env);
    const rowCount = geoipStatus.row_count ?? 0;
    const rowsWritten = geoipStatus.last_refresh_rows_written ?? 0;
    const prev = rowCount - rowsWritten;
    const trend = rowsWritten > 0 ? rowsWritten : null;
    pipelines.push({
      id: 'geoip',
      label: 'GeoIP Database',
      description: 'MaxMind GeoLite2 IP→geo range table. Refreshed weekly.',
      agent: 'geoip_refresh',
      schedule: 'monthly',
      endpoints: [
        { name: 'MaxMind GeoLite2', url: 'https://download.maxmind.com' },
      ],
      count: rowCount,
      prev_count: prev,
      // For GeoIP, "up" trend means more rows = good (opposite of
      // backlog metrics). The Pipeline card uses trend_direction
      // for arrow styling — keep it neutral when configured but
      // empty so it doesn't look alarming pre-load.
      trend,
      trend_direction: !geoipStatus.configured
        ? 'unknown'
        : rowCount === 0
          ? 'flat'
          : (rowsWritten > 0 ? 'up' : 'flat'),
      verdict: computeReferenceDatasetVerdict(
        rowCount,
        geoipStatus.configured,
        rowsWritten,
        geoipStatus.last_refresh_status,
        geoipStatus.last_refresh_at,
      ),
      last_measured_at: geoipStatus.last_refresh_at,
      agent_last_run_at: geoipAgentRun?.last_run_at ?? null,
      agent_last_status: geoipStatus.last_refresh_status ?? geoipAgentRun?.status ?? null,
      agent_records_processed: rowsWritten,
      // GeoIP isn't a backlog — no per-hour count history. Empty
      // array keeps the response shape stable; the card will skip
      // the sparkline render.
      sparkline: [],
    });
  } catch (err) {
    console.error('[pipeline-status] geoip status error:', err);
    // Non-fatal — surface a "not configured" tile so the operator
    // sees the line item instead of nothing.
    pipelines.push({
      id: 'geoip',
      label: 'GeoIP Database',
      description: 'MaxMind GeoLite2 IP→geo range table. Refreshed weekly.',
      agent: 'geoip_refresh',
      schedule: 'monthly',
      endpoints: [{ name: 'MaxMind GeoLite2', url: 'https://download.maxmind.com' }],
      count: 0,
      prev_count: null,
      trend: null,
      trend_direction: 'unknown',
      verdict: { label: 'SETUP', tone: 'pending' },
      last_measured_at: null,
      agent_last_run_at: null,
      agent_last_status: 'unconfigured',
      agent_records_processed: null,
      sparkline: [],
    });
  }

  const data = { success: true, data: pipelines };
  await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
  return json(data, 200, origin);
}

// ─── Pipeline Detail (drill-down) ────────────────────────────────
//
// GET /api/admin/pipeline-status/:id
//
// Powers the tap-to-drill-down sheet on the Agents-Monitor view.
// Returns the same per-pipeline shape as `handlePipelineStatus`
// PLUS:
//   - sparkline:           24h hourly backlog series
//   - drained_last_hour:   delta vs the hour-ago snapshot
//   - last_run:            most recent agent_runs row for the
//                          owning agent (status, records, duration)
//   - failure_rate_24h:    feed_pull_history aggregate (only for
//                          pipelines mapped to a feed_name)
//   - why_grows:           plain-English explanation of the
//                          pipeline's growth dynamics
//
// Cached separately under `pipeline_detail:<id>:v1` for 60s.
// Detail pages don't need the same 5-min freshness as the list —
// operators tap through during a triage session and want fresh
// numbers, but the underlying queries are cheap enough that 60s
// cache + index-driven scans keeps D1 spend negligible.
export async function handlePipelineDetail(
  request: Request,
  env: Env,
  pipelineId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const cacheKey = `pipeline_detail:${pipelineId}:v1`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    try {
      return json(JSON.parse(cached), 200, origin);
    } catch (err) {
      console.error(`[pipeline-detail] corrupt cache for ${cacheKey}, recomputing:`, err);
      await env.CACHE.delete(cacheKey);
    }
  }

  // Geoip is special — its "backlog" is row count, not a draining
  // queue. Detail-sheet treatment is the same shape, just with
  // different prose.
  if (pipelineId === 'geoip') {
    try {
      return await handleGeoipDetail(request, env, origin);
    } catch (err) {
      console.error('[pipeline-detail] handleGeoipDetail threw:', err);
      return json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }, 500, origin);
    }
  }

  const meta = PIPELINE_META[pipelineId];
  if (!meta) {
    return json({ success: false, error: `Unknown pipeline: ${pipelineId}` }, 404, origin);
  }

  // Parallel queries — all index-driven, all bounded.
  const [history, agentRun, feedStats] = await Promise.all([
    // 24h sparkline. Each pipeline gets ~12 samples/24h (FC writes
    // backlog snapshots roughly hourly), so this returns at most
    // ~30 rows.
    env.DB.prepare(`
      SELECT count, recorded_at
        FROM backlog_history
       WHERE backlog_name = ?
         AND recorded_at >= datetime('now', '-1 day')
       ORDER BY recorded_at ASC
    `).bind(pipelineId).all<{ count: number; recorded_at: string }>(),

    // Latest agent run for the owning agent. Used for "Last run"
    // row in the sheet. Bounded to 24h so the index range scan
    // stays cheap.
    env.DB.prepare(`
      SELECT started_at, completed_at, duration_ms, status,
             records_processed, error_message
        FROM agent_runs
       WHERE agent_id = ?
         AND started_at >= datetime('now', '-1 day')
       ORDER BY started_at DESC
       LIMIT 1
    `).bind(meta.agent).first<{
      started_at: string;
      completed_at: string | null;
      duration_ms: number | null;
      status: string;
      records_processed: number | null;
      error_message: string | null;
    }>(),

    // Failure rate from feed_pull_history. Only computed for
    // pipelines mapped to a feed_name — agent-driven enrichment
    // pipelines (cartographer, analyst, brand_enrich, domain_geo)
    // have no feed_pull_history rows.
    meta.feed_name
      ? env.DB.prepare(`
          SELECT
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
            COUNT(*) AS total
          FROM feed_pull_history
          WHERE feed_name = ?
            AND started_at >= datetime('now', '-1 day')
        `).bind(meta.feed_name).first<{
          success: number;
          failed: number;
          partial: number;
          total: number;
        }>()
      : Promise.resolve(null),
  ]);

  const sparkline = history.results.map((r) => ({
    count: r.count,
    recorded_at: r.recorded_at,
  }));

  // drained_last_hour = current count − count from ~1h ago. Works
  // off whatever samples the history actually contains, falls back
  // to null when we don't have an hour-ago data point.
  const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
  const hourAgoSample = sparkline.find(
    (s) => Math.abs(Date.parse(s.recorded_at + 'Z') - oneHourAgoMs) < 30 * 60 * 1000,
  );
  const currentCount = sparkline[sparkline.length - 1]?.count ?? null;
  const drainedLastHour =
    currentCount !== null && hourAgoSample
      ? hourAgoSample.count - currentCount
      : null;

  const failureRate = feedStats && feedStats.total > 0
    ? {
        success: feedStats.success ?? 0,
        failed:  feedStats.failed ?? 0,
        partial: feedStats.partial ?? 0,
        total:   feedStats.total,
        pct:     Math.round(((feedStats.failed ?? 0) / feedStats.total) * 100),
      }
    : null;

  const trendDirection = (() => {
    if (sparkline.length < 2) return 'unknown' as const;
    const first = sparkline[0]!.count;
    const last = sparkline[sparkline.length - 1]!.count;
    if (last < first) return 'down' as const;
    if (last > first) return 'up' as const;
    return 'flat' as const;
  })();

  const detail = {
    id: pipelineId,
    label: meta.label,
    description: meta.description,
    agent: meta.agent,
    schedule: meta.schedule,
    endpoints: meta.endpoints ?? null,
    why_grows: meta.why_grows ?? null,
    count: currentCount,
    sparkline,
    drained_last_hour: drainedLastHour,
    trend_direction: trendDirection,
    verdict: currentCount === null
      ? { label: 'STALE', tone: 'pending' as const }
      : computeBacklogVerdict(currentCount, trendDirection),
    last_run: agentRun
      ? {
          started_at:        agentRun.started_at,
          completed_at:      agentRun.completed_at,
          duration_ms:       agentRun.duration_ms,
          status:            agentRun.status,
          records_processed: agentRun.records_processed,
          error_message:     agentRun.error_message,
        }
      : null,
    failure_rate_24h: failureRate,
  };

  const body = { success: true, data: detail };
  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });
  return json(body, 200, origin);
}

async function handleGeoipDetail(
  _request: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  const cacheKey = 'pipeline_detail:geoip:v1';
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  const { getGeoMmdbStatus } = await import("../../lib/geoip-mmdb");
  const status = await getGeoMmdbStatus(env);

  // NX-geoip-card: surface the fields the operator actually needs
  // (source release SHA, freshness age, in-flight shadow progress)
  // as a dedicated `reference_dataset` block. The generic
  // "backlog / drained / sparkline" treatment doesn't apply to a
  // reference dataset and was rendering the card as "Not enough
  // samples yet" — wasted real estate.
  const lastRefreshAgeHours = status.last_refresh_at
    ? Math.round((Date.now() - new Date(status.last_refresh_at + 'Z').getTime()) / 3_600_000)
    : null;
  const isRunning = status.last_refresh_status === 'running';

  const detail = {
    id: 'geoip',
    label: 'GeoIP Database',
    description: 'MaxMind GeoLite2 IP→geo range table. Refreshed weekly.',
    agent: 'geoip_refresh',
    schedule: 'monthly',
    endpoints: [{ name: 'MaxMind GeoLite2', url: 'https://download.maxmind.com' }],
    why_grows:
      'Reference dataset, not a backlog. Row count changes only when ' +
      'the geoip_refresh agent imports a new MaxMind release. The ' +
      "agent polls weekly (Sunday 02:07 UTC), checks MaxMind's " +
      '.sha256 fingerprint, and skips the import if the live data is ' +
      'already current. Failures are usually MaxMind 429s (daily quota), ' +
      'R2 zip integrity errors, or the 1MiB Workflow step-output ' +
      'ceiling — see workflows/geoipRefresh.ts.',
    count: status.row_count ?? 0,
    sparkline: [],
    drained_last_hour: null,
    trend_direction: status.last_refresh_rows_written && status.last_refresh_rows_written > 0
      ? 'up' as const
      : 'flat' as const,
    verdict: computeReferenceDatasetVerdict(
      status.row_count ?? 0,
      status.configured,
      status.last_refresh_rows_written ?? 0,
      status.last_refresh_status,
      status.last_refresh_at,
    ),
    last_run: status.last_refresh_at
      ? {
          started_at:        status.last_refresh_at,
          completed_at:      status.last_refresh_at,
          duration_ms:       status.last_refresh_duration_ms,
          status:            status.last_refresh_status ?? 'unknown',
          records_processed: status.last_refresh_rows_written,
          error_message:     status.last_refresh_error,
        }
      : null,
    failure_rate_24h: null,
    recent_attempts: status.recent_attempts.slice(0, 5),
    // The new operator-focused block. UI renders this in place of the
    // generic backlog sparkline.
    reference_dataset: {
      configured:                  status.configured,
      row_count:                   status.row_count ?? 0,
      shadow_row_count:            status.shadow_row_count,
      shadow_table_present:        status.has_shadow_table ?? false,
      source_version:              status.last_refresh_source ?? null,
      last_refresh_at:             status.last_refresh_at,
      last_refresh_age_hours:      lastRefreshAgeHours,
      last_refresh_status:         status.last_refresh_status,
      last_refresh_rows_written:   status.last_refresh_rows_written,
      last_refresh_duration_ms:    status.last_refresh_duration_ms,
      last_refresh_error:          status.last_refresh_error,
      currently_running:           isRunning,
      stale_threshold_days:        7,
    },
  };
  const body = { success: true, data: detail };
  // Shorter TTL when a refresh is mid-flight so the in-flight progress
  // updates while the operator watches. Falls back to the existing 60s
  // cache otherwise.
  await env.CACHE.put(cacheKey, JSON.stringify(body), {
    expirationTtl: isRunning ? 15 : 60,
  });
  return json(body, 200, origin);
}
