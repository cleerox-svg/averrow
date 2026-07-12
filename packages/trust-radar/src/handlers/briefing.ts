// Comprehensive Platform Operations Briefing — 12-section intelligence report
import { json } from "../lib/cors";
import { sendBriefingEmail } from "../lib/briefing-email";
import { createAgentRun, completeAgentRun, failAgentRun } from "../db/agent-runs";
import { logger } from "../lib/logger";
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

/**
 * Wraps briefing generation + persistence in the standard agent-run
 * contract: an `agent_runs` row at start (status running), completion
 * with `completed_at` + `records_processed`, a telemetry `agent_events`
 * row after completion (target_agent = NULL — the briefing dispatches
 * nothing downstream), and `error_message` capture on failure.
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
  fn: () => Promise<{ result: T; briefingId: number }>,
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

  let result: T;
  let briefingId: number;
  try {
    ({ result, briefingId } = await fn());
  } catch (err) {
    // Genuine generation failure — mark the run failed (best-effort) and
    // re-throw so the caller's existing error handling is unchanged.
    const message = err instanceof Error ? err.message : String(err);
    if (runId) {
      await failAgentRun(env, runId, message).catch(() => {
        /* run-tracking failure must not mask the original error */
      });
    }
    throw err;
  }

  // fn() succeeded: the deliverable is done. Everything below is
  // instrumentation only and must not be able to fail the briefing.
  if (runId) {
    try {
      await completeAgentRun(env, runId, {
        records_processed: 1,
        outputs_generated: 1,
        status: "success",
      });
    } catch (err) {
      logger.error("briefing_run_complete_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Telemetry-only completion event: target_agent = NULL means the
  // orchestrator's agent_events consumer records it for operator
  // traceability and marks it done without dispatching anything.
  try {
    await env.DB.prepare(
      `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
       VALUES (?, 'briefing_generated', ?, NULL, ?, 3, 'pending')`,
    )
      .bind(
        crypto.randomUUID(),
        BRIEFING_AGENT_ID,
        JSON.stringify({ briefing_id: briefingId, trigger }),
      )
      .run();
  } catch (err) {
    logger.error("briefing_event_write_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
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

// ─── Safe query helper ──────────────────────────────────────────

async function safeQuery<T>(
  db: Env["DB"],
  sql: string,
  fallback: T,
): Promise<T> {
  try {
    const result = await db.prepare(sql).all();
    return result.results as T;
  } catch {
    return fallback;
  }
}

async function safeFirst<T>(
  db: Env["DB"],
  sql: string,
  fallback: T,
): Promise<T> {
  try {
    const result = await db.prepare(sql).first();
    return (result as T) ?? fallback;
  } catch {
    return fallback;
  }
}

// ─── Fetch comprehensive briefing data ──────────────────────────

export async function fetchComprehensiveBriefing(
  env: Env,
): Promise<ComprehensiveBriefing> {
  const db = env.DB;
  const now = new Date().toISOString();

  // Run all queries in parallel
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
  ] = await Promise.all([
    // A) Platform Overview
    safeFirst(
      db,
      `SELECT
        (SELECT COUNT(*) FROM threats) as total_threats,
        (SELECT COUNT(*) FROM threats WHERE first_seen >= datetime('now', '-24 hours')) as last_24h,
        (SELECT COUNT(*) FROM threats WHERE first_seen >= datetime('now', '-12 hours')) as last_12h,
        (SELECT ROUND(COUNT(*) * 1.0 / 24, 0) FROM threats WHERE first_seen >= datetime('now', '-24 hours')) as avg_per_hour,
        (SELECT COUNT(*) FROM monitored_brands WHERE status = 'active') as brands_monitored,
        (SELECT COUNT(*) FROM brands WHERE sector IS NOT NULL) as brands_classified`,
      {
        total_threats: 0,
        last_24h: 0,
        last_12h: 0,
        avg_per_hour: 0,
        brands_monitored: 0,
        brands_classified: 0,
      },
    ),
    safeFirst(
      db,
      `SELECT
        (SELECT COUNT(*) FROM threats WHERE first_seen >= datetime('now', '-24 hours')) as today_count,
        (SELECT COUNT(*) FROM threats WHERE first_seen >= datetime('now', '-48 hours') AND first_seen < datetime('now', '-24 hours')) as yesterday_count`,
      { today_count: 0, yesterday_count: 0 },
    ),

    // B) Feed Production (12h)
    safeQuery<Array<{ feed_name: string; runs: number; ingested: number }>>(
      db,
      `SELECT feed_name, COUNT(*) as runs, SUM(records_ingested) as ingested
       FROM feed_pull_history
       WHERE started_at >= datetime('now', '-12 hours')
       GROUP BY feed_name ORDER BY ingested DESC`,
      [],
    ),

    // C) Feed Health
    safeQuery<
      Array<{
        feed_name: string;
        health_status: string;
        last_successful_pull: string | null;
        last_error: string | null;
      }>
    >(
      db,
      `SELECT feed_name, health_status, last_successful_pull, last_error
       FROM feed_status WHERE health_status != 'disabled'
       ORDER BY health_status DESC, feed_name`,
      [],
    ),
    safeQuery<Array<{ health_status: string; count: number }>>(
      db,
      `SELECT health_status, COUNT(*) as count FROM feed_status
       WHERE health_status != 'disabled' GROUP BY health_status`,
      [],
    ),

    // D) Enrichment Pipeline
    safeFirst(
      db,
      `SELECT
        SUM(surbl_checked) as surbl_checked, SUM(surbl_listed) as surbl_hits,
        SUM(vt_checked) as vt_checked, SUM(CASE WHEN vt_malicious>0 THEN 1 ELSE 0 END) as vt_hits,
        SUM(gsb_checked) as gsb_checked, SUM(gsb_flagged) as gsb_hits,
        SUM(dbl_checked) as dbl_checked, SUM(dbl_listed) as dbl_hits,
        SUM(abuseipdb_checked) as abuse_checked, SUM(CASE WHEN abuseipdb_score>=50 THEN 1 ELSE 0 END) as abuse_hits,
        SUM(greynoise_checked) as gn_checked,
        SUM(seclookup_checked) as sec_checked
       FROM threats`,
      {
        surbl_checked: 0,
        surbl_hits: 0,
        vt_checked: 0,
        vt_hits: 0,
        gsb_checked: 0,
        gsb_hits: 0,
        dbl_checked: 0,
        dbl_hits: 0,
        abuse_checked: 0,
        abuse_hits: 0,
        gn_checked: 0,
        sec_checked: 0,
      },
    ),

    // E) Flight Controller
    safeFirst(
      db,
      `SELECT summary, created_at FROM agent_outputs
       WHERE agent_id = 'flight_control' AND type = 'diagnostic'
       ORDER BY created_at DESC LIMIT 1`,
      { summary: null, created_at: null },
    ),

    // F) Agent Activity (12h)
    safeQuery<Array<{ agent_id: string; runs: number; last_run: string }>>(
      db,
      `SELECT agent_id, COUNT(*) as runs, MAX(started_at) as last_run
       FROM agent_runs WHERE started_at >= datetime('now', '-12 hours')
       GROUP BY agent_id ORDER BY runs DESC`,
      [],
    ),

    // G) New Capabilities — legacy counts stay in their own query so a missing
    //    app_store_listings / dark_web_mentions table can't zero them out.
    safeFirst(
      db,
      `SELECT
        (SELECT COUNT(*) FROM threats WHERE source_feed = 'typosquat_scanner') as typosquat_total,
        (SELECT COUNT(*) FROM threats WHERE source_feed = 'typosquat_scanner' AND first_seen >= datetime('now', '-12 hours')) as typosquat_new,
        (SELECT COUNT(*) FROM social_mentions) as social_total,
        (SELECT COUNT(*) FROM social_mentions WHERE created_at >= datetime('now', '-12 hours')) as social_new,
        (SELECT COUNT(*) FROM threats WHERE source_feed = 'certstream') as certstream`,
      {
        typosquat_total: 0,
        typosquat_new: 0,
        social_total: 0,
        social_new: 0,
        certstream: 0,
      },
    ),
    // G2) App-store + dark-web capability counts — isolated so table drift
    //     can't knock out the legacy capability section above.
    safeFirst(
      db,
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
    safeFirst(db, `SELECT COUNT(*) as total_seeds FROM seed_addresses`, {
      total_seeds: 0,
    }),
    safeFirst(
      db,
      `SELECT COUNT(*) as total_captures FROM spam_trap_captures`,
      { total_captures: 0 },
    ),
    safeFirst(
      db,
      `SELECT COUNT(*) as captures_12h FROM spam_trap_captures WHERE captured_at >= datetime('now', '-12 hours')`,
      { captures_12h: 0 },
    ),
    safeQuery<
      Array<{
        trap_address: string;
        from_address: string;
        subject: string;
        category: string;
        severity: string;
        captured_at: string;
      }>
    >(
      db,
      `SELECT trap_address, from_address, subject, category, severity, captured_at
       FROM spam_trap_captures ORDER BY captured_at DESC LIMIT 5`,
      [],
    ),
    safeQuery<
      Array<{ seeded_location: string; seeds: number; catches: number }>
    >(
      db,
      `SELECT seeded_location, COUNT(*) as seeds, SUM(total_catches) as catches
       FROM seed_addresses WHERE seeded_location IS NOT NULL AND seeded_location != ''
       GROUP BY seeded_location ORDER BY catches DESC`,
      [],
    ),

    // I) Honeypot
    safeFirst(
      db,
      `SELECT COUNT(*) as total_visits,
        SUM(is_bot) as bot_visits,
        COUNT(*) - SUM(is_bot) as human_visits
       FROM honeypot_visits`,
      { total_visits: 0, bot_visits: 0, human_visits: 0 },
    ),
    safeFirst(
      db,
      `SELECT COUNT(*) as visits_12h FROM honeypot_visits
       WHERE visited_at >= datetime('now', '-12 hours')`,
      { visits_12h: 0 },
    ),
    safeQuery<Array<{ page: string; visits: number; bots: number }>>(
      db,
      `SELECT page, COUNT(*) as visits, SUM(is_bot) as bots
       FROM honeypot_visits GROUP BY page ORDER BY visits DESC LIMIT 20`,
      [],
    ),
    safeFirst(
      db,
      `SELECT COUNT(DISTINCT page) AS distinct_pages FROM honeypot_visits`,
      { distinct_pages: 0 },
    ),
    safeQuery<
      Array<{
        page: string;
        bot_name: string;
        country: string;
        visited_at: string;
      }>
    >(
      db,
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
    safeQuery<
      Array<{
        page: string;
        country: string;
        visited_at: string;
        asn: string | null;
        reason: "bait" | "probe";
      }>
    >(
      db,
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
    safeQuery<Array<{ severity: string; count: number }>>(
      db,
      `SELECT severity, COUNT(*) as count
       FROM threats WHERE first_seen >= datetime('now', '-12 hours')
       GROUP BY severity ORDER BY
         CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
         WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`,
      [],
    ),
    safeQuery<Array<{ source_feed: string; count: number }>>(
      db,
      `SELECT source_feed, COUNT(*) as count
       FROM threats WHERE first_seen >= datetime('now', '-12 hours')
       GROUP BY source_feed ORDER BY count DESC LIMIT 10`,
      [],
    ),
    safeQuery<
      Array<{
        malicious_domain: string;
        type: string;
        severity: string;
        source_feed: string;
        first_seen: string;
      }>
    >(
      db,
      `SELECT malicious_domain, threat_type AS type, severity, source_feed, first_seen
       FROM threats WHERE first_seen >= datetime('now', '-12 hours')
       AND severity IN ('critical', 'high')
       ORDER BY first_seen DESC LIMIT 10`,
      [],
    ),

    // K) Top Targeted Brands (24h)
    safeQuery<Array<{ name: string; threats_24h: number }>>(
      db,
      `SELECT b.name, COUNT(*) as threats_24h
       FROM threats t JOIN brands b ON t.target_brand_id = b.id
       WHERE t.first_seen >= datetime('now', '-24 hours') AND t.target_brand_id IS NOT NULL
       GROUP BY b.name ORDER BY threats_24h DESC LIMIT 10`,
      [],
    ),

    // L) Anomalies
    safeQuery<
      Array<{ feed_name: string; last_successful_pull: string | null }>
    >(
      db,
      `SELECT feed_name, last_successful_pull FROM feed_status
       WHERE health_status NOT IN ('disabled')
       AND (last_successful_pull IS NULL OR last_successful_pull < datetime('now', '-6 hours'))`,
      [],
    ),
    safeQuery<Array<{ feed_name: string; last_error: string | null }>>(
      db,
      `SELECT feed_name, last_error FROM feed_status
       WHERE health_status IN ('degraded', 'failed') AND last_error IS NOT NULL`,
      [],
    ),

    // M) Brand Coverage
    safeQuery<Array<{ sector: string; brands: number }>>(
      db,
      `SELECT sector, COUNT(*) as brands FROM brands
       WHERE sector IS NOT NULL GROUP BY sector ORDER BY brands DESC LIMIT 10`,
      [],
    ),

    // N) Geopolitical Campaigns
    safeQuery<Array<{
      name: string; status: string; conflict: string;
      start_date: string; briefing_priority: string;
      total_threats: number; new_24h: number; brands_hit: number;
      threat_actors: string; notes: string | null;
    }>>(
      db,
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

  return {
    platformOverview: {
      totalThreats: Number(overview.total_threats) || 0,
      last24h: Number(overview.last_24h) || 0,
      last12h: Number(overview.last_12h) || 0,
      avgPerHour: Number(overview.avg_per_hour) || 0,
      brandsMonitored: Number(overview.brands_monitored) || 0,
      brandsClassified: Number(overview.brands_classified) || 0,
      todayCount: Number(dayOverDay.today_count) || 0,
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
      typosquat_total: Number(newCapabilities.typosquat_total) || 0,
      typosquat_new: Number(newCapabilities.typosquat_new) || 0,
      social_total: Number(newCapabilities.social_total) || 0,
      social_new: Number(newCapabilities.social_new) || 0,
      certstream: Number(newCapabilities.certstream) || 0,
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
        const briefing = await fetchComprehensiveBriefing(env);

        const title = `Platform Operations Briefing — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
        const reportDate = new Date().toISOString().slice(0, 10);

        const insertResult = await env.DB.prepare(
          `INSERT INTO threat_briefings (type, report_date, report_data, generated_at, trigger, emailed)
          VALUES ('daily', ?, ?, datetime('now'), ?, 0)`,
        )
          .bind(reportDate, JSON.stringify(briefing), `user:${userId}`)
          .run();
        const briefingId = insertResult.meta.last_row_id;

        // Send briefing email (non-blocking)
        const sendEmail = url.searchParams.get("sendEmail") !== "false";
        let emailResult: { sent: boolean; id?: string; error?: string; recipient?: string } | undefined;
        if (sendEmail) {
          emailResult = await sendBriefingEmail(env, briefing, title).catch(
            (err) => ({ sent: false, error: "An internal error occurred", recipient: '' }),
          );
          if (emailResult.sent) {
            await env.DB.prepare(
              "UPDATE threat_briefings SET emailed = 1 WHERE id = ?",
            )
              .bind(briefingId)
              .run();
          } else {
            // Persist Resend error for diagnostics surface.
            try {
              const updated = JSON.stringify({
                ...briefing,
                email_error: emailResult.error ?? 'unknown',
                email_recipient: emailResult.recipient ?? null,
              });
              await env.DB.prepare(
                "UPDATE threat_briefings SET report_data = ? WHERE id = ?",
              ).bind(updated, briefingId).run();
            } catch { /* non-fatal */ }
          }
        }

        const stored = await env.DB.prepare(
          "SELECT id, type, report_date, report_data, generated_at, trigger, emailed FROM threat_briefings WHERE id = ?",
        )
          .bind(briefingId)
          .first();
        return { result: { stored, emailResult }, briefingId: Number(briefingId) };
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
    const briefing = await fetchComprehensiveBriefing(env);

    const title = `Platform Operations Briefing — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    const reportDate = new Date().toISOString().slice(0, 10);

    const insertResult = await env.DB.prepare(
      `INSERT INTO threat_briefings (type, report_date, report_data, generated_at, trigger, emailed)
      VALUES ('daily', ?, ?, datetime('now'), ?, 0)`,
    )
      .bind(reportDate, JSON.stringify(briefing), trigger)
      .run();
    const briefingId = Number(insertResult.meta.last_row_id);

    const emailResult = await sendBriefingEmail(env, briefing, title).catch(
      (err) => ({ sent: false as const, error: "An internal error occurred", recipient: '' }),
    );

    if (emailResult.sent) {
      await env.DB.prepare(
        "UPDATE threat_briefings SET emailed = 1 WHERE id = ?",
      )
        .bind(briefingId)
        .run();
    } else {
      // Persist the Resend error into report_data.email_error so the
      // briefing_status diagnostics tell the operator WHY it failed.
      // Adding a column would need a migration; report_data is JSON
      // so we can patch it in place.
      try {
        const updated = JSON.stringify({
          ...briefing,
          email_error: emailResult.error ?? 'unknown',
          email_recipient: 'recipient' in emailResult ? emailResult.recipient : null,
        });
        await env.DB.prepare(
          "UPDATE threat_briefings SET report_data = ? WHERE id = ?",
        ).bind(updated, briefingId).run();
      } catch { /* non-fatal */ }
    }

    return {
      result: { briefingId, emailSent: emailResult.sent, error: emailResult.error },
      briefingId,
    };
  });
}
