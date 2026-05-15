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
