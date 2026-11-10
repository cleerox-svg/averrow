// Comprehensive Platform Operations Briefing — 12-section intelligence report
import { json } from "../lib/cors";
import { sendBriefingEmail } from "../lib/briefing-email";
import { createAgentRun, finalizeAgentRun, type AgentRunFinalOutcome } from "../db/agent-runs";
import { logger } from "../lib/logger";
import { fetchMarketingVisibility } from "../lib/marketing-analytics";
import type { MarketingVisibility } from "../lib/marketing-analytics";
import {
  retryWithBackoff,
  runSequential,
  sleep,
  withTimeout,
  type SectionErrors,
} from "../lib/run-sequential";
import { cachedCount, THREATS_TOTAL_TTL_S } from "../lib/cached-count";
import type { Env } from "../types";

// ─── Agent-run contract wrapper ─────────────────────────────────
// The daily briefing is dispatched by the orchestrator's dedicated
// 13:13 UTC trigger (cron path: generateAndEmailBriefing) and on demand
// by handleGenerateBriefing. It is a handler, not an AgentModule, but it
// still participates in the agent-run contract (CLAUDE.md §6) so operators
// can see whether the daily assessment actually ran via agent_mesh /
// platform-diagnostics. agent_id 'daily_briefing' is a handler-dispatched
// writer (like campaign_hunter's workflow row) — it is intentionally NOT
// registered in agents/*.ts, so it does not appear in the architect
// manifest and does not affect the resource-drift gate.
const BRIEFING_AGENT_ID = "daily_briefing";

// ─── Timing / budget knobs ──────────────────────────────────────
// 2026-11-09: the 13:13 cron read 4.67M rows (three full passes over the
// 1.55M-row threats table) back to back, then its threat_briefings INSERT
// and all three finalize attempts (250 ms / 1 s apart) failed inside the same
// D1 10-second overload window: no briefing, no email, and the run sat
// 'running' until the navigator reaper closed it 90 min later. The knobs
// below keep the heavy read small and spread out, bound every read, and
// retry the writes across more than one 10 s window. Exported (and mutable)
// only so tests can zero the delays.
export const BRIEFING_TIMING: {
  readTimeoutMs: number;
  readBudgetMs: number;
  enrichmentChunkRows: number;
  enrichmentChunkPauseMs: number;
  writeBackoffMs: readonly number[];
  finalizeBackoffMs: readonly number[];
  emailTimeoutMs: number;
} = {
  /** Per-read ceiling; a read that exceeds it falls back for its section. */
  readTimeoutMs: 20_000,
  /** Once the read phase has used this much wall time, the remaining reads fall back. */
  readBudgetMs: 180_000,
  /** threats rowid span per enrichment chunk (rowid PK range seek). */
  enrichmentChunkRows: 200_000,
  /** Pause between enrichment chunks so other requests interleave. */
  enrichmentChunkPauseMs: 300,
  /** Backoff before each retry of an idempotent briefing write; sums to > 10 s. */
  writeBackoffMs: [1_000, 3_000, 6_000, 12_000],
  /** Backoff before each agent_runs finalize retry; sums to > 10 s. */
  finalizeBackoffMs: [2_000, 5_000, 12_000],
  /** Ceiling on the Resend send. */
  emailTimeoutMs: 30_000,
};

interface BriefingRunOutput<T> {
  result: T;
  briefingId: number;
  /** Sections that fell back (`<section>_error` → message). */
  sectionErrors?: SectionErrors;
}

/**
 * Sections whose fallback means the report is incomplete. A missing table
 * is schema drift the section already tolerates by design (the
 * geopolitical-campaign tables are absent in prod), not a degraded run.
 */
export function degradingSectionErrors(errors: SectionErrors | undefined): string[] {
  if (!errors) return [];
  return Object.entries(errors)
    .filter(([, msg]) => !/no such table/i.test(msg))
    .map(([key]) => key.replace(/_error$/, ""));
}

/**
 * Wraps briefing generation + persistence in the standard agent-run
 * contract: an `agent_runs` row at start (status running), completion
 * with `completed_at` + `records_processed`, a telemetry `agent_events`
 * row after completion (target_agent = NULL — the briefing dispatches
 * nothing downstream), and `error_message` capture on failure.
 *
 * The run is finalized in a `finally`, whatever `fn` does: `success`;
 * `partial` (completed_at set, error_message naming the sections) when the
 * briefing was stored but some sections fell back; or `failed` with the
 * error. Finalize retries span more than one D1 10 s overload window.
 *
 * `fn` performs the actual generation/persist and returns the briefing
 * row id; the wrapper is pure instrumentation and re-throws so the
 * caller's existing error handling (cron logger / handler 500) is
 * preserved unchanged. Callers invoke this ONLY on paths that genuinely
 * generate a briefing — never on the cron dedup-skip or cached-return
 * paths — so a run row maps 1:1 to an actual assessment.
 */
async function withBriefingRun<T>(
  env: Env,
  trigger: string,
  fn: () => Promise<BriefingRunOutput<T>>,
): Promise<T> {
  // Run bookkeeping is best-effort: a D1 hiccup on agent_runs must never
  // turn a successfully generated + emailed briefing into a failure. If
  // createAgentRun throws we proceed with generation anyway and skip the
  // later completion/fail writes (no runId to update).
  let runId: string | null = null;
  try {
    runId = await createAgentRun(env, BRIEFING_AGENT_ID);
  } catch (err) {
    logger.error("briefing_run_start_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let output: BriefingRunOutput<T> | undefined;
  let failure = "briefing generation failed";
  try {
    output = await fn();
  } catch (err) {
    // Genuine generation failure — the finally marks the run failed and the
    // error is re-thrown so the caller's existing handling is unchanged.
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // Always finalize. finalizeAgentRun retries (bounded) and never throws,
    // so run-tracking failure cannot mask the original error or fail a
    // delivered briefing. A worker killed inside fn() is closed by the
    // navigator reaper (lib/agent-runs-reaper.ts).
    if (runId) {
      const degraded = degradingSectionErrors(output?.sectionErrors);
      const outcome: AgentRunFinalOutcome = output
        ? {
            kind: "complete",
            stats: {
              records_processed: 1,
              outputs_generated: 1,
              status: degraded.length > 0 ? "partial" : "success",
              error_message: degraded.length > 0
                ? `briefing stored with fallback sections: ${degraded.join(", ")}`.slice(0, 500)
                : null,
            },
          }
        : { kind: "failed", error_message: failure };
      const fin = await finalizeAgentRun(env, runId, outcome, {
        attempts: BRIEFING_TIMING.finalizeBackoffMs.length + 1,
        backoffMs: BRIEFING_TIMING.finalizeBackoffMs,
      });
      if (!fin.ok) {
        logger.error(output ? "briefing_run_complete_error" : "briefing_run_fail_error", { error: fin.error });
      }
    }
  }

  // fn() succeeded: the deliverable is done. Telemetry-only completion
  // event: target_agent = NULL means the orchestrator's agent_events
  // consumer records it for operator traceability and marks it done without
  // dispatching anything. It must not be able to fail the briefing.
  try {
    await env.DB.prepare(
      `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
       VALUES (?, 'briefing_generated', ?, NULL, ?, 3, 'pending')`,
    )
      .bind(
        crypto.randomUUID(),
        BRIEFING_AGENT_ID,
        JSON.stringify({
          briefing_id: output.briefingId,
          trigger,
          fallback_sections: degradingSectionErrors(output.sectionErrors),
        }),
      )
      .run();
  } catch (err) {
    logger.error("briefing_event_write_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return output.result;
}

// ─── Persistence (idempotent, retried) ─────────────────────────

/**
 * Insert the briefing row, retrying across D1 overload windows. Each call
 * stamps a `generation_id` into report_data and the INSERT is guarded by
 * NOT EXISTS on it, so a retry after an ambiguous failure (the write landed
 * but the response was lost) cannot create a second row; the id is then
 * read back by that stamp.
 */
async function insertBriefingRow(
  env: Env,
  briefing: ComprehensiveBriefing,
  trigger: string,
): Promise<{ briefingId: number; generationId: string }> {
  const generationId = crypto.randomUUID();
  const reportDate = new Date().toISOString().slice(0, 10);
  const reportData = JSON.stringify({ ...briefing, generation_id: generationId });
  const briefingId = await retryWithBackoff(async () => {
    const r = await env.DB.prepare(
      `INSERT INTO threat_briefings (type, report_date, report_data, generated_at, trigger, emailed)
       SELECT 'daily', ?, ?, datetime('now'), ?, 0
       WHERE NOT EXISTS (
         SELECT 1 FROM threat_briefings
         WHERE generated_at >= datetime('now', '-1 day') AND instr(report_data, ?) > 0
       )`,
    )
      .bind(reportDate, reportData, trigger, generationId)
      .run();
    if ((r.meta?.changes ?? 0) > 0 && r.meta.last_row_id) return Number(r.meta.last_row_id);
    const row = await env.DB.prepare(
      `SELECT id FROM threat_briefings
       WHERE generated_at >= datetime('now', '-1 day') AND instr(report_data, ?) > 0
       ORDER BY id DESC LIMIT 1`,
    )
      .bind(generationId)
      .first<{ id: number }>();
    if (!row) throw new Error("threat_briefings insert reported no row");
    return Number(row.id);
  }, BRIEFING_TIMING.writeBackoffMs);
  return { briefingId, generationId };
}

type EmailOutcome = { sent: boolean; id?: string; error?: string; recipient?: string };

/** Send the email (time-boxed, never throws) and record the outcome on the row. */
async function emailAndRecord(
  env: Env,
  briefing: ComprehensiveBriefing,
  briefingId: number,
  generationId: string,
): Promise<EmailOutcome> {
  const title = `Platform Operations Briefing — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  const emailResult: EmailOutcome = await withTimeout(
    () => sendBriefingEmail(env, briefing, title),
    BRIEFING_TIMING.emailTimeoutMs,
    "briefing email",
  ).catch((err: unknown) => ({
    sent: false,
    error: err instanceof Error && err.name === "TimeoutError" ? err.message : "An internal error occurred",
    recipient: "",
  }));

  try {
    if (emailResult.sent) {
      await retryWithBackoff(
        () => env.DB.prepare("UPDATE threat_briefings SET emailed = 1 WHERE id = ?").bind(briefingId).run(),
        BRIEFING_TIMING.writeBackoffMs,
      );
    } else {
      // Persist the Resend error into report_data.email_error so the
      // briefing_status diagnostics tell the operator WHY it failed.
      // report_data is JSON, so it is patched in place (no migration).
      const updated = JSON.stringify({
        ...briefing,
        generation_id: generationId,
        email_error: emailResult.error ?? "unknown",
        email_recipient: emailResult.recipient ?? null,
      });
      await retryWithBackoff(
        () => env.DB.prepare("UPDATE threat_briefings SET report_data = ? WHERE id = ?").bind(updated, briefingId).run(),
        BRIEFING_TIMING.writeBackoffMs,
      );
    }
  } catch (err) {
    // Non-fatal: the briefing row exists and the email outcome is known.
    logger.error("briefing_email_record_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return emailResult;
}

// ─── Briefing Data Structure ────────────────────────────────────

export interface ComprehensiveBriefing {
  platformOverview: {
    totalThreats: number;
    last24h: number;
    last12h: number;
    avgPerHour: number;
    brandsMonitored: number;
    brandsClassified: number;
    todayCount: number;
    yesterdayCount: number;
  };
  newThreats: {
    bySeverity: Array<{ severity: string; count: number }>;
    bySource: Array<{ source_feed: string; count: number }>;
    notable: Array<{
      malicious_domain: string;
      type: string;
      severity: string;
      source_feed: string;
      first_seen: string;
    }>;
  };
  feedProduction: Array<{ feed_name: string; runs: number; ingested: number }>;
  feedHealth: {
    feeds: Array<{
      feed_name: string;
      health_status: string;
      last_successful_pull: string | null;
      last_error: string | null;
    }>;
    summary: Array<{ health_status: string; count: number }>;
    staleFeeds: Array<{ feed_name: string; last_successful_pull: string | null }>;
    degradedFeeds: Array<{ feed_name: string; last_error: string | null }>;
  };
  enrichment: {
    surbl_checked: number;
    surbl_hits: number;
    vt_checked: number;
    vt_hits: number;
    gsb_checked: number;
    gsb_hits: number;
    dbl_checked: number;
    dbl_hits: number;
    abuse_checked: number;
    abuse_hits: number;
    gn_checked: number;
    sec_checked: number;
  };
  flightController: {
    summary: string | null;
    created_at: string | null;
  };
  agentActivity: Array<{ agent_id: string; runs: number; last_run: string }>;
  newCapabilities: {
    typosquat_total: number;
    typosquat_new: number;
    social_total: number;
    social_new: number;
    certstream: number;
    appstore_total: number;
    appstore_new: number;
    darkweb_total: number;
    darkweb_new: number;
  };
  spamTrap: {
    totalSeeds: number;
    totalCaptures: number;
    captures12h: number;
    latestCaptures: Array<{
      trap_address: string;
      from_address: string;
      subject: string;
      category: string;
      severity: string;
      captured_at: string;
    }>;
    seedingSources: Array<{
      seeded_location: string;
      seeds: number;
      catches: number;
    }>;
  };
  honeypot: {
    totalVisits: number;
    botVisits: number;
    humanVisits: number;
    visits12h: number;
    pageBreakdown: Array<{ page: string; visits: number; bots: number }>;
    pageBreakdownTotal: number;
    recentBots: Array<{
      page: string;
      bot_name: string;
      country: string;
      visited_at: string;
    }>;
    suspiciousHumans: Array<{
      page: string;
      country: string;
      visited_at: string;
      asn: string | null;
      reason: "bait" | "probe";
    }>;
  };
  marketingVisibility: MarketingVisibility;
  topTargetedBrands: Array<{ name: string; threats_24h: number }>;
  brandCoverage: Array<{ sector: string; brands: number }>;
  geopoliticalCampaigns: Array<{
    name: string; status: string; conflict: string;
    start_date: string; briefing_priority: string;
    total_threats: number; new_24h: number; brands_hit: number;
    threat_actors: string; notes: string | null;
  }>;
  generatedAt: string;
  statusBadge: "OPERATIONAL" | "DEGRADED";
}

// ─── Safe query helpers ─────────────────────────────────────────
// Every section read is time-boxed (BRIEFING_TIMING.readTimeoutMs) and
// checked against the read-phase budget; a read that throws, times out or
// is skipped for budget resolves to its fallback and records
// `<section>_error`, so the briefing is always stored and emailed.

interface ReadCtx {
  db: Env["DB"];
  /** Epoch ms after which remaining reads are skipped. */
  deadline: number;
  errors: SectionErrors;
}

function recordSectionError(rc: ReadCtx, section: string, message: string): void {
  const key = `${section}_error`;
  rc.errors[key] = rc.errors[key] ? `${rc.errors[key]}; ${message}` : message;
}

/** Run one section read under the per-read timeout and the read budget. */
async function guardedRead<T>(
  rc: ReadCtx,
  section: string,
  fallback: T,
  read: () => Promise<T>,
): Promise<T> {
  if (Date.now() > rc.deadline) {
    recordSectionError(rc, section, "skipped: briefing read budget exhausted");
    return fallback;
  }
  try {
    return await withTimeout(read, BRIEFING_TIMING.readTimeoutMs, `briefing ${section} read`);
  } catch (err) {
    recordSectionError(rc, section, err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

function safeQuery<T>(rc: ReadCtx, section: string, sql: string, fallback: T): Promise<T> {
  return guardedRead(rc, section, fallback, async () => {
    const result = await rc.db.prepare(sql).all();
    return result.results as T;
  });
}

function safeFirst<T>(rc: ReadCtx, section: string, sql: string, fallback: T): Promise<T> {
  return guardedRead(rc, section, fallback, async () => {
    const result = await rc.db.prepare(sql).first();
    return (result as T) ?? fallback;
  });
}

type EnrichmentTotals = ComprehensiveBriefing["enrichment"];

const EMPTY_ENRICHMENT: EnrichmentTotals = {
  surbl_checked: 0, surbl_hits: 0, vt_checked: 0, vt_hits: 0,
  gsb_checked: 0, gsb_hits: 0, dbl_checked: 0, dbl_hits: 0,
  abuse_checked: 0, abuse_hits: 0, gn_checked: 0, sec_checked: 0,
};

/**
 * All-time enrichment-provider totals over threats — the one section that
 * has to read every threat (no cube or counter carries these columns).
 * Instead of one ~1.55M-row statement it walks `rowid` ranges of
 * BRIEFING_TIMING.enrichmentChunkRows (an INTEGER PRIMARY KEY range seek)
 * with a pause between chunks, so no single statement holds D1 for seconds
 * and other requests interleave. Same rows, same sums. Any chunk failing
 * fails the whole section (a partial sum would be silently wrong).
 */
async function readEnrichmentTotals(rc: ReadCtx): Promise<EnrichmentTotals> {
  const section = "enrichment";
  try {
    const top = await withTimeout(
      () => rc.db.prepare("SELECT MAX(rowid) AS hi FROM threats").first<{ hi: number | null }>(),
      BRIEFING_TIMING.readTimeoutMs,
      "briefing enrichment bounds read",
    );
    const hi = Number(top?.hi) || 0;
    const step = Math.max(1, BRIEFING_TIMING.enrichmentChunkRows);
    const totals: EnrichmentTotals = { ...EMPTY_ENRICHMENT };
    for (let lo = 0; lo < hi; lo += step) {
      if (Date.now() > rc.deadline) throw new Error("skipped: briefing read budget exhausted");
      if (lo > 0) await sleep(BRIEFING_TIMING.enrichmentChunkPauseMs);
      const chunk = await withTimeout(
        () => rc.db.prepare(
          `SELECT
            SUM(surbl_checked) as surbl_checked, SUM(surbl_listed) as surbl_hits,
            SUM(vt_checked) as vt_checked, SUM(CASE WHEN vt_malicious>0 THEN 1 ELSE 0 END) as vt_hits,
            SUM(gsb_checked) as gsb_checked, SUM(gsb_flagged) as gsb_hits,
            SUM(dbl_checked) as dbl_checked, SUM(dbl_listed) as dbl_hits,
            SUM(abuseipdb_checked) as abuse_checked, SUM(CASE WHEN abuseipdb_score>=50 THEN 1 ELSE 0 END) as abuse_hits,
            SUM(greynoise_checked) as gn_checked,
            SUM(seclookup_checked) as sec_checked
           FROM threats WHERE rowid > ? AND rowid <= ?`,
        ).bind(lo, lo + step).first<Record<keyof EnrichmentTotals, number | null>>(),
        BRIEFING_TIMING.readTimeoutMs,
        "briefing enrichment chunk read",
      );
      if (chunk) {
        for (const k of Object.keys(totals) as Array<keyof EnrichmentTotals>) {
          totals[k] += Number(chunk[k]) || 0;
        }
      }
    }
    return totals;
  } catch (err) {
    recordSectionError(rc, section, err instanceof Error ? err.message : String(err));
    return { ...EMPTY_ENRICHMENT };
  }
}

// ─── Fetch comprehensive briefing data ──────────────────────────

export async function fetchComprehensiveBriefing(
  env: Env,
  /** Optional collector: each section that fell back adds `<section>_error`. */
  sectionErrors: SectionErrors = {},
): Promise<ComprehensiveBriefing> {
  const db = env.DB;
  const now = new Date().toISOString();
  const rc: ReadCtx = {
    db,
    deadline: Date.now() + BRIEFING_TIMING.readBudgetMs,
    errors: sectionErrors,
  };

  // Platform-wide threat total: the shared `count.threats.total` counter
  // (also read by the Threats list and dashboard) instead of a full COUNT(*)
  // over threats. It can lag the live table by up to THREATS_TOTAL_TTL_S —
  // fine for a daily report headline.
  const totalThreats = await cachedCount(env, "count.threats.total", THREATS_TOTAL_TTL_S, async () => {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM threats").first<{ n: number }>();
    return r?.n ?? 0;
  }).catch((err: unknown) => {
    recordSectionError(rc, "total_threats", err instanceof Error ? err.message : String(err));
    return 0;
  });

  // One query at a time (lib/run-sequential.ts), not one ~30-way
  // Promise.all: D1 serialises a database's queries anyway, and a burst this
  // size inside one 10 s window is what trips `D1 DB is overloaded` for
  // every other request (logins included). Wall clock is not the constraint
  // — the whole run takes ~5 s — so this stays sequential rather than going
  // to bounded concurrency. Each read keeps its own fallback and is
  // time-boxed (guardedRead). Only ONE read still touches every threat
  // (enrichment, chunked); the source-feed totals come from the status cube.
  const [
    // A) Platform Overview
    overview,
    dayOverDay,
    // B) Feed Production (12h)
    feedProduction,
    // C) Feed Health
    feedHealthFeeds,
    feedHealthSummary,
    // D) Enrichment Pipeline
    enrichment,
    // E) Flight Controller
    flightController,
    // F) Agent Activity (12h)
    agentActivity,
    // G) New Capabilities
    newCapabilities,
    capabilityTotals,
    newCapabilitiesExt,
    // H) Spam Trap
    spamTrapSeeds,
    spamTrapCaptures,
    spamTrapCaptures12h,
    spamTrapLatest,
    spamTrapSources,
    // I) Honeypot
    honeypotTotals,
    honeypotVisits12h,
    honeypotPages,
    honeypotPageCount,
    honeypotBots,
    honeypotHumans,
    // J) New Threats
    threatsBySeverity,
    threatsBySource,
    threatsNotable,
    // K) Top Targeted Brands
    topTargetedBrands,
    // L) Anomalies — stale feeds
    staleFeeds,
    degradedFeeds,
    // M) Brand Coverage
    brandCoverage,
    // N) Geopolitical Campaigns
    geopoliticalCampaigns,
  ] = await runSequential([
    // A) Platform Overview
    () => safeFirst(
      rc, "overview",
      `SELECT
        (SELECT COUNT(*) FROM threats WHERE first_seen >= datetime('now', '-12 hours')) as last_12h,
        (SELECT COUNT(*) FROM monitored_brands WHERE status = 'active') as brands_monitored,
        (SELECT COUNT(*) FROM brands WHERE sector IS NOT NULL) as brands_classified`,
      {
        last_12h: 0,
        brands_monitored: 0,
        brands_classified: 0,
      },
    ),
    // Today and yesterday come from ONE read, so a failed read zeroes both
    // (never a fake 100% day-over-day drop). The 24h window is counted once
    // here: last24h, avgPerHour and todayCount all derive from today_count
    // (they were the same range count, run three times).
    () => safeFirst(
      rc, "day_over_day",
      `SELECT
        (SELECT COUNT(*) FROM threats WHERE first_seen >= datetime('now', '-24 hours')) as today_count,
        (SELECT COUNT(*) FROM threats WHERE first_seen >= datetime('now', '-48 hours') AND first_seen < datetime('now', '-24 hours')) as yesterday_count`,
      { today_count: 0, yesterday_count: 0 },
    ),

    // B) Feed Production (12h)
    () => safeQuery<Array<{ feed_name: string; runs: number; ingested: number }>>(
      rc, "feed_production",
      `SELECT feed_name, COUNT(*) as runs, SUM(records_ingested) as ingested
       FROM feed_pull_history
       WHERE started_at >= datetime('now', '-12 hours')
       GROUP BY feed_name ORDER BY ingested DESC`,
      [],
    ),

    // C) Feed Health
    () => safeQuery<
      Array<{
        feed_name: string;
        health_status: string;
        last_successful_pull: string | null;
        last_error: string | null;
      }>
    >(
      rc, "feed_health",
      `SELECT feed_name, health_status, last_successful_pull, last_error
       FROM feed_status WHERE health_status != 'disabled'
       ORDER BY health_status DESC, feed_name`,
      [],
    ),
    () => safeQuery<Array<{ health_status: string; count: number }>>(
      rc, "feed_health_summary",
      `SELECT health_status, COUNT(*) as count FROM feed_status
       WHERE health_status != 'disabled' GROUP BY health_status`,
      [],
    ),

    // D) Enrichment Pipeline — all-time totals, read in rowid chunks
    //    (readEnrichmentTotals) instead of one full threats scan.
    () => readEnrichmentTotals(rc),

    // E) Flight Controller
    () => safeFirst(
      rc, "flight_controller",
      `SELECT summary, created_at FROM agent_outputs
       WHERE agent_id = 'flight_control' AND type = 'diagnostic'
       ORDER BY created_at DESC LIMIT 1`,
      { summary: null, created_at: null },
    ),

    // F) Agent Activity (12h)
    () => safeQuery<Array<{ agent_id: string; runs: number; last_run: string }>>(
      rc, "agent_activity",
      `SELECT agent_id, COUNT(*) as runs, MAX(started_at) as last_run
       FROM agent_runs WHERE started_at >= datetime('now', '-12 hours')
       GROUP BY agent_id ORDER BY runs DESC`,
      [],
    ),

    // G) New Capabilities — legacy counts stay in their own query so a missing
    //    app_store_listings / dark_web_mentions table can't zero them out.
    () => safeFirst(
      rc, "new_capabilities",
      `SELECT
        (SELECT COUNT(*) FROM threats WHERE source_feed = 'typosquat_scanner' AND first_seen >= datetime('now', '-12 hours')) as typosquat_new,
        (SELECT COUNT(*) FROM social_mentions) as social_total,
        (SELECT COUNT(*) FROM social_mentions WHERE created_at >= datetime('now', '-12 hours')) as social_new`,
      {
        typosquat_new: 0,
        social_total: 0,
        social_new: 0,
      },
    ),
    // G1) All-time per-source-feed totals from the status cube (CLAUDE.md §8:
    //     query cubes, not raw threats). The old `COUNT(*) FROM threats WHERE
    //     source_feed = ?` had no source_feed-leading index and walked all
    //     1.55M rows of idx_threats_ip_source_feed — twice. One pass over
    //     threat_cube_status (~45K rows). Cube sums can drift a little from
    //     the live table (2026-11-08: 78,311 cube vs 78,138 table).
    () => safeFirst(
      rc, "capability_totals",
      `SELECT
        COALESCE(SUM(CASE WHEN source_feed = 'typosquat_scanner' THEN threat_count ELSE 0 END), 0) as typosquat_total,
        COALESCE(SUM(CASE WHEN source_feed = 'certstream' THEN threat_count ELSE 0 END), 0) as certstream
       FROM threat_cube_status
       WHERE source_feed IN ('typosquat_scanner', 'certstream')`,
      { typosquat_total: 0, certstream: 0 },
    ),
    // G2) App-store + dark-web capability counts — isolated so table drift
    //     can't knock out the legacy capability section above.
    () => safeFirst(
      rc, "new_capabilities_ext",
      `SELECT
        (SELECT COUNT(*) FROM app_store_listings WHERE status = 'active' AND classification IN ('impersonation','suspicious')) as appstore_total,
        (SELECT COUNT(*) FROM app_store_listings WHERE status = 'active' AND classification IN ('impersonation','suspicious') AND first_seen >= datetime('now', '-12 hours')) as appstore_new,
        (SELECT COUNT(*) FROM dark_web_mentions WHERE status = 'active' AND classification IN ('confirmed','suspicious')) as darkweb_total,
        (SELECT COUNT(*) FROM dark_web_mentions WHERE status = 'active' AND classification IN ('confirmed','suspicious') AND first_seen >= datetime('now', '-12 hours')) as darkweb_new`,
      {
        appstore_total: 0,
        appstore_new: 0,
        darkweb_total: 0,
        darkweb_new: 0,
      },
    ),

    // H) Spam Trap
    () => safeFirst(rc, "spam_trap_seeds", `SELECT COUNT(*) as total_seeds FROM seed_addresses`, {
      total_seeds: 0,
    }),
    () => safeFirst(
      rc, "spam_trap_captures",
      `SELECT COUNT(*) as total_captures FROM spam_trap_captures`,
      { total_captures: 0 },
    ),
    () => safeFirst(
      rc, "spam_trap_captures_12h",
      `SELECT COUNT(*) as captures_12h FROM spam_trap_captures WHERE captured_at >= datetime('now', '-12 hours')`,
      { captures_12h: 0 },
    ),
    () => safeQuery<
      Array<{
        trap_address: string;
        from_address: string;
        subject: string;
        category: string;
        severity: string;
        captured_at: string;
      }>
    >(
      rc, "spam_trap_latest",
      `SELECT trap_address, from_address, subject, category, severity, captured_at
       FROM spam_trap_captures ORDER BY captured_at DESC LIMIT 5`,
      [],
    ),
    () => safeQuery<
      Array<{ seeded_location: string; seeds: number; catches: number }>
    >(
      rc, "spam_trap_sources",
      `SELECT seeded_location, COUNT(*) as seeds, SUM(total_catches) as catches
       FROM seed_addresses WHERE seeded_location IS NOT NULL AND seeded_location != ''
       GROUP BY seeded_location ORDER BY catches DESC`,
      [],
    ),

    // I) Honeypot
    () => safeFirst(
      rc, "honeypot_totals",
      `SELECT COUNT(*) as total_visits,
        SUM(is_bot) as bot_visits,
        COUNT(*) - SUM(is_bot) as human_visits
       FROM honeypot_visits`,
      { total_visits: 0, bot_visits: 0, human_visits: 0 },
    ),
    () => safeFirst(
      rc, "honeypot_visits_12h",
      `SELECT COUNT(*) as visits_12h FROM honeypot_visits
       WHERE visited_at >= datetime('now', '-12 hours')`,
      { visits_12h: 0 },
    ),
    () => safeQuery<Array<{ page: string; visits: number; bots: number }>>(
      rc, "honeypot_pages",
      `SELECT page, COUNT(*) as visits, SUM(is_bot) as bots
       FROM honeypot_visits GROUP BY page ORDER BY visits DESC LIMIT 20`,
      [],
    ),
    () => safeFirst(
      rc, "honeypot_page_count",
      `SELECT COUNT(DISTINCT page) AS distinct_pages FROM honeypot_visits`,
      { distinct_pages: 0 },
    ),
    () => safeQuery<
      Array<{
        page: string;
        bot_name: string;
        country: string;
        visited_at: string;
      }>
    >(
      rc, "honeypot_bots",
      `SELECT page, bot_name, country, visited_at
       FROM honeypot_visits WHERE is_bot = 1
       ORDER BY visited_at DESC LIMIT 5`,
      [],
    ),
    // "Suspicious humans" = non-bot UA hitting a path that is NOT part of the
    // public honeypot surface. The legit public pages (lrxradar root/about/contact/
    // team, robots.txt, sitemap.xml, averrow /team and /careers) are excluded so
    // a casual browser visit doesn't flood the report. What's left is either:
    //   - 'bait'  → /admin-portal or /internal-staff on averrow.com (deliberately
    //               sensitive-looking; only recon hits these)
    //   - 'probe' → recon paths the lrxradar router logs verbatim before
    //               falling through to renderHome (e.g. lrxradar:/.env,
    //               lrxradar:/wp-admin, lrxradar:/phpmyadmin)
    () => safeQuery<
      Array<{
        page: string;
        country: string;
        visited_at: string;
        asn: string | null;
        reason: "bait" | "probe";
      }>
    >(
      rc, "honeypot_humans",
      `SELECT page, country, visited_at, asn,
         CASE
           WHEN page IN ('/admin-portal', '/internal-staff') THEN 'bait'
           ELSE 'probe'
         END AS reason
       FROM honeypot_visits
       WHERE is_bot = 0
         AND page NOT IN (
           'lrxradar:/',
           'lrxradar:/contact',
           'lrxradar:/about',
           'lrxradar:/team',
           'lrxradar:/robots.txt',
           'lrxradar:/sitemap.xml',
           '/team',
           '/careers'
         )
         AND visited_at >= datetime('now', '-7 days')
       ORDER BY visited_at DESC LIMIT 8`,
      [],
    ),

    // J) New Threats (12h)
    () => safeQuery<Array<{ severity: string; count: number }>>(
      rc, "threats_by_severity",
      `SELECT severity, COUNT(*) as count
       FROM threats WHERE first_seen >= datetime('now', '-12 hours')
       GROUP BY severity ORDER BY
         CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
         WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`,
      [],
    ),
    () => safeQuery<Array<{ source_feed: string; count: number }>>(
      rc, "threats_by_source",
      `SELECT source_feed, COUNT(*) as count
       FROM threats WHERE first_seen >= datetime('now', '-12 hours')
       GROUP BY source_feed ORDER BY count DESC LIMIT 10`,
      [],
    ),
    () => safeQuery<
      Array<{
        malicious_domain: string;
        type: string;
        severity: string;
        source_feed: string;
        first_seen: string;
      }>
    >(
      rc, "threats_notable",
      `SELECT malicious_domain, threat_type AS type, severity, source_feed, first_seen
       FROM threats WHERE first_seen >= datetime('now', '-12 hours')
       AND severity IN ('critical', 'high')
       ORDER BY first_seen DESC LIMIT 10`,
      [],
    ),

    // K) Top Targeted Brands (24h)
    // Unary `+` on t.target_brand_id keeps the brand indexes out of the
    // plan: without it SQLite drove from brands (132K rows) and probed
    // idx_threats_brand_created per brand, reading every brand-linked
    // threat. Now it range-seeks the 24h window on idx_threats_first_seen
    // (migration 0312) and PK-probes brands. The old
    // `target_brand_id IS NOT NULL` term was implied by the inner join.
    // Plan pinned in test/d1-read-spend-2026-11.test.ts.
    () => safeQuery<Array<{ name: string; threats_24h: number }>>(
      rc, "top_targeted_brands",
      `SELECT b.name, COUNT(*) as threats_24h
       FROM threats t JOIN brands b ON b.id = +t.target_brand_id
       WHERE t.first_seen >= datetime('now', '-24 hours')
       GROUP BY b.name ORDER BY threats_24h DESC LIMIT 10`,
      [],
    ),

    // L) Anomalies
    () => safeQuery<
      Array<{ feed_name: string; last_successful_pull: string | null }>
    >(
      rc, "stale_feeds",
      `SELECT feed_name, last_successful_pull FROM feed_status
       WHERE health_status NOT IN ('disabled')
       AND (last_successful_pull IS NULL OR last_successful_pull < datetime('now', '-6 hours'))`,
      [],
    ),
    () => safeQuery<Array<{ feed_name: string; last_error: string | null }>>(
      rc, "degraded_feeds",
      `SELECT feed_name, last_error FROM feed_status
       WHERE health_status IN ('degraded', 'failed') AND last_error IS NOT NULL`,
      [],
    ),

    // M) Brand Coverage
    () => safeQuery<Array<{ sector: string; brands: number }>>(
      rc, "brand_coverage",
      `SELECT sector, COUNT(*) as brands FROM brands
       WHERE sector IS NOT NULL GROUP BY sector ORDER BY brands DESC LIMIT 10`,
      [],
    ),

    // N) Geopolitical Campaigns
    () => safeQuery<Array<{
      name: string; status: string; conflict: string;
      start_date: string; briefing_priority: string;
      total_threats: number; new_24h: number; brands_hit: number;
      threat_actors: string; notes: string | null;
    }>>(
      rc, "geopolitical_campaigns",
      `SELECT gc.name, gc.status, gc.conflict, gc.threat_actors,
        COALESCE(gc.briefing_priority, 'high') as briefing_priority,
        gc.start_date, gc.notes,
        (SELECT COUNT(*) FROM threats t
         JOIN geopolitical_campaign_links gcl ON t.campaign_id = gcl.campaign_id
         WHERE gcl.geopolitical_campaign_id = gc.id) as total_threats,
        (SELECT COUNT(*) FROM threats t
         JOIN geopolitical_campaign_links gcl ON t.campaign_id = gcl.campaign_id
         WHERE gcl.geopolitical_campaign_id = gc.id
           AND t.first_seen >= datetime('now', '-24 hours')) as new_24h,
        (SELECT COUNT(DISTINCT t.target_brand_id) FROM threats t
         JOIN geopolitical_campaign_links gcl ON t.campaign_id = gcl.campaign_id
         WHERE gcl.geopolitical_campaign_id = gc.id
           AND t.target_brand_id IS NOT NULL) as brands_hit
      FROM geopolitical_campaigns gc
      WHERE gc.status = 'active'
      ORDER BY gc.briefing_priority DESC`,
      [],
    ),
  ]);

  // Determine status badge — only DEGRADED when >50% of feeds are unhealthy
  // or any feed has outright failed (not just degraded)
  const failedCount = feedHealthFeeds.filter(
    (f) => f.health_status === "failed",
  ).length;
  const unhealthyCount = feedHealthFeeds.filter(
    (f) => f.health_status === "degraded" || f.health_status === "failed",
  ).length;
  const totalFeeds = feedHealthFeeds.length || 1;
  const hasDegraded =
    failedCount > 0 || unhealthyCount / totalFeeds > 0.5;

  const last24h = Number(dayOverDay.today_count) || 0;

  // Marketing & AI visibility — internally safe (per-query fallback),
  // won't throw out of here even if the table is missing.
  const marketingVisibility = await fetchMarketingVisibility(env, 24);

  return {
    platformOverview: {
      totalThreats: Number(totalThreats) || 0,
      last24h: last24h,
      last12h: Number(overview.last_12h) || 0,
      // Same value as the former ROUND(COUNT(*) * 1.0 / 24, 0) (counts are
      // non-negative, so Math.round matches SQLite's half-away-from-zero).
      avgPerHour: Math.round(last24h / 24),
      brandsMonitored: Number(overview.brands_monitored) || 0,
      brandsClassified: Number(overview.brands_classified) || 0,
      todayCount: last24h,
      yesterdayCount: Number(dayOverDay.yesterday_count) || 0,
    },
    newThreats: {
      bySeverity: threatsBySeverity,
      bySource: threatsBySource,
      notable: threatsNotable,
    },
    feedProduction,
    feedHealth: {
      feeds: feedHealthFeeds,
      summary: feedHealthSummary,
      staleFeeds,
      degradedFeeds,
    },
    enrichment: {
      surbl_checked: Number(enrichment.surbl_checked) || 0,
      surbl_hits: Number(enrichment.surbl_hits) || 0,
      vt_checked: Number(enrichment.vt_checked) || 0,
      vt_hits: Number(enrichment.vt_hits) || 0,
      gsb_checked: Number(enrichment.gsb_checked) || 0,
      gsb_hits: Number(enrichment.gsb_hits) || 0,
      dbl_checked: Number(enrichment.dbl_checked) || 0,
      dbl_hits: Number(enrichment.dbl_hits) || 0,
      abuse_checked: Number(enrichment.abuse_checked) || 0,
      abuse_hits: Number(enrichment.abuse_hits) || 0,
      gn_checked: Number(enrichment.gn_checked) || 0,
      sec_checked: Number(enrichment.sec_checked) || 0,
    },
    flightController: {
      summary: (flightController.summary as unknown as string) ?? null,
      created_at: (flightController.created_at as unknown as string) ?? null,
    },
    agentActivity,
    newCapabilities: {
      typosquat_total: Number(capabilityTotals.typosquat_total) || 0,
      typosquat_new: Number(newCapabilities.typosquat_new) || 0,
      social_total: Number(newCapabilities.social_total) || 0,
      social_new: Number(newCapabilities.social_new) || 0,
      certstream: Number(capabilityTotals.certstream) || 0,
      appstore_total: Number(newCapabilitiesExt.appstore_total) || 0,
      appstore_new: Number(newCapabilitiesExt.appstore_new) || 0,
      darkweb_total: Number(newCapabilitiesExt.darkweb_total) || 0,
      darkweb_new: Number(newCapabilitiesExt.darkweb_new) || 0,
    },
    spamTrap: {
      totalSeeds: Number(spamTrapSeeds.total_seeds) || 0,
      totalCaptures: Number(spamTrapCaptures.total_captures) || 0,
      captures12h: Number(spamTrapCaptures12h.captures_12h) || 0,
      latestCaptures: spamTrapLatest,
      seedingSources: spamTrapSources,
    },
    honeypot: {
      totalVisits: Number(honeypotTotals.total_visits) || 0,
      botVisits: Number(honeypotTotals.bot_visits) || 0,
      humanVisits: Number(honeypotTotals.human_visits) || 0,
      visits12h: Number(honeypotVisits12h.visits_12h) || 0,
      pageBreakdown: honeypotPages,
      pageBreakdownTotal: Number(honeypotPageCount.distinct_pages) || 0,
      recentBots: honeypotBots,
      suspiciousHumans: honeypotHumans,
    },
    marketingVisibility,
    topTargetedBrands,
    brandCoverage,
    geopoliticalCampaigns,
    generatedAt: now,
    statusBadge: hasDegraded ? "DEGRADED" : "OPERATIONAL",
  };
}

// ─── Generate Briefing Handler ───────────────────────────────────

export async function handleGenerateBriefing(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const cached = url.searchParams.get("cached") === "true";

    // Check for cached briefing (12h TTL)
    if (cached) {
      const existing = await env.DB.prepare(
        `SELECT id, type, report_date, report_data, generated_at, trigger, emailed
        FROM threat_briefings
        WHERE generated_at >= datetime('now', '-12 hours')
        ORDER BY generated_at DESC LIMIT 1`,
      ).first();
      if (existing) {
        return json({ success: true, data: existing, cached: true }, 200, origin);
      }
    }

    const { stored, emailResult } = await withBriefingRun(
      env,
      `user:${userId}`,
      async () => {
        const sectionErrors: SectionErrors = {};
        const briefing = await fetchComprehensiveBriefing(env, sectionErrors);
        const { briefingId, generationId } = await insertBriefingRow(env, briefing, `user:${userId}`);

        const sendEmail = url.searchParams.get("sendEmail") !== "false";
        const emailResult: EmailOutcome | undefined = sendEmail
          ? await emailAndRecord(env, briefing, briefingId, generationId)
          : undefined;

        const stored = await env.DB.prepare(
          "SELECT id, type, report_date, report_data, generated_at, trigger, emailed FROM threat_briefings WHERE id = ?",
        )
          .bind(briefingId)
          .first();
        return { result: { stored, emailResult }, briefingId, sectionErrors };
      },
    );
    return json(
      { success: true, data: stored, cached: false, email: emailResult },
      201,
      origin,
    );
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Latest Briefing Handler ─────────────────────────────────────

export async function handleLatestBriefing(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const row = await env.DB.prepare(
      `SELECT id, type, report_date, report_data, generated_at, trigger, emailed
      FROM threat_briefings ORDER BY generated_at DESC LIMIT 1`,
    ).first();

    if (!row) {
      return json({ success: true, data: null }, 200, origin);
    }

    return json({ success: true, data: row }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Briefing History Handler ─────────────────────────────────────

export async function handleListBriefingHistory(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(
      50,
      parseInt(url.searchParams.get("limit") ?? "20", 10),
    );

    const rows = await env.DB.prepare(
      `SELECT id, type, report_date, report_data, generated_at, trigger, emailed
      FROM threat_briefings ORDER BY generated_at DESC LIMIT ?`,
    )
      .bind(limit)
      .all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Cron / standalone: generate briefing + send email ─────────

export async function generateAndEmailBriefing(
  env: Env,
  trigger: string = 'cron:daily',
): Promise<{ briefingId: number; emailSent: boolean; error?: string }> {
  return withBriefingRun(env, trigger, async () => {
    // Sections fall back individually; the row is stored and the email sent
    // whatever falls back, and the run finishes 'partial' naming them.
    const sectionErrors: SectionErrors = {};
    const briefing = await fetchComprehensiveBriefing(env, sectionErrors);
    const { briefingId, generationId } = await insertBriefingRow(env, briefing, trigger);
    const emailResult = await emailAndRecord(env, briefing, briefingId, generationId);

    return {
      result: { briefingId, emailSent: emailResult.sent, error: emailResult.error },
      briefingId,
      sectionErrors,
    };
  });
}
