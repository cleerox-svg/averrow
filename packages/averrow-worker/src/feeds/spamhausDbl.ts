import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * Spamhaus DBL — Domain Block List checks via DNS-over-HTTPS.
 *
 * Two modes:
 * A) Bulk enrichment (runs on cron via ingest()): queries recent threats for
 *    unchecked domains and validates against dbl.spamhaus.org.
 * B) Inline enrichment (exported checkSpamhausDBL): other feeds call this
 *    for immediate domain validation.
 *
 * Response decode (127.0.1.x):
 *   2   = spam domain
 *   4   = phishing domain
 *   5   = malware domain
 *   6   = botnet C2 domain
 *   102 = abused legit spam
 *   103 = abused legit redirector (spammed URL)
 *   104 = abused legit phishing
 *   105 = abused legit malware
 *   106 = abused legit botnet C2
 * NXDOMAIN = clean
 *
 * Rate limit: max 50 DNS lookups per cron run (Spamhaus fair use).
 * Results cached in KV with 24h TTL: dbl:{domain}
 */

export interface DBLResult {
  listed: boolean;
  listingType: string | null;
  raw: string | null;
}

const DBL_CODES: Record<number, string> = {
  2: "spam",
  4: "phishing",
  5: "malware",
  6: "botnet_c2",
  102: "abused_legit_spam",
  103: "abused_legit_redirector",
  104: "abused_legit_phishing",
  105: "abused_legit_malware",
  106: "abused_legit_botnet_c2",
};

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Inline Spamhaus DBL check — call from other feeds for immediate domain validation.
 * Results cached in KV with 24h TTL.
 */
export async function checkSpamhausDBL(domain: string, env: Env): Promise<DBLResult> {
  const cacheKey = `dbl:${domain}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as DBLResult;
  }

  const result = await dnsLookupDBL(domain);
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
  return result;
}

async function dnsLookupDBL(domain: string): Promise<DBLResult> {
  const queryDomain = `${domain}.dbl.spamhaus.org`;
  const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(queryDomain)}&type=A`;

  const res = await fetch(dohUrl, {
    signal: AbortSignal.timeout(30_000), headers: { Accept: "application/dns-json" },
  });

  if (!res.ok) {
    return { listed: false, listingType: null, raw: null };
  }

  const data = (await res.json()) as {
    Status: number;
    Answer?: Array<{ data: string }>;
  };

  // Status 3 = NXDOMAIN (not listed)
  if (data.Status === 3 || !data.Answer || data.Answer.length === 0) {
    return { listed: false, listingType: null, raw: null };
  }

  for (const answer of data.Answer) {
    const ip = answer.data;
    if (ip.startsWith("127.0.1.")) {
      const lastOctet = parseInt(ip.split(".")[3] ?? "0", 10);
      const listingType = DBL_CODES[lastOctet] ?? `unknown_${lastOctet}`;
      return { listed: true, listingType, raw: ip };
    }
  }

  return { listed: false, listingType: null, raw: null };
}

/** Map DBL listing type to severity escalation and confidence boost */
function dblEscalation(listingType: string): { severity: string; boost: number } {
  switch (listingType) {
    case "phishing":
    case "abused_legit_phishing":
      return { severity: "high", boost: 15 };
    case "malware":
    case "abused_legit_malware":
      return { severity: "critical", boost: 20 };
    case "botnet_c2":
    case "abused_legit_botnet_c2":
      return { severity: "critical", boost: 20 };
    case "spam":
    case "abused_legit_spam":
    case "abused_legit_redirector":
      // Spam = listed but no severity escalation
      return { severity: "none", boost: 5 };
    default:
      return { severity: "none", boost: 5 };
  }
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

export const spamhaus_dbl: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    // Query unchecked domains (last 7 days, limit 50 — Spamhaus fair use)
    const unchecked = await env.DB.prepare(`
      SELECT DISTINCT id, malicious_domain FROM threats
      WHERE dbl_checked = 0
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND first_seen >= datetime('now', '-7 days')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
      LIMIT 50
    `).all<{ id: string; malicious_domain: string }>();

    const threats = unchecked.results;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const row of threats) {
      itemsFetched++;
      try {
        const result = await checkSpamhausDBL(row.malicious_domain, env);

        if (result.listed && result.listingType) {
          const { severity: targetSeverity, boost } = dblEscalation(result.listingType);
          const targetRank = SEVERITY_RANK[targetSeverity] ?? 0;

          if (targetSeverity !== "none") {
            // Update with severity escalation
            await env.DB.prepare(`
              UPDATE threats SET
                dbl_checked = 1,
                dbl_listed = 1,
                dbl_type = ?,
                confidence_score = MIN(100, COALESCE(confidence_score, 60) + ?),
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
            `).bind(result.listingType, boost, targetRank, targetSeverity, row.id).run();
          } else {
            // Listed (spam) but no severity escalation
            await env.DB.prepare(`
              UPDATE threats SET
                dbl_checked = 1,
                dbl_listed = 1,
                dbl_type = ?,
                confidence_score = MIN(100, COALESCE(confidence_score, 60) + ?)
              WHERE id = ?
            `).bind(result.listingType, boost, row.id).run();
          }

          // Also update all other threats sharing this domain
          await env.DB.prepare(`
            UPDATE threats SET
              dbl_checked = 1,
              dbl_listed = 1,
              dbl_type = ?
            WHERE malicious_domain = ? AND id != ? AND dbl_checked = 0
          `).bind(result.listingType, row.malicious_domain, row.id).run();

          await checkCrossFeedEscalation(env.DB, row.id);

          logger.info("spamhaus_dbl_listed", {
            domain: row.malicious_domain,
            type: result.listingType,
            threat_id: row.id,
            message: `Domain ${row.malicious_domain} listed as ${result.listingType}`,
          });
          itemsNew++;
        } else {
          // Mark as checked but clean
          await env.DB.prepare(`
            UPDATE threats SET dbl_checked = 1
            WHERE malicious_domain = ? AND dbl_checked = 0
          `).bind(row.malicious_domain).run();
          itemsDuplicate++;
        }
      } catch (err) {
        logger.error("spamhaus_dbl_error", {
          domain: row.malicious_domain,
          error: err instanceof Error ? err.message : String(err),
        });
        itemsError++;
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
