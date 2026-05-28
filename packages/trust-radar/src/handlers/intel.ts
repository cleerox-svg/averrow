// TODO: Refactor to use handler-utils (Phase 6 continuation)
//
// WS-B cull (2026-05-28): removed 5 phantom handlers — handleListBreaches,
// handleListATOEvents, handleUpdateATOEvent, handleListEmailAuth,
// handleListCloudIncidents. The endpoints + Navigator pre-warm shipped
// but no producer ever did, so the tables (breach_checks, ato_events,
// email_auth_reports, cloud_incidents) were always empty. Routes,
// imports, and Navigator phase-C pre-warm calls all dropped in the same
// commit. Tables themselves are kept (schemas remain) in case a real
// producer ships in the future.
import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import type { Env } from "../types";

// ─── Trust Score History ────────────────────────────────────────

export async function handleTrustScoreHistory(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const domain = url.searchParams.get("domain");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "30", 10));

    let query = "SELECT id, domain, score, previous_score, delta, risk_level, measured_at, created_at FROM trust_score_history";
    const params: unknown[] = [];
    if (domain) { query += " WHERE domain = ?"; params.push(domain); }
    query += " ORDER BY measured_at DESC LIMIT ?";
    params.push(limit);

    const rows = await env.DB.prepare(query).bind(...params).all();
    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Intel Hotlist (PR-A from 2026-05-16 audit) ────────────────
//
// GET /api/intel/hotlist
//
// Surfaces three classes of high-signal intel that already exist
// in `threats` but were never shown in the UI:
//
//  1. top_fanout_ips      — IPs hosting threats against many
//                           distinct brands. Mass-impersonation
//                           infrastructure that wasn't getting
//                           consolidated as a campaign.
//                           (audit example: 76.223.54.146 → 597 brands)
//  2. multi_feed_consensus — IPs flagged by ≥4 independent feeds.
//                           Currently confidence_score is flat
//                           regardless of corroboration count.
//                           These are the highest-confidence IOCs
//                           in the corpus and we don't surface them.
//  3. recent_bursts        — Domain swarms targeting one brand in
//                           a tight time window. Detection rule
//                           from the audit:
//                             COUNT(*) ≥ 25 same brand in 1 hour
//                           (audit example: 786 domains targeting
//                           one brand in 14 min, zero campaign formed)
//
// KV-cached 5min — operators want freshness but we don't need
// per-second resolution; the underlying GROUP BYs are bounded
// scans against indexes on (ip_address, target_brand_id,
// source_feed, first_seen).
export async function handleIntelHotlist(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get("limit") ?? "10", 10)));

    const cacheKey = `intel:hotlist:v1:${limit}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);

    const [fanoutRes, consensusRes, burstsRes] = await Promise.all([
      // 1. IPs hosting threats against the most distinct brands.
      // Active-only — taken-down/resolved threats don't count.
      // Exclude empty/placeholder IPs (Sentinel writes '0.0.0.0' on
      // DNS failures; audit-flagged for cleanup).
      env.DB.prepare(`
        SELECT ip_address,
               COUNT(DISTINCT target_brand_id) AS brand_count,
               COUNT(*)                         AS threat_count,
               MAX(first_seen)                  AS last_seen
          FROM threats
         WHERE status = 'active'
           AND ip_address IS NOT NULL
           AND ip_address NOT IN ('', '0.0.0.0')
           AND target_brand_id IS NOT NULL
         GROUP BY ip_address
        HAVING brand_count >= 5
         ORDER BY brand_count DESC, threat_count DESC
         LIMIT ?
      `).bind(limit).all<{
        ip_address: string;
        brand_count: number;
        threat_count: number;
        last_seen: string;
      }>(),
      // 2. Multi-feed-corroborated IPs. ≥4 distinct source_feed
      // means the IP is flagged by independent intelligence
      // sources — far higher confidence than a single feed.
      env.DB.prepare(`
        SELECT ip_address,
               COUNT(DISTINCT source_feed) AS feed_count,
               COUNT(*)                     AS threat_count,
               GROUP_CONCAT(DISTINCT source_feed) AS feeds,
               MAX(first_seen)              AS last_seen
          FROM threats
         WHERE status = 'active'
           AND ip_address IS NOT NULL
           AND ip_address NOT IN ('', '0.0.0.0')
         GROUP BY ip_address
        HAVING feed_count >= 4
         ORDER BY feed_count DESC, threat_count DESC
         LIMIT ?
      `).bind(limit).all<{
        ip_address: string;
        feed_count: number;
        threat_count: number;
        feeds: string;
        last_seen: string;
      }>(),
      // 3. Recent temporal bursts — same brand, ≥25 threats in 1h.
      // Window is the last 24h to keep operator-relevant; cube
      // would be more efficient but cubes aggregate to the hour
      // boundary, masking sub-hour swarms. Direct first_seen
      // grouping gives true burst detection.
      env.DB.prepare(`
        SELECT target_brand_id                              AS brand_id,
               strftime('%Y-%m-%d %H:00', first_seen)       AS hour_bucket,
               COUNT(*)                                      AS threat_count,
               COUNT(DISTINCT malicious_domain)              AS distinct_domains,
               MIN(first_seen)                               AS burst_start,
               MAX(first_seen)                               AS burst_end
          FROM threats
         WHERE status = 'active'
           AND first_seen >= datetime('now', '-24 hours')
           AND target_brand_id IS NOT NULL
         GROUP BY brand_id, hour_bucket
        HAVING threat_count >= 25
         ORDER BY threat_count DESC
         LIMIT ?
      `).bind(limit).all<{
        brand_id: string;
        hour_bucket: string;
        threat_count: number;
        distinct_domains: number;
        burst_start: string;
        burst_end: string;
      }>(),
    ]);

    // Resolve brand_id → name + canonical_domain + logo_url for the
    // bursts payload so the UI can render the same favicon treatment
    // as BrandMovers without an extra round-trip. Batched into one
    // IN().
    const burstBrandIds = Array.from(new Set((burstsRes.results ?? []).map(b => b.brand_id))).filter(Boolean);
    interface BurstBrand {
      name: string;
      canonical_domain: string | null;
      logo_url: string | null;
    }
    let brandById = new Map<string, BurstBrand>();
    if (burstBrandIds.length > 0) {
      const placeholders = burstBrandIds.map(() => '?').join(',');
      const brandRows = await env.DB.prepare(
        `SELECT id, name, canonical_domain, logo_url FROM brands WHERE id IN (${placeholders})`,
      ).bind(...burstBrandIds).all<{
        id: string;
        name: string;
        canonical_domain: string | null;
        logo_url: string | null;
      }>();
      brandById = new Map(
        brandRows.results.map(r => [r.id, {
          name: r.name,
          canonical_domain: r.canonical_domain,
          logo_url: r.logo_url,
        }]),
      );
    }
    const bursts = (burstsRes.results ?? []).map(b => {
      const brand = brandById.get(b.brand_id);
      return {
        brand_id:         b.brand_id,
        brand_name:       brand?.name ?? b.brand_id,
        brand_domain:     brand?.canonical_domain ?? null,
        brand_logo_url:   brand?.logo_url ?? null,
        hour_bucket:      b.hour_bucket,
        threat_count:     b.threat_count,
        distinct_domains: b.distinct_domains,
        burst_start:      b.burst_start,
        burst_end:        b.burst_end,
      };
    });

    const body = {
      success: true,
      data: {
        top_fanout_ips:        fanoutRes.results ?? [],
        multi_feed_consensus:  consensusRes.results ?? [],
        recent_bursts:         bursts,
        generated_at:          new Date().toISOString(),
      },
    };
    // Cost-sweep 2026-05-16: was 5min TTL → 1,800 D1 calls/24h
    // × 235K rows/call for the GROUP BY fan-out scan = ~6M reads/day
    // burned on Home-page Hotlist refreshes. The data doesn't shift
    // meaningfully on a 5-min cadence (top-fan-out IPs and burst
    // patterns are hour-scale signals) — 30min TTL cuts the burn ~6×
    // without operator-noticeable staleness.
    await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 1800 });
    return json(body, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Critical Intel Banner ─────────────────────────────────────
//
// GET /api/intel/critical-banner
//
// Powers the red "Critical Intelligence" banner on Home. Replaces
// the bare `alertStats.critical` count which conflated severity
// (242 critical-by-rule alerts) with operator concern (3 open
// alerts in the triage queue). The audit (2026-05-16) found those
// two numbers diverging visibly across Home tiles.
//
// New treatment: surface the SINGLE most-urgent business-level
// event right now, with a precise drill-down link instead of the
// generic /alerts dump. Sources ranked by impact:
//
//   1. Provider surge  — most recent platform_provider_escalation
//      notification fired in last 24h (Cloudflare 17× spike, etc.)
//   2. Recent burst    — same brand + ≥25 threats in 1h, last 24h
//   3. Mass-impersonation IP — `cluster_ip_*` cluster created in
//      last 24h with brand_count ≥ 100 (PR-D auto-clusterer)
//   4. New campaign    — `campaigns` row with first_seen in last
//      24h AND threat_count ≥ 50
//   5. Open critical alerts — `alerts WHERE severity='critical'
//      AND status='new'` count (fallback path; matches what
//      operators actually triage)
//
// KV-cached 60s — operators want freshness but the underlying
// queries are bounded scans.
export async function handleIntelCriticalBanner(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const cacheKey = "intel:critical-banner:v1";
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);

    const events: Array<{
      kind: string;
      title: string;
      subtitle: string;
      link: string;
      severity: "critical" | "high" | "medium";
      ts: string;
    }> = [];

    // 1. Provider surge — read the most recent
    // platform_provider_escalation notification. FlightControl
    // emits these with 24h dedup, so each row is a fresh surge
    // worth surfacing.
    try {
      const surge = await env.DB.prepare(`
        SELECT id, title, message, severity, link, created_at
          FROM notifications
         WHERE type = 'platform_provider_escalation'
           AND created_at >= datetime('now', '-24 hours')
         ORDER BY created_at DESC
         LIMIT 1
      `).first<{
        id: string;
        title: string;
        message: string;
        severity: string;
        link: string | null;
        created_at: string;
      }>();
      if (surge) {
        events.push({
          kind: "provider_surge",
          title: surge.title,
          subtitle: surge.message,
          link: surge.link ?? "/providers",
          severity: (surge.severity === "critical" ? "critical" : "high"),
          ts: surge.created_at,
        });
      }
    } catch { /* notifications table missing — skip */ }

    // 2. Recent temporal burst — same brand + ≥25 threats in 1h.
    try {
      const burst = await env.DB.prepare(`
        SELECT target_brand_id                          AS brand_id,
               strftime('%Y-%m-%d %H:00', first_seen)   AS hour_bucket,
               COUNT(*)                                  AS threat_count,
               COUNT(DISTINCT malicious_domain)          AS distinct_domains
          FROM threats
         WHERE status = 'active'
           AND first_seen >= datetime('now', '-24 hours')
           AND target_brand_id IS NOT NULL
         GROUP BY brand_id, hour_bucket
        HAVING threat_count >= 25
         ORDER BY threat_count DESC
         LIMIT 1
      `).first<{
        brand_id: string;
        hour_bucket: string;
        threat_count: number;
        distinct_domains: number;
      }>();
      if (burst) {
        const brand = await env.DB.prepare(
          `SELECT name FROM brands WHERE id = ? LIMIT 1`,
        ).bind(burst.brand_id).first<{ name: string }>();
        const brandName = brand?.name ?? burst.brand_id;
        events.push({
          kind: "burst",
          title: `Burst: ${brandName}`,
          subtitle:
            `${burst.threat_count} threats / ${burst.distinct_domains} domains in 1h window (${burst.hour_bucket})`,
          link: `/brands/${encodeURIComponent(burst.brand_id)}`,
          severity: "critical",
          ts: burst.hour_bucket,
        });
      }
    } catch { /* skip */ }

    // 3. New mass-impersonation IP cluster (PR-D fan-out clusters).
    try {
      const massImp = await env.DB.prepare(`
        SELECT id, cluster_name, brand_ids, threat_count, first_detected
          FROM infrastructure_clusters
         WHERE id LIKE 'cluster_ip_%'
           AND first_detected >= datetime('now', '-24 hours')
         ORDER BY threat_count DESC
         LIMIT 1
      `).first<{
        id: string;
        cluster_name: string | null;
        brand_ids: string | null;
        threat_count: number;
        first_detected: string;
      }>();
      if (massImp) {
        let brandCount = 0;
        try {
          const parsed = massImp.brand_ids ? JSON.parse(massImp.brand_ids) : [];
          brandCount = Array.isArray(parsed) ? parsed.length : 0;
        } catch { /* malformed JSON — leave at 0 */ }
        if (brandCount >= 100) {
          events.push({
            kind: "mass_impersonation_ip",
            title: massImp.cluster_name ?? "Mass-impersonation infrastructure",
            subtitle: `${brandCount} brands targeted from one IP — ${massImp.threat_count.toLocaleString()} active threats`,
            link: `/operations/${encodeURIComponent(massImp.id)}`,
            severity: "high",
            ts: massImp.first_detected,
          });
        }
      }
    } catch { /* skip */ }

    // 4. New high-volume campaign in last 24h.
    try {
      const camp = await env.DB.prepare(`
        SELECT id, name, threat_count, brand_count, first_seen
          FROM campaigns
         WHERE first_seen >= datetime('now', '-24 hours')
           AND threat_count >= 50
           AND status = 'active'
         ORDER BY threat_count DESC
         LIMIT 1
      `).first<{
        id: string;
        name: string;
        threat_count: number;
        brand_count: number;
        first_seen: string;
      }>();
      if (camp) {
        events.push({
          kind: "new_campaign",
          title: `New campaign: ${camp.name}`,
          subtitle:
            `${camp.threat_count.toLocaleString()} threats across ${camp.brand_count} brand${camp.brand_count === 1 ? "" : "s"} in 24h`,
          link: `/campaigns/${encodeURIComponent(camp.id)}`,
          severity: "high",
          ts: camp.first_seen,
        });
      }
    } catch { /* skip */ }

    // 5. Fallback: open critical alerts the operator hasn't triaged.
    // Only surface this when nothing else is critical — operators
    // care more about new dangers than the open-queue depth.
    if (events.length === 0) {
      try {
        const openCrit = await env.DB.prepare(`
          SELECT COUNT(*) AS n
            FROM alerts
           WHERE severity = 'critical'
             AND status = 'new'
        `).first<{ n: number }>();
        const n = openCrit?.n ?? 0;
        if (n > 0) {
          events.push({
            kind: "open_critical_alerts",
            title: `${n} open critical alert${n === 1 ? "" : "s"}`,
            subtitle: "Critical-severity alerts awaiting triage.",
            link: "/alerts?severity=critical&status=new",
            severity: "critical",
            ts: new Date().toISOString(),
          });
        }
      } catch { /* skip */ }
    }

    const body = {
      success: true,
      data: {
        events: events.slice(0, 3),
        total: events.length,
        generated_at: new Date().toISOString(),
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });
    return json(body, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}

