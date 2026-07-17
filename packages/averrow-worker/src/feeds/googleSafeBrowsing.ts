import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * Google Safe Browsing — URL safety checks via Lookup API v4.
 *
 * Two modes:
 * A) Bulk enrichment (runs on cron via ingest()): queries recent threats for
 *    unchecked URLs/domains and validates them against Google's phishing and
 *    malware lists. Batch checks up to 100 URLs per run.
 * B) Inline enrichment (exported checkGoogleSafeBrowsing): other feeds call
 *    this for immediate URL validation.
 *
 * API key: env.GOOGLE_SAFE_BROWSING_KEY (Worker secret).
 * Free for non-commercial use — will upgrade to Web Risk API later.
 * Results cached in KV with 24h TTL: gsb:{url_hash}
 */

export interface GSBResult {
  flagged: boolean;
  threatType: string | null;
}

interface GSBMatch {
  threat: { url: string };
  threatType: string;
  platformType: string;
  cacheDuration: string;
}

interface GSBResponse {
  matches?: GSBMatch[];
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Check URLs against Google Safe Browsing Lookup API v4.
 * Can batch up to 500 URLs per request; we cap at 100 per run.
 * Results are cached in KV with 24h TTL.
 */
export async function checkGoogleSafeBrowsing(
  urls: string[],
  env: Env,
): Promise<GSBResult[]> {
  const gsbKey = (env as unknown as Record<string, string | undefined>).GOOGLE_SAFE_BROWSING_KEY;
  if (!gsbKey) {
    return urls.map(() => ({ flagged: false, threatType: null }));
  }

  // Check KV cache for each URL; collect uncached ones
  const results: GSBResult[] = new Array(urls.length);
  const uncachedIndices: number[] = [];
  const uncachedUrls: string[] = [];

  for (let i = 0; i < urls.length; i++) {
    const cacheKey = `gsb:${urls[i]}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached !== null) {
      results[i] = JSON.parse(cached) as GSBResult;
    } else {
      uncachedIndices.push(i);
      uncachedUrls.push(urls[i]!);
    }
  }

  if (uncachedUrls.length === 0) return results;

  // Call Google Safe Browsing API
  const endpoint = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${gsbKey}`;
  const body = {
    client: { clientId: "averrow", clientVersion: "1.0" },
    threatInfo: {
      threatTypes: [
        "MALWARE",
        "SOCIAL_ENGINEERING",
        "UNWANTED_SOFTWARE",
        "POTENTIALLY_HARMFUL_APPLICATION",
      ],
      platformTypes: ["ANY_PLATFORM"],
      threatEntryTypes: ["URL"],
      threatEntries: uncachedUrls.map((u) => ({ url: u })),
    },
  };

  const res = await fetch(endpoint, {
    signal: AbortSignal.timeout(30_000), method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    logger.error("gsb_api_error", { status: res.status, statusText: res.statusText });
    // Mark all uncached as clean (graceful degradation)
    for (const idx of uncachedIndices) {
      results[idx] = { flagged: false, threatType: null };
    }
    return results;
  }

  const data = (await res.json()) as GSBResponse;
  const matchMap = new Map<string, string>();
  if (data.matches) {
    for (const match of data.matches) {
      matchMap.set(match.threat.url, match.threatType);
    }
  }

  // Fill results and cache
  for (let j = 0; j < uncachedIndices.length; j++) {
    const url = uncachedUrls[j]!;
    const idx = uncachedIndices[j]!;
    const threatType = matchMap.get(url) ?? null;
    const result: GSBResult = {
      flagged: threatType !== null,
      threatType,
    };
    results[idx] = result;
    await env.CACHE.put(`gsb:${url}`, JSON.stringify(result), { expirationTtl: 86400 });
  }

  return results;
}

/**
 * Cross-feed escalation: when 3+ enrichment sources agree, auto-escalate to critical.
 */
async function checkCrossFeedEscalation(db: D1Database, threatId: string): Promise<void> {
  const row = await db.prepare(`
    SELECT
      (CASE WHEN surbl_listed = 1 THEN 1 ELSE 0 END) +
      (CASE WHEN vt_malicious >= 3 THEN 1 ELSE 0 END) +
      (CASE WHEN gsb_flagged = 1 THEN 1 ELSE 0 END) +
      (CASE WHEN dbl_listed = 1 THEN 1 ELSE 0 END) as signals
    FROM threats WHERE id = ?
  `).bind(threatId).first<{ signals: number }>();

  if (row && row.signals >= 3) {
    await db.prepare(`
      UPDATE threats SET severity = 'critical', confidence_score = 99
      WHERE id = ? AND (severity != 'critical' OR confidence_score < 99)
    `).bind(threatId).run();
    logger.info("enrichment_cross_feed_escalation", {
      threat_id: threatId,
      signals: row.signals,
      message: `Threat ${threatId} confirmed by ${row.signals} independent sources — critical`,
    });
  }
}

export const google_safe_browsing: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;
    const gsbKey = (env as unknown as Record<string, string | undefined>).GOOGLE_SAFE_BROWSING_KEY;

    if (!gsbKey) {
      logger.info("gsb_disabled", {
        message: "Google Safe Browsing disabled — GOOGLE_SAFE_BROWSING_KEY not configured",
      });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Query threats with unchecked Google SB status (last 7 days, limit 100)
    const unchecked = await env.DB.prepare(`
      SELECT id, malicious_url, malicious_domain FROM threats
      WHERE gsb_checked = 0
        AND (malicious_url IS NOT NULL OR malicious_domain IS NOT NULL)
        AND first_seen >= datetime('now', '-7 days')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
      LIMIT 100
    `).all<{ id: string; malicious_url: string | null; malicious_domain: string | null }>();

    const threats = unchecked.results;
    if (threats.length === 0) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Build URL list: prefer malicious_url, fallback to http://{domain}
    const urlMap = new Map<string, string[]>(); // url -> threat IDs
    for (const t of threats) {
      const url = t.malicious_url ?? `http://${t.malicious_domain}`;
      const ids = urlMap.get(url) ?? [];
      ids.push(t.id);
      urlMap.set(url, ids);
    }

    const urls = Array.from(urlMap.keys());
    let itemsFetched = threats.length;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    try {
      const results = await checkGoogleSafeBrowsing(urls, env);

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]!;
        const result = results[i]!;
        const threatIds = urlMap.get(url) ?? [];

        if (result.flagged && result.threatType) {
          // Determine severity escalation
          let targetSeverity: string;
          if (result.threatType === "MALWARE") {
            targetSeverity = "critical";
          } else if (result.threatType === "SOCIAL_ENGINEERING") {
            targetSeverity = "high";
          } else {
            targetSeverity = "high";
          }
          const targetRank = SEVERITY_RANK[targetSeverity] ?? 3;

          for (const tid of threatIds) {
            await env.DB.prepare(`
              UPDATE threats SET
                gsb_checked = 1,
                gsb_flagged = 1,
                gsb_threat_type = ?,
                confidence_score = MIN(100, COALESCE(confidence_score, 60) + 25),
                severity = CASE
                  WHEN ? > COALESCE(
                    CASE severity
                      WHEN 'info' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2
                      WHEN 'high' THEN 3 WHEN 'critical' THEN 4 ELSE 0
                    END, 0)
                  THEN ?
                  ELSE severity
                END
              WHERE id = ?
            `).bind(result.threatType, targetRank, targetSeverity, tid).run();

            await checkCrossFeedEscalation(env.DB, tid);
          }

          logger.info("gsb_threat_confirmed", {
            url,
            threatType: result.threatType,
            threat_ids: threatIds,
            message: `Threat(s) confirmed as ${result.threatType} by Google Safe Browsing`,
          });
          itemsNew++;
        } else {
          // Mark as checked but clean
          for (const tid of threatIds) {
            await env.DB.prepare(`
              UPDATE threats SET gsb_checked = 1
              WHERE id = ?
            `).bind(tid).run();
          }
          itemsDuplicate++;
        }
      }
    } catch (err) {
      logger.error("gsb_enrichment_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      itemsError = threats.length;
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
