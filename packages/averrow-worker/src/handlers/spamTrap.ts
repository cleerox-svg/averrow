/**
 * Spam Trap API Endpoints
 *
 * GET  /api/spam-trap/stats                    — Overall stats + daily chart
 * GET  /api/spam-trap/captures                 — Recent captures (admin)
 * GET  /api/spam-trap/captures/brand/:brandId  — Captures for a specific brand
 * GET  /api/spam-trap/sources                  — Top source IPs
 * GET  /api/spam-trap/campaigns                — All seed campaigns
 * POST /api/spam-trap/campaigns                — Create new seed campaign
 * POST /api/spam-trap/campaigns/:id/execute    — Execute a paste seeding campaign
 * PUT  /api/spam-trap/campaigns/:id            — Update campaign status
 * GET  /api/spam-trap/addresses                — All seed addresses with catch counts
 * POST /api/spam-trap/seed/initial             — Deploy initial set of trap addresses
 */

import { json } from "../lib/cors";
import { handler, parsePagination, success, error, parseBody } from "../lib/handler-utils";
import type { Env } from "../types";
import { executePasteSeeding } from "../seeders/paste-seeder";

// ── GET /api/spam-trap/stats ──────────────────────────────────────

export const handleSpamTrapStats = handler(async (_request, env, ctx) => {
  const stats = await env.DB.prepare(`
    SELECT
      COUNT(*) as total_captures,
      COUNT(DISTINCT spoofed_brand_id) as brands_spoofed,
      COUNT(DISTINCT sending_ip) as unique_ips,
      ROUND(
        CAST(SUM(CASE WHEN spf_result = 'fail' OR dkim_result = 'fail' OR dmarc_result = 'fail' THEN 1 ELSE 0 END) AS REAL)
        / MAX(COUNT(*), 1) * 100, 1
      ) as auth_fail_rate,
      SUM(CASE WHEN captured_at > datetime('now', '-24 hours') THEN 1 ELSE 0 END) as last_24h
    FROM spam_trap_captures
  `).first();

  const daily = await env.DB.prepare(`
    SELECT
      date(captured_at) as date,
      COUNT(*) as total,
      SUM(CASE WHEN category = 'phishing' THEN 1 ELSE 0 END) as phishing,
      SUM(CASE WHEN category = 'spam' THEN 1 ELSE 0 END) as spam,
      SUM(CASE WHEN category = 'malware' THEN 1 ELSE 0 END) as malware
    FROM spam_trap_captures
    WHERE captured_at > datetime('now', '-30 days')
    GROUP BY date(captured_at)
    ORDER BY date ASC
  `).all();

  const health = await env.DB.prepare(`
    SELECT channel, COUNT(*) as count
    FROM seed_addresses
    WHERE status = 'active'
    GROUP BY channel
  `).all();

  return success({ stats, daily: daily.results, health: health.results }, ctx.origin);
});

// ── GET /api/spam-trap/captures ───────────────────────────────────

export const handleSpamTrapCaptures = handler(async (request, env, ctx) => {
  const { limit, offset } = parsePagination(request);

  const rows = await env.DB.prepare(`
    SELECT id, trap_address, trap_channel, from_address, from_domain, subject,
      spf_result, dkim_result, dmarc_result, dmarc_disposition,
      sending_ip, spoofed_brand_id, spoofed_domain, category, severity,
      url_count, attachment_count, country_code, captured_at, threat_id,
      SUBSTR(body_preview, 1, 80) as body_preview
    FROM spam_trap_captures
    ORDER BY captured_at DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const total = await env.DB.prepare("SELECT COUNT(*) as c FROM spam_trap_captures").first<{ c: number }>();

  return json({ success: true, data: rows.results, total: total?.c || 0 }, 200, ctx.origin);
});

// ── GET /api/spam-trap/captures/brand/:brandId ────────────────────

export async function handleSpamTrapCapturesByBrand(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const summary = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(DISTINCT sending_ip) as unique_ips,
        ROUND(
          CAST(SUM(CASE WHEN spf_result = 'fail' OR dkim_result = 'fail' OR dmarc_result = 'fail' THEN 1 ELSE 0 END) AS REAL)
          / MAX(COUNT(*), 1) * 100, 1
        ) as auth_fail_pct
      FROM spam_trap_captures
      WHERE spoofed_brand_id = ?
    `).bind(brandId).first();

    const recent = await env.DB.prepare(`
      SELECT from_address, subject, spf_result, dkim_result, dmarc_result,
        sending_ip, category, severity, captured_at
      FROM spam_trap_captures
      WHERE spoofed_brand_id = ?
      ORDER BY captured_at DESC
      LIMIT 10
    `).bind(brandId).all();

    return success({
      total: summary?.total || 0,
      unique_ips: summary?.unique_ips || 0,
      auth_fail_pct: summary?.auth_fail_pct || 0,
      recent: recent.results,
    }, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ── GET /api/spam-trap/sources ────────────────────────────────────

export const handleSpamTrapSources = handler(async (_request, env, ctx) => {
  const rows = await env.DB.prepare(`
    SELECT
      sending_ip,
      COUNT(*) as emails_caught,
      COUNT(DISTINCT spoofed_brand_id) as brands_hit,
      country_code, asn, org,
      MAX(captured_at) as last_seen
    FROM spam_trap_captures
    WHERE sending_ip IS NOT NULL
    GROUP BY sending_ip
    ORDER BY emails_caught DESC
    LIMIT 50
  `).all();

  return success(rows.results, ctx.origin);
});

// ── GET /api/spam-trap/campaigns ──────────────────────────────────

export const handleSpamTrapCampaigns = handler(async (_request, env, ctx) => {
  const rows = await env.DB.prepare(`
    SELECT id, name, channel, status, target_brands, addresses_seeded,
      total_catches, unique_ips_caught, brands_spoofed,
      last_catch_at, created_by, strategist_notes,
      created_at, updated_at
    FROM seed_campaigns
    ORDER BY created_at DESC
    LIMIT 200
  `).all();

  return success(rows.results, ctx.origin);
});

// ── POST /api/spam-trap/campaigns ─────────────────────────────────

export const handleCreateSpamTrapCampaign = handler(async (request, env, ctx) => {
  const body = await parseBody<{
    name: string;
    channel: string;
    target_brands?: string[];
    addresses?: string[];
    config?: Record<string, unknown>;
  }>(request);

  const result = await env.DB.prepare(`
    INSERT INTO seed_campaigns (name, channel, target_brands, config, addresses_seeded)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    body.name, body.channel,
    JSON.stringify(body.target_brands || []),
    JSON.stringify({ ...body.config, addresses: body.addresses || [] }),
    (body.addresses || []).length
  ).run();

  for (const addr of body.addresses || []) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      addr, addr.split("@")[1], body.channel,
      result.meta?.last_row_id,
      body.target_brands?.[0] || null
    ).run();
  }

  return success({ id: result.meta?.last_row_id }, ctx.origin, 201);
});

// ── POST /api/spam-trap/campaigns/:id/execute ─────────────────────

export async function handleExecuteSpamTrapCampaign(request: Request, env: Env, campaignId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT id, config, target_brands FROM seed_campaigns WHERE id = ?"
    ).bind(campaignId).first<{ id: number; config: string; target_brands: string }>();

    if (!campaign) return error("Campaign not found", 404, origin);

    const result = await executePasteSeeding(env, campaign);
    return success(result, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ── PUT /api/spam-trap/campaigns/:id ──────────────────────────────

export async function handleUpdateSpamTrapCampaign(request: Request, env: Env, campaignId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await parseBody<{ status?: string; name?: string }>(request);

    if (body.status) {
      await env.DB.prepare(
        "UPDATE seed_campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(body.status, campaignId).run();
    }
    if (body.name) {
      await env.DB.prepare(
        "UPDATE seed_campaigns SET name = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(body.name, campaignId).run();
    }

    return json({ success: true }, 200, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ── GET /api/spam-trap/addresses ──────────────────────────────────

export const handleSpamTrapAddresses = handler(async (_request, env, ctx) => {
  const rows = await env.DB.prepare(`
    SELECT id, address, domain, channel, campaign_id, brand_target,
      seeded_at, seeded_location, total_catches, last_catch_at, status
    FROM seed_addresses
    ORDER BY total_catches DESC
    LIMIT 500
  `).all();

  return success(rows.results, ctx.origin);
});

// ── POST /api/spam-trap/seed/initial ──────────────────────────────

export const handleInitialSeed = handler(async (_request, env, ctx) => {
  const genericPrefixes = [
    "admin", "info", "support", "billing", "security", "contact",
    "help", "sales", "hr", "finance", "webmaster", "postmaster",
    "abuse", "noreply",
  ];

  const brandTraps = [
    { prefix: "amazon-support", brand: "brand_amazon_com" },
    { prefix: "amazon-billing", brand: "brand_amazon_com" },
    { prefix: "apple-support", brand: "brand_apple_com" },
    { prefix: "apple-id", brand: "brand_apple_com" },
    { prefix: "google-security", brand: "brand_google_com" },
    { prefix: "microsoft-account", brand: "brand_microsoft_com" },
    { prefix: "netflix-billing", brand: "brand_netflix_com" },
    { prefix: "paypal-support", brand: null as string | null },
    { prefix: "docusign-sign", brand: "brand_docusign_net" },
    { prefix: "coinbase-verify", brand: "brand_coinbase" },
    { prefix: "instagram-help", brand: "brand_instagram_com" },
    { prefix: "facebook-security", brand: "brand_facebook_com" },
    { prefix: "whatsapp-verify", brand: "brand_whatsapp_com" },
    { prefix: "roblox-support", brand: "brand_roblox_com" },
    { prefix: "disney-plus", brand: "brand_disney" },
  ];

  const employeePrefixes = [
    "james.wilson", "sarah.chen", "michael.patel", "jennifer.smith",
    "david.johnson", "lisa.rodriguez", "ceo", "cfo", "cto",
  ];

  let created = 0;

  for (const domain of ["averrow.com", "trustradar.ca", "lrxradar.com"]) {
    for (const prefix of genericPrefixes) {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target)
        VALUES (?, ?, 'generic', NULL)
      `).bind(`${prefix}@${domain}`, domain).run();
      created++;
    }
  }

  for (const trap of brandTraps) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target)
      VALUES (?, 'averrow.com', 'brand', ?)
    `).bind(`${trap.prefix}@averrow.com`, trap.brand).run();
    created++;
  }

  for (const prefix of employeePrefixes) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO seed_addresses (address, domain, channel)
      VALUES (?, 'averrow.com', 'employee')
    `).bind(`${prefix}@averrow.com`).run();
    created++;
  }

  return success({ addresses_created: created }, ctx.origin);
});

// ── GET /api/spam-trap/captures/:id ───────────────────────────────

export async function handleSpamTrapCaptureDetail(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const capture = await env.DB.prepare(`
      SELECT * FROM spam_trap_captures WHERE id = ?
    `).bind(id).first<Record<string, unknown>>();

    if (!capture) return error("Capture not found", 404, origin);

    let urls: unknown[] = [];
    let attachments: unknown[] = [];
    try { urls = JSON.parse(capture["urls_found"] as string || "[]"); } catch { /* empty */ }
    try { attachments = JSON.parse(capture["attachment_hashes"] as string || "[]"); } catch { /* empty */ }

    let brand_name: string | null = null;
    if (capture["spoofed_brand_id"]) {
      const brand = await env.DB.prepare(
        "SELECT name FROM brands WHERE id = ?"
      ).bind(capture["spoofed_brand_id"]).first<{ name: string }>();
      brand_name = brand?.name ?? null;
    }

    return success({ ...capture, urls, attachments, brand_name }, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ── POST /api/spam-trap/reparse-auth ──────────────────────────────

export const handleSpamTrapReparseAuth = handler(async (_request, env, ctx) => {
  const rows = await env.DB.prepare(
    "SELECT id, raw_headers FROM spam_trap_captures WHERE raw_headers IS NOT NULL"
  ).all();

  let updated = 0;
  for (const row of rows.results) {
    const headers = row.raw_headers as string;
    const authMatch = headers.match(/(?:arc-)?authentication-results:\s*([^\n]+(?:\n\s+[^\n]+)*)/i);
    if (!authMatch) continue;

    const auth = (authMatch[1] ?? '').replace(/\n\s+/g, ' ');
    const spf = auth.match(/spf=(pass|fail|softfail|neutral|none|temperror|permerror)/i);
    const spfDomain = auth.match(/spf=\S+[^;]*?(?:domain|sender|from)=([^\s;]+)/i);
    const dkim = auth.match(/dkim=(pass|fail|neutral|none|temperror|permerror)/i);
    const dkimDomain = auth.match(/dkim=\S+[^;]*?(?:header\.d|d)=([^\s;]+)/i);
    const dmarc = auth.match(/dmarc=(pass|fail|none|bestguesspass)/i);
    const dmarcDisp = auth.match(/dmarc=\S+[^;]*?(?:action|disposition)=([^\s;]+)/i);

    if (spf || dkim || dmarc) {
      await env.DB.prepare(
        "UPDATE spam_trap_captures SET spf_result=?, spf_domain=?, dkim_result=?, dkim_domain=?, dmarc_result=?, dmarc_disposition=? WHERE id=?"
      ).bind(
        spf?.[1] || null, spfDomain?.[1] || null,
        dkim?.[1] || null, dkimDomain?.[1] || null,
        dmarc?.[1] || null, dmarcDisp?.[1] || null,
        row.id
      ).run();
      updated++;
    }
  }
  return json({ success: true, updated }, 200, ctx.origin);
});

// ── GET /api/spam-trap/seeding-sources ────────────────────────────

export const handleSpamTrapSeedingSources = handler(async (_request, env, ctx) => {
  // Per-location yield tracking — surfaces which seeding locations
  // (paste sites, broker pages, honeypot URLs, GitHub gists, etc) are
  // actually producing captures vs which are dead weight. Drives the
  // SOURCES tab in the spam-trap UI and informs which vectors the
  // seeding-at-scale job should prioritize.
  //
  //   productive_count : addresses on this location that have caught
  //                      at least one email (the trap is "live" here)
  //   last_catch_at    : most recent capture across all addresses on
  //                      this location — null if it's never produced
  //   earliest_seed    : when the oldest address on this location was
  //                      planted; used to mark dead locations that are
  //                      old enough to have aged out of harvest lists
  const sources = await env.DB.prepare(`
    SELECT
      seeded_location AS location,
      COUNT(*) AS seeds,
      COALESCE(SUM(total_catches), 0) AS catches,
      SUM(CASE WHEN total_catches > 0 THEN 1 ELSE 0 END) AS productive_count,
      MAX(last_catch_at) AS last_catch_at,
      MIN(seeded_at) AS earliest_seed
    FROM seed_addresses
    WHERE seeded_location IS NOT NULL
    GROUP BY seeded_location
    ORDER BY catches DESC, seeds DESC
  `).all();

  // Honeypot visit stats
  const visitTotal = await env.DB.prepare(
    "SELECT COUNT(*) as total, SUM(is_bot) as bots FROM honeypot_visits"
  ).first<{ total: number; bots: number }>();

  const visitLast24h = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM honeypot_visits WHERE visited_at > datetime('now', '-24 hours')"
  ).first<{ c: number }>();

  const byPage = await env.DB.prepare(`
    SELECT page, COUNT(*) as visits, SUM(is_bot) as bots
    FROM honeypot_visits
    GROUP BY page
    ORDER BY visits DESC
  `).all();

  const recentCrawlers = await env.DB.prepare(`
    SELECT page, visitor_ip, bot_name, user_agent, country, asn, visited_at
    FROM honeypot_visits
    WHERE is_bot = 1
    ORDER BY visited_at DESC
    LIMIT 20
  `).all();

  const uniqueBots = await env.DB.prepare(
    "SELECT COUNT(DISTINCT COALESCE(bot_name, visitor_ip)) as c FROM honeypot_visits WHERE is_bot = 1"
  ).first<{ c: number }>();

  return success({
    sources: sources.results,
    honeypot_visits: {
      total: visitTotal?.total ?? 0,
      bots: visitTotal?.bots ?? 0,
      last_24h: visitLast24h?.c ?? 0,
      unique_bots: uniqueBots?.c ?? 0,
      by_page: byPage.results,
      recent_crawlers: recentCrawlers.results,
    },
  }, ctx.origin);
});

// ── POST /api/spam-trap/strategist/run ────────────────────────────

export const handleRunStrategist = handler(async (_request, env, ctx) => {
  const { seedStrategistAgent } = await import("../agents/seed-strategist");
  const { executeAgent } = await import("../lib/agentRunner");
  const result = await executeAgent(env, seedStrategistAgent, {}, "manual", "manual");
  return success(result, ctx.origin);
});

// ── POST /api/spam-trap/seeds/:id/retire ──────────────────────────
//
// Wave-1 PR-AB: operator-driven retirement of dead seed addresses.
// Sets `status = 'retired'` so the address no longer counts in the
// caught/stale/pending/dead bucketing on the UI and the auto-seeder
// can recycle the seeded_location for a fresh address.
//
// We DON'T delete the row — historical attribution matters (if a
// previously-dead seed suddenly catches something, the row needs to
// still exist for the catch to be recorded). Retirement is a soft
// delete by design.
//
// Bulk auto-prune of stale-dead addresses (seeded > 60d AND
// total_catches = 0) runs in the seed_strategist agent's tick — see
// retireStaleDeadSeeds() in agents/seed-strategist.ts.
export const handleRetireSeedAddress = handler(async (request: Request & { params?: Record<string, string> }, env, ctx) => {
  const idRaw = request.params?.id ?? '';
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) {
    return error('Invalid seed id', 400, ctx.origin);
  }
  const result = await env.DB.prepare(
    `UPDATE seed_addresses SET status = 'retired' WHERE id = ? AND status != 'retired'`,
  ).bind(id).run();
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) {
    return error('Seed not found or already retired', 404, ctx.origin);
  }
  return success({ id, retired: true }, ctx.origin);
});

// ── GET /api/spam-trap/insights ───────────────────────────────────
//
// Wave-4 PR-AE: bundles three "drill-deeper" datasets the Spam Trap
// page surfaces in dedicated tabs. One round-trip per page mount
// (cached 5 min in KV) keeps the new tabs cheap.
//
//   trends:       weekly capture counts × channel + cohort time-to-
//                 first-catch + per-channel productive-rate snapshot
//   correlations: recent abuse_mailbox captures with the count of
//                 seeded-honeypot captures that share their from_domain
//                 or sending_ip — the "covert spam trap" payoff
//                 (PR-AC cross-link makes this query trivial)
//   strategy:     last seed_strategist run + recent retired-seed count
//                 + last 5 strategist diagnostic outputs
//
// Each block is bounded by index hits and small LIMITs so the whole
// endpoint is well under 50K rows scanned in steady state.
export const handleSpamTrapInsights = handler(async (_request, env, ctx) => {
  // ── 1. Trends ────────────────────────────────────────────────
  // 8-week rolling window of captures grouped by week × channel.
  const weekly = await env.DB.prepare(`
    SELECT
      strftime('%Y-%m-%d', captured_at, 'weekday 0', '-6 days') AS week_start,
      COUNT(*) AS total,
      SUM(CASE WHEN trap_channel = 'spider'        THEN 1 ELSE 0 END) AS spider,
      SUM(CASE WHEN trap_channel = 'broker'        THEN 1 ELSE 0 END) AS broker,
      SUM(CASE WHEN trap_channel = 'paste'         THEN 1 ELSE 0 END) AS paste,
      SUM(CASE WHEN trap_channel = 'honeypot'      THEN 1 ELSE 0 END) AS honeypot,
      SUM(CASE WHEN trap_channel = 'abuse_mailbox' THEN 1 ELSE 0 END) AS abuse_mailbox,
      SUM(CASE WHEN trap_channel = 'employee'      THEN 1 ELSE 0 END) AS employee
    FROM spam_trap_captures
    WHERE captured_at > datetime('now', '-8 weeks')
    GROUP BY week_start
    ORDER BY week_start ASC
  `).all<{
    week_start: string; total: number; spider: number; broker: number;
    paste: number; honeypot: number; abuse_mailbox: number; employee: number;
  }>();

  // Cohort time-to-first-catch — for seeds planted in each of the last
  // 8 weeks, the avg # of days from seeding to the first-recorded
  // capture against that trap_address. Small bounded scan.
  const cohorts = await env.DB.prepare(`
    SELECT
      strftime('%Y-%m-%d', sa.seeded_at, 'weekday 0', '-6 days') AS cohort_week,
      COUNT(sa.id) AS seeds_in_cohort,
      SUM(CASE WHEN sa.total_catches > 0 THEN 1 ELSE 0 END) AS caught,
      ROUND(AVG(CASE WHEN sa.total_catches > 0
        THEN julianday(
          (SELECT MIN(captured_at) FROM spam_trap_captures stc
           WHERE stc.trap_address = sa.address)
        ) - julianday(sa.seeded_at)
        ELSE NULL END), 1) AS avg_days_to_first_catch
    FROM seed_addresses sa
    WHERE sa.seeded_at > datetime('now', '-8 weeks')
      AND sa.status != 'retired'
    GROUP BY cohort_week
    ORDER BY cohort_week ASC
  `).all<{
    cohort_week: string; seeds_in_cohort: number; caught: number;
    avg_days_to_first_catch: number | null;
  }>();

  // Per-channel productive-rate snapshot.
  const channelRates = await env.DB.prepare(`
    SELECT
      channel,
      COUNT(*) AS total_seeds,
      SUM(CASE WHEN total_catches > 0 THEN 1 ELSE 0 END) AS productive_seeds
    FROM seed_addresses
    WHERE status = 'active'
    GROUP BY channel
    ORDER BY total_seeds DESC
  `).all<{ channel: string; total_seeds: number; productive_seeds: number }>();

  // ── 2. Correlations ──────────────────────────────────────────
  // Recent abuse_mailbox captures with overlap counts against the
  // seeded-honeypot universe. Both indexes (idx_stc_domain, idx_stc_ip)
  // exist already so the correlated subqueries are seek lookups, not
  // scans. LIMIT 25 keeps the per-row subqueries bounded.
  const correlations = await env.DB.prepare(`
    SELECT
      m.id, m.captured_at, m.from_address, m.from_domain, m.sending_ip,
      m.subject, m.severity,
      (SELECT COUNT(*) FROM spam_trap_captures s
        WHERE s.from_domain = m.from_domain
          AND s.from_domain IS NOT NULL
          AND s.trap_channel != 'abuse_mailbox'
          AND s.id != m.id) AS by_domain,
      (SELECT COUNT(*) FROM spam_trap_captures s
        WHERE s.sending_ip = m.sending_ip
          AND s.sending_ip IS NOT NULL
          AND s.trap_channel != 'abuse_mailbox'
          AND s.id != m.id) AS by_ip
    FROM spam_trap_captures m
    WHERE m.trap_channel = 'abuse_mailbox'
    ORDER BY m.captured_at DESC
    LIMIT 25
  `).all<{
    id: number; captured_at: string; from_address: string | null;
    from_domain: string | null; sending_ip: string | null;
    subject: string | null; severity: string;
    by_domain: number; by_ip: number;
  }>();

  // ── 3. Strategy ──────────────────────────────────────────────
  const lastRun = await env.DB.prepare(`
    SELECT id, started_at, completed_at, status, records_processed, error_message
    FROM agent_runs
    WHERE agent_id = 'seed_strategist'
    ORDER BY started_at DESC
    LIMIT 1
  `).first<{
    id: string; started_at: string; completed_at: string | null;
    status: string; records_processed: number; error_message: string | null;
  }>();

  const recentPrunes = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM seed_addresses
    WHERE status = 'retired'
      AND seeded_at > datetime('now', '-30 days')
  `).first<{ n: number }>();

  const recentOutputs = await env.DB.prepare(`
    SELECT id, type, summary, severity, details, created_at
    FROM agent_outputs
    WHERE agent_id = 'seed_strategist'
    ORDER BY created_at DESC
    LIMIT 5
  `).all<{
    id: string; type: string; summary: string; severity: string | null;
    details: string | null; created_at: string;
  }>();

  return success({
    trends: {
      weekly:        weekly.results ?? [],
      cohorts:       cohorts.results ?? [],
      channel_rates: channelRates.results ?? [],
    },
    correlations: {
      recent: correlations.results ?? [],
    },
    strategy: {
      last_run:           lastRun ?? null,
      recent_prunes_30d:  recentPrunes?.n ?? 0,
      recent_outputs:     recentOutputs.results ?? [],
    },
  }, ctx.origin);
});
