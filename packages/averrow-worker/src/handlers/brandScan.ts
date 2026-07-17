// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Brand Exposure Engine — Domain scan handlers.
 *
 * Features:
 * - DNS/email security checks (SPF, DMARC, DKIM, MX)
 * - Lookalike/typosquat domain detection
 * - Feed cross-reference (search all threat data for brand mentions)
 * - Certificate transparency lookups
 * - Trust score computation per brand
 * - History tracking
 * - Public free scan (score only, no details)
 * - Leads capture
 */

import { json } from "../lib/cors";
import { isFreemailEmail } from "../lib/freemail";
import type { Env } from "../types";

// ─── Typosquat / Lookalike Domain Generation ────────────────────

function generateLookalikes(domain: string): string[] {
  const parts = domain.split(".");
  if (parts.length < 2) return [];
  const name = parts[0]!;
  const tld = parts.slice(1).join(".");
  const lookalikes: string[] = [];

  // Character substitution (homoglyphs)
  const homoglyphs: Record<string, string[]> = {
    a: ["@", "4", "à", "á", "â", "ã", "ä"],
    e: ["3", "è", "é", "ê", "ë"],
    i: ["1", "l", "!", "ì", "í"],
    o: ["0", "ò", "ó", "ô", "õ", "ö"],
    l: ["1", "i", "|"],
    s: ["5", "$"],
    t: ["7", "+"],
    g: ["9", "q"],
    n: ["m"],
    m: ["n", "rn"],
  };

  // Transpositions (swap adjacent chars)
  for (let i = 0; i < name.length - 1; i++) {
    const swapped = name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2);
    if (swapped !== name) lookalikes.push(`${swapped}.${tld}`);
  }

  // Missing character
  for (let i = 0; i < name.length; i++) {
    const missing = name.slice(0, i) + name.slice(i + 1);
    if (missing.length >= 2) lookalikes.push(`${missing}.${tld}`);
  }

  // Extra character (double a letter)
  for (let i = 0; i < name.length; i++) {
    const doubled = name.slice(0, i + 1) + name[i] + name.slice(i + 1);
    lookalikes.push(`${doubled}.${tld}`);
  }

  // Homoglyph substitution (first occurrence only)
  for (const [char, subs] of Object.entries(homoglyphs)) {
    const idx = name.indexOf(char);
    if (idx >= 0) {
      for (const sub of subs.slice(0, 2)) {
        const variant = name.slice(0, idx) + sub + name.slice(idx + 1);
        lookalikes.push(`${variant}.${tld}`);
      }
    }
  }

  // TLD variations
  const altTlds = ["com", "net", "org", "info", "xyz", "io", "co", "biz", "site", "online", "app"];
  for (const alt of altTlds) {
    if (alt !== tld) lookalikes.push(`${name}.${alt}`);
  }

  // Hyphen insertion
  for (let i = 1; i < name.length; i++) {
    lookalikes.push(`${name.slice(0, i)}-${name.slice(i)}.${tld}`);
  }

  // Prefix/suffix attacks
  const prefixes = ["secure-", "login-", "my", "account-", "www-", "mail-", "update-"];
  const suffixes = ["-secure", "-login", "-verify", "-support", "-online"];
  for (const p of prefixes) lookalikes.push(`${p}${name}.${tld}`);
  for (const s of suffixes) lookalikes.push(`${name}${s}.${tld}`);

  return [...new Set(lookalikes)].slice(0, 100);
}

// ─── DNS Resolution Check ───────────────────────────────────────

async function checkDNS(domain: string): Promise<{
  spf: { record: string | null; policy: string | null };
  dmarc: { record: string | null; policy: string | null };
  mx: string[];
  resolved: boolean;
}> {
  const result = {
    spf: { record: null as string | null, policy: null as string | null },
    dmarc: { record: null as string | null, policy: null as string | null },
    mx: [] as string[],
    resolved: false,
  };

  try {
    // Use Google DNS-over-HTTPS for TXT records (SPF)
    const txtRes = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=TXT`,
      { headers: { Accept: "application/dns-json" } }
    );
    if (txtRes.ok) {
      const txtData = await txtRes.json() as { Answer?: Array<{ data: string }> };
      result.resolved = true;
      for (const answer of txtData.Answer ?? []) {
        const data = answer.data?.replace(/"/g, "") ?? "";
        if (data.startsWith("v=spf1")) {
          result.spf.record = data;
          if (data.includes("-all")) result.spf.policy = "hardfail";
          else if (data.includes("~all")) result.spf.policy = "softfail";
          else if (data.includes("?all")) result.spf.policy = "neutral";
          else result.spf.policy = "none";
        }
      }
    }

    // DMARC record
    const dmarcRes = await fetch(
      `https://dns.google/resolve?name=_dmarc.${encodeURIComponent(domain)}&type=TXT`,
      { headers: { Accept: "application/dns-json" } }
    );
    if (dmarcRes.ok) {
      const dmarcData = await dmarcRes.json() as { Answer?: Array<{ data: string }> };
      for (const answer of dmarcData.Answer ?? []) {
        const data = answer.data?.replace(/"/g, "") ?? "";
        if (data.startsWith("v=DMARC1")) {
          result.dmarc.record = data;
          const pMatch = data.match(/p=(\w+)/);
          result.dmarc.policy = pMatch?.[1] ?? "none";
        }
      }
    }

    // MX records
    const mxRes = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { Accept: "application/dns-json" } }
    );
    if (mxRes.ok) {
      const mxData = await mxRes.json() as { Answer?: Array<{ data: string }> };
      result.mx = (mxData.Answer ?? []).map(a => a.data).filter(Boolean);
    }
  } catch (err) {
    console.error(`[brand-scan] DNS check failed for ${domain}:`, err);
  }

  return result;
}

// ─── Check if lookalike domains resolve (registered) ────────────

async function checkLookalikeRegistration(domains: string[]): Promise<Array<{
  domain: string; registered: boolean; ip: string | null;
}>> {
  const results: Array<{ domain: string; registered: boolean; ip: string | null }> = [];
  // Check in small batches to avoid overwhelming DNS
  const BATCH = 10;
  for (let i = 0; i < Math.min(domains.length, 50); i += BATCH) {
    const batch = domains.slice(i, i + BATCH);
    const checks = batch.map(async (d) => {
      try {
        const res = await fetch(
          `https://dns.google/resolve?name=${encodeURIComponent(d)}&type=A`,
          { headers: { Accept: "application/dns-json" } }
        );
        if (res.ok) {
          const data = await res.json() as { Answer?: Array<{ data: string }> };
          if (data.Answer && data.Answer.length > 0) {
            return { domain: d, registered: true, ip: data.Answer[0]?.data ?? null };
          }
        }
        return { domain: d, registered: false, ip: null };
      } catch {
        return { domain: d, registered: false, ip: null };
      }
    });
    results.push(...(await Promise.all(checks)));
  }
  return results;
}

// ─── Feed Cross-Reference ───────────────────────────────────────

async function crossReferenceFeedData(domain: string, db: D1Database): Promise<{
  mentions: number;
  matches: Array<{ id: string; threat_type: string; severity: string | null; source_feed: string; created_at: string }>;
}> {
  // Column names match the actual `threats` schema (migrations 0001 + 0013):
  // malicious_domain, threat_type, source_feed. The previous version queried
  // non-existent `domain`, `type`, `title`, `source` columns and the SQL
  // exception was being caught by the outer handler as a generic "internal
  // error" — making the homepage scan widget appear broken.
  const rows = await db.prepare(`
    SELECT id, threat_type, severity, source_feed, created_at
    FROM threats
    WHERE (malicious_domain = ? OR malicious_domain LIKE ?)
      AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(domain, `%.${domain}`).all<{
    id: string; threat_type: string; severity: string | null; source_feed: string; created_at: string;
  }>();

  return { mentions: rows.results.length, matches: rows.results };
}

// ─── Trust Score Calculation ────────────────────────────────────

function calculateBrandTrustScore(params: {
  spfPolicy: string | null;
  dmarcPolicy: string | null;
  dkimFound: boolean;
  lookalikeCount: number;
  feedMentions: number;
  mxCount: number;
}): number {
  let score = 100;

  // SPF scoring (0-25 points)
  if (!params.spfPolicy || params.spfPolicy === "none") score -= 25;
  else if (params.spfPolicy === "softfail") score -= 10;
  else if (params.spfPolicy === "neutral") score -= 15;
  // hardfail = full marks

  // DMARC scoring (0-25 points)
  if (!params.dmarcPolicy || params.dmarcPolicy === "none") score -= 25;
  else if (params.dmarcPolicy === "quarantine") score -= 8;
  // reject = full marks

  // MX records (0-10 points)
  if (params.mxCount === 0) score -= 10;

  // Lookalikes (0-20 points)
  if (params.lookalikeCount > 10) score -= 20;
  else if (params.lookalikeCount > 5) score -= 15;
  else if (params.lookalikeCount > 2) score -= 10;
  else if (params.lookalikeCount > 0) score -= 5;

  // Feed mentions (0-20 points)
  if (params.feedMentions > 10) score -= 20;
  else if (params.feedMentions > 5) score -= 15;
  else if (params.feedMentions > 2) score -= 10;
  else if (params.feedMentions > 0) score -= 5;

  return Math.max(0, Math.min(100, score));
}

// ─── Brand Scan Handler (Authenticated) ─────────────────────────

export async function handleBrandScan(request: Request, env: Env, userId?: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { domain?: string };
    const domain = body.domain?.toLowerCase().trim();
    if (!domain || !domain.includes(".")) {
      return json({ success: false, error: "Valid domain required" }, 400, origin);
    }

    const scanId = crypto.randomUUID();
    const startTime = Date.now();

    // Create pending scan
    await env.DB.prepare(
      `INSERT INTO brand_scans (id, domain, status, scanned_by, created_at, updated_at)
       VALUES (?, ?, 'running', ?, datetime('now'), datetime('now'))`
    ).bind(scanId, domain, userId ?? "admin").run();

    // Run checks in parallel
    const [dnsResult, feedResult] = await Promise.all([
      checkDNS(domain),
      crossReferenceFeedData(domain, env.DB),
    ]);

    // Generate and check lookalikes
    const lookalikeDomains = generateLookalikes(domain);
    const lookalikeResults = await checkLookalikeRegistration(lookalikeDomains);
    const registeredLookalikes = lookalikeResults.filter(l => l.registered);

    // Calculate trust score
    const trustScore = calculateBrandTrustScore({
      spfPolicy: dnsResult.spf.policy,
      dmarcPolicy: dnsResult.dmarc.policy,
      dkimFound: false, // DKIM requires selector knowledge
      lookalikeCount: registeredLookalikes.length,
      feedMentions: feedResult.mentions,
      mxCount: dnsResult.mx.length,
    });

    // Build risk factors
    const riskFactors: string[] = [];
    if (!dnsResult.spf.record) riskFactors.push("No SPF record configured");
    else if (dnsResult.spf.policy === "softfail") riskFactors.push("SPF uses ~all (softfail) — should be -all (hardfail)");
    if (!dnsResult.dmarc.record) riskFactors.push("No DMARC record — emails can be spoofed");
    else if (dnsResult.dmarc.policy === "none") riskFactors.push("DMARC policy is 'none' — no enforcement");
    if (dnsResult.mx.length === 0) riskFactors.push("No MX records found");
    if (registeredLookalikes.length > 0) riskFactors.push(`${registeredLookalikes.length} lookalike domains are registered and active`);
    if (feedResult.mentions > 0) riskFactors.push(`${feedResult.mentions} mentions found in threat intelligence feeds`);

    const recommendations: string[] = [];
    if (!dnsResult.spf.record || dnsResult.spf.policy !== "hardfail") recommendations.push("Implement SPF with -all (hardfail) to prevent email spoofing");
    if (!dnsResult.dmarc.record || dnsResult.dmarc.policy !== "reject") recommendations.push("Set DMARC policy to 'reject' for maximum email protection");
    if (registeredLookalikes.length > 0) recommendations.push("Monitor and consider takedown requests for registered lookalike domains");
    if (feedResult.mentions > 0) recommendations.push("Investigate threat feed mentions for active campaigns targeting your brand");

    const durationMs = Date.now() - startTime;

    // Update scan with results
    await env.DB.prepare(`
      UPDATE brand_scans SET
        status = 'completed', trust_score = ?,
        spf_record = ?, spf_policy = ?,
        dmarc_record = ?, dmarc_policy = ?,
        mx_records = ?,
        lookalikes_found = ?, lookalikes = ?,
        feed_mentions = ?, feed_matches = ?,
        risk_factors = ?, recommendations = ?,
        scan_duration_ms = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      trustScore,
      dnsResult.spf.record, dnsResult.spf.policy,
      dnsResult.dmarc.record, dnsResult.dmarc.policy,
      JSON.stringify(dnsResult.mx),
      registeredLookalikes.length, JSON.stringify(registeredLookalikes),
      feedResult.mentions, JSON.stringify(feedResult.matches.slice(0, 20)),
      JSON.stringify(riskFactors), JSON.stringify(recommendations),
      durationMs, scanId,
    ).run();

    // Also record in trust_score_history
    const prevScore = await env.DB.prepare(
      "SELECT score FROM trust_score_history WHERE domain = ? ORDER BY measured_at DESC LIMIT 1"
    ).bind(domain).first<{ score: number }>();

    const delta = prevScore ? trustScore - prevScore.score : 0;
    const riskLevel = trustScore >= 80 ? "low" : trustScore >= 60 ? "medium" : trustScore >= 40 ? "high" : "critical";

    await env.DB.prepare(`
      INSERT INTO trust_score_history (id, domain, score, previous_score, delta, threat_count, risk_level, measured_by, measured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'brand-scan', datetime('now'))
    `).bind(
      crypto.randomUUID(), domain, trustScore,
      prevScore?.score ?? null, delta, feedResult.mentions, riskLevel,
    ).run();

    // Return the full scan result
    const scanResult = {
      id: scanId,
      domain,
      trustScore,
      spf: dnsResult.spf,
      dmarc: dnsResult.dmarc,
      mx: dnsResult.mx,
      lookalikes: registeredLookalikes,
      lookalikeCount: registeredLookalikes.length,
      feedMentions: feedResult.mentions,
      feedMatches: feedResult.matches.slice(0, 10),
      riskFactors,
      recommendations,
      durationMs,
    };

    return json({ success: true, data: scanResult }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Brand Scan History ─────────────────────────────────────────

export async function handleBrandScanHistory(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const domain = url.searchParams.get("domain");
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10));

    let query = `SELECT * FROM brand_scans WHERE status = 'completed'`;
    const params: unknown[] = [];
    if (domain) {
      query += " AND domain = ?";
      params.push(domain);
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = await env.DB.prepare(query).bind(...params).all();

    // Get unique domains scanned
    const domains = await env.DB.prepare(
      "SELECT DISTINCT domain, MAX(created_at) as last_scan, COUNT(*) as scan_count FROM brand_scans WHERE status = 'completed' GROUP BY domain ORDER BY last_scan DESC LIMIT 50"
    ).all();

    return json({
      success: true,
      data: { scans: rows.results, domains: domains.results },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Public Brand Scan (Trust Score Only + Lead Capture) ────────

export async function handlePublicBrandScan(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { domain?: string };
    const domain = body.domain?.toLowerCase().trim();
    if (!domain || !domain.includes(".")) {
      return json({ success: false, error: "Valid domain required" }, 400, origin);
    }

    // Run a lighter-weight scan (DNS only + feed check, no lookalike resolution)
    const [dnsResult, feedResult] = await Promise.all([
      checkDNS(domain),
      crossReferenceFeedData(domain, env.DB),
    ]);

    const lookalikeDomains = generateLookalikes(domain);

    const trustScore = calculateBrandTrustScore({
      spfPolicy: dnsResult.spf.policy,
      dmarcPolicy: dnsResult.dmarc.policy,
      dkimFound: false,
      lookalikeCount: 0, // Don't check registration for public scan
      feedMentions: feedResult.mentions,
      mxCount: dnsResult.mx.length,
    });

    const riskLevel = trustScore >= 80 ? "low" : trustScore >= 60 ? "medium" : trustScore >= 40 ? "high" : "critical";

    // Record in brand_scans
    await env.DB.prepare(
      `INSERT INTO brand_scans (id, domain, status, trust_score, spf_policy, dmarc_policy, feed_mentions, scanned_by, created_at, updated_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?, 'public', datetime('now'), datetime('now'))`
    ).bind(crypto.randomUUID(), domain, trustScore, dnsResult.spf.policy, dnsResult.dmarc.policy, feedResult.mentions).run();

    // Return ONLY the score (not details) for the public endpoint
    return json({
      success: true,
      data: {
        domain,
        trustScore,
        riskLevel,
        lookalikesPossible: lookalikeDomains.length,
        feedMentions: feedResult.mentions > 0, // boolean only
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Public Brand Scan Result Lookup ─────────────────────────────

export async function handlePublicBrandScanResult(request: Request, env: Env, scanId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const row = await env.DB.prepare(
      `SELECT id, domain, trust_score, spf_policy, dmarc_policy, feed_mentions,
              lookalikes_found, status, created_at
       FROM brand_scans WHERE id = ? AND status = 'completed'`
    ).bind(scanId).first();

    if (!row) {
      return json({ success: false, error: "Assessment not found" }, 404, origin);
    }

    const typedRow = row as { trust_score: number };
    const score = typedRow.trust_score;
    const riskLevel = score >= 80 ? "low" : score >= 60 ? "medium" : score >= 40 ? "high" : "critical";

    return json({
      success: true,
      data: { ...row, risk_level: riskLevel },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Lead Capture ──────────────────────────────────────────────

export async function handleLeadCapture(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as {
      name?: string; email?: string; domain?: string; phone?: string;
      company?: string; message?: string;
    };

    if (!body.email || !body.name) {
      return json({ success: false, error: "Name and email are required" }, 400, origin);
    }

    // Business-email gate — mirrors the in-page check so a direct POST
    // can't slip a personal/free address past the client validation.
    if (!body.email.includes("@") || !body.email.split("@")[1]?.includes(".")) {
      return json({ success: false, error: "Please enter a valid email address" }, 400, origin);
    }
    if (isFreemailEmail(body.email)) {
      return json({ success: false, error: "Please use a business email address (no free email providers)" }, 400, origin);
    }

    const id = crypto.randomUUID();

    // Brand correlation: if a brands row already exists for this domain,
    // attach its id to the lead so sales can see "this prospect is asking
    // about a brand we already monitor" without a JOIN at read time.
    // Column is nullable so platforms scanning brand-new domains still
    // capture cleanly.
    let correlatedBrandId: string | null = null;
    if (body.domain) {
      const dom = body.domain.toLowerCase().trim();
      const existing = await env.DB.prepare(
        "SELECT id FROM brands WHERE canonical_domain = ?",
      ).bind(dom).first<{ id: string }>();
      if (existing) correlatedBrandId = existing.id;
    }

    await env.DB.prepare(`
      INSERT INTO scan_leads (id, email, name, company, phone, domain, form_type, source, message, status, correlated_brand_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'brand_scan', 'public_scan', ?, 'new', ?, datetime('now'), datetime('now'))
    `).bind(
      id, body.email, body.name, body.company ?? null,
      body.phone ?? null, body.domain ?? null, body.message ?? null,
      correlatedBrandId,
    ).run();

    // Fire-and-forget side effects. All wrapped so the prospect's
    // submission isn't impacted by a downstream hiccup (the lead row is
    // already committed). Logged on failure (lib/logger).
    //   1. Internal alert email to sales@averrow.com.
    //   2. Prospect-facing acknowledgement — the scan-results page tells
    //      the visitor "check your inbox" the instant they submit, so we
    //      owe them an actual email. The full report is still delivered by
    //      sales; this confirms receipt and sets that expectation.
    //   3. In-app notification (audience 'team') so the lead surfaces in
    //      the platform notification bell for sales/support/admins — not
    //      only in the sales@ inbox. group_key is per-lead so distinct
    //      leads never dedup against each other.
    try {
      const [{ notifySalesOfNewLead, sendScanReportAcknowledgement }, { createNotification }] =
        await Promise.all([
          import("../lib/scan-lead-notify"),
          import("../lib/notifications"),
        ]);
      const url = new URL(request.url);
      const leadLabel = body.name?.trim() || body.email;
      const scannedDomain = body.domain?.trim() || "their domain";
      await Promise.allSettled([
        notifySalesOfNewLead(env, {
          leadId: id,
          email: body.email,
          name: body.name ?? null,
          company: body.company ?? null,
          domain: body.domain ?? null,
          phone: body.phone ?? null,
          message: body.message ?? null,
          correlatedBrandId,
          adminUrlBase: url.origin,
        }),
        sendScanReportAcknowledgement(env, {
          email: body.email,
          name: body.name ?? null,
          domain: body.domain ?? null,
        }),
        createNotification(env, {
          type: "new_lead",
          audience: "team",
          severity: "low",
          title: `New lead — ${leadLabel}`,
          message: `${leadLabel} scanned ${scannedDomain}${body.company ? ` (${body.company})` : ""} and requested the full report.`,
          // Basename-relative (SPA mounts at /v2) and deep-links straight
          // to this lead's drill-down. group_key is per-lead so distinct
          // leads never dedup against each other.
          link: `/leads?view=scan&lead=${id}`,
          groupKey: `new_lead:${id}`,
          reasonText: "A visitor submitted the public domain-scan lead form.",
          recommendedAction: "Review the lead and generate a qualified report or reach out.",
          metadata: {
            lead_id: id,
            email: body.email,
            domain: body.domain ?? null,
            company: body.company ?? null,
            correlated_brand_id: correlatedBrandId,
          },
        }),
      ]);
    } catch { /* swallow — lead capture is the priority */ }

    return json({ success: true, data: { id, message: "Thank you! Our team will contact you shortly." } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Admin Leads List ──────────────────────────────────────────

export async function handleListLeads(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));

    let query = "SELECT * FROM scan_leads";
    const params: unknown[] = [];
    if (status) {
      query += " WHERE status = ?";
      params.push(status);
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = await env.DB.prepare(query).bind(...params).all();

    const stats = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_leads,
        SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
        SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) as qualified,
        SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted
      FROM scan_leads
    `).first();

    return json({ success: true, data: { leads: rows.results, stats } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleUpdateLead(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { status?: string; notes?: string };
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.status) { updates.push("status = ?"); values.push(body.status); }
    if (body.notes) { updates.push("notes = ?"); values.push(body.notes); }
    if (updates.length === 0) return json({ success: false, error: "No updates" }, 400, origin);

    updates.push("updated_at = datetime('now')");
    if (body.status === "converted") updates.push("converted_at = datetime('now')");
    values.push(id);

    await env.DB.prepare(`UPDATE scan_leads SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Lead drill-down — single lead + live customer intel ──────────
//
// Powers the Scan Leads detail view (the "New lead" notification deep-
// links here). Returns the scan_leads row plus a lightweight intel
// snapshot for the lead's domain: active-threat posture, email security
// grade, top hosting infrastructure, lookalike count, the correlated
// brand (for linking into /brands/:id), and any qualified report already
// generated for this lead. The heavier AI-narrated report stays behind
// POST .../qualified-report.
//
// Two robustness rules, learned from the first cut:
//   1. The lead lookup (indexed PK read) is fast and ALWAYS returns the
//      lead when it exists. Intel aggregation is best-effort — wrapped so
//      a slow/failing scan returns `intel: null` instead of turning a
//      real lead into a "Lead not found" 500.
//   2. Threat aggregation is scoped by `target_brand_id` (hits
//      idx_threats_brand_status / idx_threats_brand_created), never by a
//      leading-wildcard `malicious_domain LIKE '%.domain'`, which is an
//      unindexable full scan of the 113K-row threats table (~10s) — the
//      original cause of the slow-then-404.

interface LeadIntel {
  domain: string;
  threats: {
    active_total: number;
    by_severity: Record<string, number>;
    samples: Array<{
      id: string; threat_type: string; severity: string | null; source_feed: string;
      malicious_domain: string | null; ip_address: string | null; country_code: string | null; first_seen: string;
    }>;
  };
  email_security: { grade: string | null; spf: string | null; dmarc: string | null; mx_count: number } | null;
  top_providers: Array<{ name: string; asn: string | null; threat_count: number }>;
  top_countries: Array<{ country: string; threat_count: number }>;
  lookalikes_count: number;
  correlated_brand: { id: string; name: string } | null;
  latest_report: { share_token: string; risk_grade: string | null; created_at: string; expires_at: string } | null;
  // "Have we seen this domain before?" — efficient, indexed history so the
  // drill-down can say what the platform already knows about the brand.
  platform_history: {
    known_brand: {
      id: string;
      name: string;
      sector: string | null;
      threat_count_all_time: number;
      first_seen: string;
    } | null;
    prior_assessment: { grade: string | null; trust_score: number | null; assessed_at: string } | null;
  };
}

async function buildLeadIntel(
  env: Env,
  leadId: string,
  domain: string,
  correlatedBrandId: string | null,
): Promise<LeadIntel> {
  const keyword = domain.split(".")[0] ?? domain;

  // Resolve the brand once (indexed: PK or idx_brands_domain). All threat
  // aggregation below is scoped by target_brand_id so it rides
  // idx_threats_brand_status / idx_threats_brand_created instead of a
  // full-table scan. NOTE: spf/dmarc/mx are NOT columns on `brands` — they
  // live on email_security_scans — so they are fetched separately below.
  const brand = await (correlatedBrandId
    ? env.DB.prepare(
        `SELECT id, name, sector, email_security_grade, threat_count, first_seen
           FROM brands WHERE id = ? LIMIT 1`,
      ).bind(correlatedBrandId)
    : env.DB.prepare(
        `SELECT id, name, sector, email_security_grade, threat_count, first_seen
           FROM brands WHERE canonical_domain = ? LIMIT 1`,
      ).bind(domain)
  ).first<{
    id: string; name: string; sector: string | null;
    email_security_grade: string | null; threat_count: number | null; first_seen: string;
  }>();

  const brandId = brand?.id ?? null;

  let severityResults: Array<{ severity: string | null; n: number }> = [];
  let providerResults: Array<{ name: string; asn: string | null; threat_count: number }> = [];
  let countryResults: Array<{ country: string; threat_count: number }> = [];
  let sampleResults: LeadIntel["threats"]["samples"] = [];

  if (brandId) {
    const [sev, prov, ctry, samp] = await Promise.all([
      env.DB.prepare(
        `SELECT severity, COUNT(*) AS n FROM threats
          WHERE target_brand_id = ? AND status = 'active' GROUP BY severity`,
      ).bind(brandId).all<{ severity: string | null; n: number }>(),
      env.DB.prepare(
        `SELECT hp.name, hp.asn, COUNT(*) AS threat_count
           FROM threats t JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
          WHERE t.target_brand_id = ? AND t.status = 'active'
          GROUP BY hp.id ORDER BY threat_count DESC LIMIT 5`,
      ).bind(brandId).all<{ name: string; asn: string | null; threat_count: number }>(),
      env.DB.prepare(
        `SELECT country_code AS country, COUNT(*) AS threat_count FROM threats
          WHERE target_brand_id = ? AND status = 'active' AND country_code IS NOT NULL
          GROUP BY country_code ORDER BY threat_count DESC LIMIT 5`,
      ).bind(brandId).all<{ country: string; threat_count: number }>(),
      env.DB.prepare(
        `SELECT id, threat_type, severity, source_feed, malicious_domain, ip_address, country_code, created_at AS first_seen
           FROM threats
          WHERE target_brand_id = ? AND status = 'active'
          ORDER BY created_at DESC LIMIT 8`,
      ).bind(brandId).all<LeadIntel["threats"]["samples"][number]>(),
    ]);
    severityResults = sev.results;
    providerResults = prov.results;
    countryResults = ctry.results;
    sampleResults = samp.results;
  }

  // All bounded/indexed reads:
  //  - email_security_scans by domain (idx_ess_domain, migration 0216)
  //  - lookalike_domains by keyword (small table)
  //  - assessments by domain (idx_assessments_domain)
  //  - qualified_reports by lead_id
  const [emailScan, lookalikes, priorAssessment, latestReport] = await Promise.all([
    env.DB.prepare(
      `SELECT spf_policy, dmarc_policy, mx_exists, mx_providers, email_security_grade
         FROM email_security_scans WHERE domain = ?
        ORDER BY scanned_at DESC LIMIT 1`,
    ).bind(domain).first<{
      spf_policy: string | null; dmarc_policy: string | null;
      mx_exists: number | null; mx_providers: string | null; email_security_grade: string | null;
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains WHERE target_brand LIKE ?`,
    ).bind(`%${keyword}%`).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT trust_score, grade, completed_at FROM assessments
        WHERE domain = ? AND completed_at IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1`,
    ).bind(domain).first<{ trust_score: number | null; grade: string | null; completed_at: string }>(),
    env.DB.prepare(
      `SELECT share_token, payload_json, created_at, expires_at
         FROM qualified_reports WHERE lead_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(leadId).first<{ share_token: string; payload_json: string; created_at: string; expires_at: string }>(),
  ]);

  const bySeverity: Record<string, number> = {};
  let activeTotal = 0;
  for (const row of severityResults) {
    const sev = row.severity ?? "unknown";
    bySeverity[sev] = row.n;
    activeTotal += row.n;
  }

  let report: LeadIntel["latest_report"] = null;
  if (latestReport) {
    let riskGrade: string | null = null;
    try {
      const payload = JSON.parse(latestReport.payload_json) as { executive_summary?: { risk_grade?: string } };
      riskGrade = payload.executive_summary?.risk_grade ?? null;
    } catch { /* malformed payload — leave grade null */ }
    report = {
      share_token: latestReport.share_token,
      risk_grade: riskGrade,
      created_at: latestReport.created_at,
      expires_at: latestReport.expires_at,
    };
  }

  // Email security: grade from the brand row (cheap, already loaded);
  // SPF/DMARC/MX detail from the latest scan. mx_count is derived from the
  // provider list since the scan stores providers, not a count.
  const grade = brand?.email_security_grade ?? emailScan?.email_security_grade ?? null;
  let emailSecurity: LeadIntel["email_security"] = null;
  if (grade != null || emailScan) {
    const mxCount = emailScan?.mx_providers
      ? emailScan.mx_providers.split(",").filter((s) => s.trim()).length
      : (emailScan?.mx_exists ? 1 : 0);
    emailSecurity = {
      grade,
      spf: emailScan?.spf_policy ?? null,
      dmarc: emailScan?.dmarc_policy ?? null,
      mx_count: mxCount,
    };
  }

  return {
    domain,
    threats: { active_total: activeTotal, by_severity: bySeverity, samples: sampleResults },
    email_security: emailSecurity,
    top_providers: providerResults,
    top_countries: countryResults,
    lookalikes_count: lookalikes?.n ?? 0,
    correlated_brand: brand ? { id: brand.id, name: brand.name } : null,
    latest_report: report,
    platform_history: {
      known_brand: brand
        ? {
            id: brand.id,
            name: brand.name,
            sector: brand.sector,
            threat_count_all_time: brand.threat_count ?? 0,
            first_seen: brand.first_seen,
          }
        : null,
      prior_assessment: priorAssessment
        ? { grade: priorAssessment.grade, trust_score: priorAssessment.trust_score, assessed_at: priorAssessment.completed_at }
        : null,
    },
  };
}

export async function handleGetLead(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const lead = await env.DB.prepare(
      `SELECT id, email, name, company, phone, domain, form_type, source, message,
              status, notes, correlated_brand_id, correlated_sales_lead_id,
              outreach_sent_at, outreach_email_id,
              converted_org_id, converted_at, created_at, updated_at
         FROM scan_leads WHERE id = ?`,
    ).bind(id).first<Record<string, unknown> & { domain: string | null; correlated_brand_id: string | null; correlated_sales_lead_id: string | null }>();

    if (!lead) return json({ success: false, error: "Lead not found" }, 404, origin);

    const domain = lead.domain ? lead.domain.toLowerCase().trim() : null;

    // Intel is best-effort — a slow or failing aggregation must never turn
    // a real lead into a 404. The lead row above is the source of truth
    // for "found"; intel rides along when it succeeds.
    let intel: LeadIntel | null = null;
    if (domain) {
      try {
        intel = await buildLeadIntel(env, id, domain, lead.correlated_brand_id);
      } catch {
        intel = null;
      }
    }

    // Cross-pipeline link (B5): surface any outbound Pathfinder-researched
    // prospect for the same company so a rep sees "we already researched
    // this". Matched by domain ↔ sales_leads.company_domain. Best-effort:
    // a failure here must not drop the lead. Opportunistically cache the
    // link on the row when first discovered.
    let correlatedSalesLead: Record<string, unknown> | null = null;
    if (domain) {
      try {
        correlatedSalesLead = await env.DB.prepare(
          `SELECT id, company_name, status, prospect_score, pitch_angle, created_at
             FROM sales_leads WHERE lower(company_domain) = ?
             ORDER BY created_at DESC LIMIT 1`,
        ).bind(domain).first<Record<string, unknown>>();
        if (correlatedSalesLead && lead.correlated_sales_lead_id == null) {
          await env.DB.prepare(
            `UPDATE scan_leads SET correlated_sales_lead_id = ?
               WHERE id = ? AND correlated_sales_lead_id IS NULL`,
          ).bind(correlatedSalesLead["id"] as string, id).run();
        }
      } catch { correlatedSalesLead = null; }
    }

    return json({ success: true, data: { lead, intel, correlated_sales_lead: correlatedSalesLead } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
