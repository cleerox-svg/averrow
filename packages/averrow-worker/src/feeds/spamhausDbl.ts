import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";
import { DnsblLookupError, dohLookupA, dnsblRunShouldFail, type DohAnswer } from "../lib/dnsbl-doh";

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
 * 127.255.255.x / 127.0.1.255 = Spamhaus error codes → lookup ERROR, never
 * clean (lib/dnsbl-doh.ts). Each run self-tests on dbltest.com first and
 * fails the pull when it is not listed.
 *
 * DISABLED in prod by migration 0326: the free DBL tiers are non-commercial
 * and Spamhaus refuses public resolvers. Re-enable only with a Spamhaus
 * Technology subscription (DQS key) and a lookup path that uses it.
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
 * Spamhaus's DBL test record — always listed (127.0.1.2). Each ingest run
 * resolves it first; if it does not come back listed the resolver path is
 * blind (Spamhaus answers public resolvers such as Cloudflare's with
 * 127.255.255.254 — live test 2026-11-14) and the run fails loudly.
 */
export const DBL_TEST_POINT = "dbltest.com";

/**
 * KV cache prefix. `v2`: entries written before 2026-11 could be a refused
 * lookup cached as "clean"; the new prefix never reads them.
 */
const DBL_CACHE_PREFIX = "dbl:v2:";

/**
 * Inline Spamhaus DBL check — call from other feeds for immediate domain validation.
 * Results cached in KV with 24h TTL. Throws `DnsblLookupError` when the
 * lookup failed or was refused; that is never a clean verdict.
 */
export async function checkSpamhausDBL(domain: string, env: Env): Promise<DBLResult> {
  const cacheKey = `${DBL_CACHE_PREFIX}${domain}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as DBLResult;
  }

  const result = await dnsLookupDBL(domain);
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
  return result;
}

/**
 * Decode a DBL DoH answer. Exported for tests.
 *
 *   NXDOMAIN / empty NOERROR    → not listed
 *   127.255.255.X               → Spamhaus error code (.252 typo in the
 *                                 zone name, .254 public/open resolver,
 *                                 .255 excessive queries) → refused error
 *   127.0.1.255                 → "IP queries prohibited" → refused error
 *   127.0.1.X                   → listed
 *   anything else               → unexpected answer → refused error
 */
export function decodeDBLAnswer(domain: string, answer: DohAnswer): DBLResult {
  if (answer.status === 3 || answer.addresses.length === 0) {
    return { listed: false, listingType: null, raw: null };
  }
  for (const ip of answer.addresses) {
    if (ip.startsWith("127.255.255.") || ip === "127.0.1.255") {
      throw new DnsblLookupError("refused", `Spamhaus DBL refused the query for ${domain} (${ip} is an error code, not a listing)`);
    }
    if (ip.startsWith("127.0.1.")) {
      const lastOctet = parseInt(ip.split(".")[3] ?? "0", 10);
      const listingType = DBL_CODES[lastOctet] ?? `unknown_${lastOctet}`;
      return { listed: true, listingType, raw: ip };
    }
  }
  throw new DnsblLookupError("refused", `Spamhaus DBL returned an unexpected answer for ${domain}: ${answer.addresses.join(",")}`);
}

async function dnsLookupDBL(domain: string): Promise<DBLResult> {
  return decodeDBLAnswer(domain, await dohLookupA(`${domain}.dbl.spamhaus.org`));
}

/** Resolve the DBL test record (uncached); throws when it is not listed. */
export async function assertDBLResolverWorks(): Promise<void> {
  let result: DBLResult;
  try {
    result = await dnsLookupDBL(DBL_TEST_POINT);
  } catch (err) {
    throw new Error(`Spamhaus DBL self-test failed: test record lookup errored (${err instanceof Error ? err.message : String(err)}) — lookups are not being answered; no domains checked`);
  }
  if (!result.listed) {
    throw new Error("Spamhaus DBL self-test failed: dbltest.com is not listed — resolver path is blind; no domains checked");
  }
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

    // Self-test first: a blind resolver must fail the pull, not stamp
    // every domain checked-clean.
    await assertDBLResolverWorks();

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
        // A refused lookup means Spamhaus stopped answering mid-run: abort
        // so the pull is recorded failed. The row stays dbl_checked = 0.
        if (err instanceof DnsblLookupError && err.kind === "refused") {
          throw new Error(`Spamhaus DBL lookups refused after ${itemsFetched - 1} checked: ${err.message}`);
        }
        logger.error("spamhaus_dbl_error", {
          domain: row.malicious_domain,
          error: err instanceof Error ? err.message : String(err),
        });
        itemsError++;
      }
    }

    if (dnsblRunShouldFail(itemsFetched, itemsError)) {
      throw new Error(`Spamhaus DBL: all ${itemsFetched} lookups failed — no domains checked`);
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
