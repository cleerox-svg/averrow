/**
 * Enrichment Pipeline Orchestrator — Runs after feed ingestion.
 *
 * Pipeline stages:
 * 1. DNS resolution: domain → IP (for threats missing ip_address)
 * 2. GeoIP + ASN: IP → country, ASN, hosting provider (brand matches first)
 * 3. WHOIS/RDAP: domain → registrar (for high-severity threats)
 * 4. Brand auto-detection: domain → target_brand_id
 * 5. Provider count sync: update hosting_providers.active_threat_count
 *
 * Budget: 5 geo lookups per cycle, 10 DNS lookups per cycle.
 * Designed to be idempotent — can safely re-run without duplicating work.
 */

import type { Env } from "../types";
import { batchResolve } from "./dns";
import { batchGeoLookup, normalizeProvider, upsertHostingProvider, isPrivateIP, getGeoUsage, PRIVATE_IP_SQL_FILTER } from "./geoip";
import { batchRDAPLookup } from "./whois";
import { enrichBrands } from "./brandDetect";
import { cachedCount } from "./cached-count";

export interface EnrichmentResult {
  dnsResolved: number;
  geoEnriched: number;
  domainRanksChecked: number;
  whoisEnriched: number;
  brandsMatched: number;
  providersUpserted: number;
  providerCountsUpdated: number;
  brandActiveCountsUpdated: number;
  /** PR-D (2026-05-16 audit): threats whose confidence_score was
   *  boosted because their IP is corroborated by ≥4 distinct feeds.
   *  Was zero coverage pre-fix — confidence stayed flat regardless
   *  of how many independent feeds flagged an IP. */
  corroborationBoosted: number;
}

/**
 * Run the full enrichment pipeline on unenriched threats.
 */
export async function runEnrichmentPipeline(env: Env): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    dnsResolved: 0,
    geoEnriched: 0,
    domainRanksChecked: 0,
    whoisEnriched: 0,
    brandsMatched: 0,
    providersUpserted: 0,
    providerCountsUpdated: 0,
    brandActiveCountsUpdated: 0,
    corroborationBoosted: 0,
  };

  // Diagnostic counts (cost-sweep 2026-05-16): the 5 inline COUNT(*)
  // subqueries were running once per enrichment cycle uncached,
  // burning ~15M reads / 11 calls = 1.4M reads/call (4 full table
  // scans + 1 PK count). Wrapped in cachedCount with a 60-min TTL:
  // these are operator-visibility counters, not gating logic, so
  // hour-stale is fine.
  const [needs_dns, needs_geo, needs_whois, needs_brand, total] = await Promise.all([
    cachedCount(env, 'count.enrich.needs_dns', 3600, async () => {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM threats WHERE malicious_domain IS NOT NULL AND ip_address IS NULL`,
      ).first<{ n: number }>();
      return r?.n ?? 0;
    }),
    cachedCount(env, 'count.enrich.needs_geo', 3600, async () => {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM threats WHERE ip_address IS NOT NULL AND (country_code IS NULL OR asn IS NULL OR hosting_provider_id IS NULL OR lat IS NULL)`,
      ).first<{ n: number }>();
      return r?.n ?? 0;
    }),
    cachedCount(env, 'count.enrich.needs_whois', 3600, async () => {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM threats WHERE malicious_domain IS NOT NULL AND registrar IS NULL AND severity IN ('critical', 'high')`,
      ).first<{ n: number }>();
      return r?.n ?? 0;
    }),
    cachedCount(env, 'count.enrich.needs_brand', 3600, async () => {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NULL AND malicious_domain IS NOT NULL`,
      ).first<{ n: number }>();
      return r?.n ?? 0;
    }),
    cachedCount(env, 'count.threats.total', 3600, async () => {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM threats`).first<{ n: number }>();
      return r?.n ?? 0;
    }),
  ]);
  const counts = { needs_dns, needs_geo, needs_whois, needs_brand, total };

  // Write diagnostic agent_output every run for visibility
  try {
    await env.DB.prepare(
      `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at)
       VALUES (?, 'enrichment', 'diagnostic', ?, 'info', ?, datetime('now'))`,
    ).bind(
      crypto.randomUUID(),
      `Enrichment pipeline started: dns=${counts?.needs_dns}, geo=${counts?.needs_geo}, whois=${counts?.needs_whois}, brand=${counts?.needs_brand}`,
      JSON.stringify({
        needs_dns: counts?.needs_dns,
        needs_geo: counts?.needs_geo,
        needs_whois: counts?.needs_whois,
        needs_brand: counts?.needs_brand,
        total: counts?.total,
      }),
    ).run();
  } catch { /* non-fatal */ }

  // Log monthly geo usage
  try {
    await getGeoUsage(env.CACHE);
  } catch { /* non-fatal */ }

  // ─── Stage 1: DNS Resolution ──────────────────────────────────
  // Resolve threats that have a domain but no IP (10 per cycle)
  const needsDns = await env.DB.prepare(
    `SELECT id, malicious_domain FROM threats
     WHERE malicious_domain IS NOT NULL AND ip_address IS NULL
     LIMIT 10`,
  ).all<{ id: string; malicious_domain: string }>();

  if (needsDns.results.length > 0) {
    const domains = needsDns.results.map((r) => r.malicious_domain);
    try {
      const dnsMap = await batchResolve(domains);

      for (const row of needsDns.results) {
        const ip = dnsMap.get(row.malicious_domain);
        if (!ip) continue;
        // Skip storing private IPs — they can't be geo-enriched
        if (isPrivateIP(ip)) {
          continue;
        }
        try {
          await env.DB.prepare(
            "UPDATE threats SET ip_address = ? WHERE id = ? AND ip_address IS NULL",
          ).bind(ip, row.id).run();
          result.dnsResolved++;
        } catch (err) {
          console.error(`[enrich] DNS update failed for ${row.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[enrich] Stage 1 DNS batch resolve failed:", err);
    }
  }

  // ─── Stage 2: GeoIP + ASN + Hosting Provider ─────────────────
  // Select threats needing geo: missing country_code OR asn OR hosting_provider_id OR lat
  // Prioritize brand-matched threats first (most valuable for map/brand views)
  const needsGeoRows = await env.DB.prepare(
    `SELECT id, ip_address, target_brand_id FROM threats
     WHERE ip_address IS NOT NULL
       AND (country_code IS NULL OR asn IS NULL OR hosting_provider_id IS NULL OR lat IS NULL)
       ${PRIVATE_IP_SQL_FILTER}
     ORDER BY CASE WHEN target_brand_id IS NOT NULL THEN 0 ELSE 1 END, created_at DESC
     LIMIT 100`,
  ).all<{ id: string; ip_address: string; target_brand_id: string | null }>();

  const needsGeo = needsGeoRows.results;
  const brandedCount = needsGeo.filter(r => r.target_brand_id).length;
  if (needsGeo.length > 0) {
    const ips = needsGeo.map((r) => r.ip_address);

    try {
      const { results: geoMap } = await batchGeoLookup(ips, env.CACHE, env.IPINFO_TOKEN);

      if (geoMap.size === 0 && ips.length > 0) {
        console.error("[enrich] WARNING: GeoIP returned 0 results — ipinfo.io may be rate limiting or blocking");
        try {
          await env.DB.prepare(
            `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, created_at)
             VALUES (?, 'enrichment', 'diagnostic', ?, 'high', datetime('now'))`,
          ).bind(
            crypto.randomUUID(),
            `[geo_enrichment] BLOCKED: ipinfo.io returned 0 results for ${ips.length} IPs. Free tier (50K/month) likely exhausted. Sample IPs: ${ips.slice(0, 5).join(", ")}`,
          ).run();
        } catch { /* non-fatal */ }
      }

      for (const row of needsGeo) {
        const geo = geoMap.get(row.ip_address);
        if (!geo) continue;

        try {
          const providerName = normalizeProvider(geo.isp, geo.org);
          let providerId: string | null = null;

          if (providerName) {
            providerId = await upsertHostingProvider(env.DB, providerName, geo.as, geo.countryCode);
            if (providerId) result.providersUpserted++;
          }

          await env.DB.prepare(
            `UPDATE threats SET
               country_code = COALESCE(country_code, ?),
               asn = COALESCE(asn, ?),
               lat = COALESCE(lat, ?),
               lng = COALESCE(lng, ?),
               hosting_provider_id = COALESCE(hosting_provider_id, ?)
             WHERE id = ?`,
          ).bind(
            geo.countryCode, geo.as, geo.lat, geo.lng, providerId, row.id,
          ).run();
          result.geoEnriched++;
        } catch (err) {
          console.error(`[enrich] GeoIP update failed for ${row.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[enrich] Stage 2 GeoIP batch lookup failed:", err);
    }
  }

  // ─── Stage 3: WHOIS/RDAP ──────────────────────────────────────
  // Only enrich high/critical severity threats without registrar data
  const needsWhois = await env.DB.prepare(
    `SELECT id, malicious_domain FROM threats
     WHERE malicious_domain IS NOT NULL AND registrar IS NULL
       AND severity IN ('critical', 'high')
     LIMIT 20`,
  ).all<{ id: string; malicious_domain: string }>();

  if (needsWhois.results.length > 0) {
    const domains = needsWhois.results.map((r) => r.malicious_domain);
    try {
      // env-aware: routes through IANA RDAP bootstrap, avoiding the
      // 403-from-rdap.org dead path that nulled all registrar
      // enrichment pre-2026-05-16 audit (PR-C).
      const rdapMap = await batchRDAPLookup(domains, env);

      for (const row of needsWhois.results) {
        const rdap = rdapMap.get(row.malicious_domain);
        if (!rdap?.registrar) continue;

        try {
          await env.DB.prepare(
            "UPDATE threats SET registrar = ? WHERE id = ? AND registrar IS NULL",
          ).bind(rdap.registrar, row.id).run();
          result.whoisEnriched++;
        } catch (err) {
          console.error(`[enrich] WHOIS update failed for ${row.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[enrich] Stage 3 WHOIS batch lookup failed:", err);
    }
  }

  // ─── Stage 4: Brand Auto-Detection ────────────────────────────
  try {
    const brandResult = await enrichBrands(env.DB);
    result.brandsMatched = brandResult.matched;
  } catch (err) {
    console.error("[enrich] Stage 4 brand detection failed:", err);
  }

  // ─── Stage 4b: Cloudflare Domain Ranking ────────────────────
  // Check ambiguous threats (confidence 30-70) against CF Radar ranking.
  // Ranked in top 100K → likely legitimate, lower confidence.
  // Unranked → more suspicious, boost slightly.
  if (env.CF_API_TOKEN) {
    try {
      const ambiguous = await env.DB.prepare(
        `SELECT id, malicious_domain FROM threats
         WHERE cf_rank IS NULL
           AND malicious_domain IS NOT NULL
           AND confidence_score BETWEEN 30 AND 70
         LIMIT 5`,
      ).all<{ id: string; malicious_domain: string }>();

      for (const row of ambiguous.results) {
        try {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/radar/ranking/domain/${row.malicious_domain}`,
            {
              headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, Accept: "application/json" },
              signal: AbortSignal.timeout(5000),
            },
          );

          if (!res.ok) {
            // 404 = domain not ranked (good — probably suspicious)
            if (res.status === 404) {
              await env.DB.prepare(
                "UPDATE threats SET cf_rank = 0 WHERE id = ?",
              ).bind(row.id).run();
              // Unranked domain in ambiguous range → slight boost
              await env.DB.prepare(
                "UPDATE threats SET confidence_score = MIN(confidence_score + 5, 100) WHERE id = ?",
              ).bind(row.id).run();
              result.domainRanksChecked++;
            }
            continue;
          }

          const data = await res.json() as {
            success: boolean;
            result?: { details_0?: { categories?: Array<{ name: string }>; top?: { rank?: number; bucket?: string } } };
          };

          const rank = data.result?.details_0?.top?.rank ?? 0;
          await env.DB.prepare(
            "UPDATE threats SET cf_rank = ? WHERE id = ?",
          ).bind(rank, row.id).run();

          // Ranked in top 100K → likely legitimate, lower confidence
          if (rank > 0 && rank <= 100000) {
            await env.DB.prepare(
              "UPDATE threats SET confidence_score = MAX(confidence_score - 15, 0) WHERE id = ?",
            ).bind(row.id).run();
          }

          result.domainRanksChecked++;
        } catch (err) {
          console.error(`[enrich] domain rank check failed for ${row.malicious_domain}:`, err);
        }

        await new Promise((r) => setTimeout(r, 200));
      }

    } catch (err) {
      console.error("[enrich] Stage 4b domain ranking failed:", err);
    }
  }

  // ─── Stage 4c: Cross-feed corroboration boost ─────────────────
  //
  // PR-D (2026-05-16 audit): the audit found 15 IPs flagged by ≥6
  // distinct feeds with 7K total threats — pure multi-source signal.
  // But `confidence_score` was flat (~78-82) regardless of how many
  // independent feeds corroborated. Highest-confidence IOCs in the
  // corpus were invisible in any UI sort.
  //
  // Boost rule: for any IP corroborated by ≥4 distinct source_feeds,
  // raise active threats' confidence_score to at least the floor
  // computed from feed count. 4 feeds → 85, 6+ feeds → 95. We use
  // GREATEST(confidence_score, floor) so existing high-confidence
  // rows don't get downgraded.
  //
  // Bounded — limits to IPs that need boosting.
  //
  // Cost-sweep rewrite (2026-05-16): the original single-statement
  // CTE+UPDATE was burning 2.87M reads/call × ~21 calls/day = 60M
  // reads (~7% of plan budget). SQLite re-evaluated the CTE 3× per
  // candidate row (MAX subquery, WHERE subquery, IN subquery). Worst-
  // case 250K active-with-IP rows × 3 evaluations = full-corpus
  // scan per stage.
  //
  // Two-step replacement: one bounded GROUP BY scan to read the
  // corroborated IPs list (~5K rows in production), then a per-IP
  // targeted UPDATE (~50 rows each via idx_threats_ip). Total reads
  // per cycle: ~250K (one scan) + N × ~50 (targeted updates) instead
  // of 3 × 250K × |candidate set|.
  //
  // Also gated to run at most once every 6h via a KV stamp — the
  // boost is idempotent and the corpus doesn't shift faster than
  // that on production. Was running every hour from
  // runEnrichmentPipeline (1× orchestrator + agent calls).
  try {
    const STAMP_KEY = "enrich:corroboration_boost:last";
    const lastRun = await env.CACHE.get(STAMP_KEY);
    const lastRunMs = lastRun ? parseInt(lastRun, 10) : 0;
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    if (Date.now() - lastRunMs < SIX_HOURS_MS) {
      // Throttled — skip this cycle.
    } else {
      const corroborated = await env.DB.prepare(`
        SELECT ip_address, COUNT(DISTINCT source_feed) AS feed_count
          FROM threats
         WHERE status = 'active'
           AND ip_address IS NOT NULL
           AND ip_address NOT IN ('', '0.0.0.0')
         GROUP BY ip_address
        HAVING feed_count >= 4
      `).all<{ ip_address: string; feed_count: number }>();

      let totalBoosted = 0;
      // Batched per-IP UPDATEs — 50 statements per D1 batch (within
      // the 100-stmt batch limit). Each statement is a targeted
      // UPDATE via idx_threats_ip — cheap.
      const BATCH_SIZE = 50;
      const rows = corroborated.results ?? [];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        const stmts = chunk.map((r) => {
          const floor = r.feed_count >= 6 ? 95 : r.feed_count >= 5 ? 90 : 85;
          return env.DB.prepare(
            `UPDATE threats
                SET confidence_score = ?
              WHERE status = 'active'
                AND ip_address = ?
                AND COALESCE(confidence_score, 0) < ?`,
          ).bind(floor, r.ip_address, floor);
        });
        try {
          const batchRes = await env.DB.batch(stmts);
          for (const r of batchRes) totalBoosted += r.meta?.changes ?? 0;
        } catch (err) {
          console.error("[enrich] Stage 4c batch update failed:", err);
        }
      }
      result.corroborationBoosted = totalBoosted;
      try {
        await env.CACHE.put(STAMP_KEY, String(Date.now()), {
          expirationTtl: SIX_HOURS_MS / 1000 + 60,
        });
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    console.error("[enrich] Stage 4c corroboration boost failed:", err);
  }

  // ─── Stage 5: Sync hosting_providers counts ───────────────────
  // Change-guarded via syncHostingProviderCounts — only providers whose
  // counts actually changed are written. The prior unguarded full rewrite
  // re-wrote all ~20K rows every run (6×/day), the bulk of the D1 write
  // overage. Now writes ≈ the number of providers that genuinely moved.
  try {
    const { syncHostingProviderCounts } = await import("./provider-counts");
    result.providerCountsUpdated = await syncHostingProviderCounts(env);
  } catch (err) {
    console.error("[enrich] Stage 5 provider count update failed:", err);
  }

  // Same change-guarded sync for brands.active_threat_count (active-only
  // pre-computed counter read by the tenant dashboard + email-security
  // stats). Isolated try/catch so a brand-count failure can't mask a
  // successful provider sync above.
  try {
    const { syncBrandActiveThreatCounts } = await import("./brand-active-counts");
    result.brandActiveCountsUpdated = await syncBrandActiveThreatCounts(env);
  } catch (err) {
    console.error("[enrich] Stage 5 brand active-count update failed:", err);
  }

  return result;
}
