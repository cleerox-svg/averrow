import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * VirusTotal — Domain reputation enrichment for high-severity threats.
 *
 * Free tier limits: 4 requests/minute, 500 requests/day.
 * Strategy: enrich only high/critical severity threats, max 10 domains per 30-min run
 * (= 480/day, safe under the 500 daily limit).
 *
 * Daily call tracking via KV key: vt_daily_calls_{YYYY-MM-DD}
 * If count >= 480, skip until next day.
 */

export interface VTResult {
  malicious_count: number;
  suspicious_count: number;
  reputation: number;
  categories: Record<string, string>;
}

/**
 * Enrich a single domain via VirusTotal API.
 * Can be called from other modules for on-demand enrichment.
 */
export async function enrichWithVirusTotal(domain: string, env: Env): Promise<VTResult> {
  const res = await fetch(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(domain)}`, {
    signal: AbortSignal.timeout(30_000), headers: {
      "x-apikey": env.VIRUSTOTAL_API_KEY,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    throw new Error("VirusTotal rate limit exceeded (HTTP 429)");
  }
  if (res.status === 404) {
    // Domain not found in VT — return zeroed result
    return { malicious_count: 0, suspicious_count: 0, reputation: 0, categories: {} };
  }
  if (!res.ok) {
    throw new Error(`VirusTotal HTTP ${res.status}`);
  }

  const body = await res.json() as {
    data: {
      attributes: {
        last_analysis_stats?: {
          malicious: number;
          suspicious: number;
          harmless: number;
          undetected: number;
        };
        reputation?: number;
        categories?: Record<string, string>;
        registrar?: string;
        creation_date?: number;
      };
    };
  };

  const attrs = body.data.attributes;
  const stats = attrs.last_analysis_stats;

  return {
    malicious_count: stats?.malicious ?? 0,
    suspicious_count: stats?.suspicious ?? 0,
    reputation: attrs.reputation ?? 0,
    categories: attrs.categories ?? {},
  };
}

/** Get and increment daily VT API call counter */
async function getDailyCallCount(env: Env): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `vt_daily_calls_${today}`;
  const count = parseInt(await env.CACHE.get(key) ?? "0", 10);
  return count;
}

async function incrementDailyCallCount(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `vt_daily_calls_${today}`;
  const current = parseInt(await env.CACHE.get(key) ?? "0", 10);
  // TTL 86400 = 24h — key auto-expires next day
  await env.CACHE.put(key, String(current + 1), { expirationTtl: 86400 });
}

const DAILY_LIMIT = 480;

export const virustotal: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    // Check daily limit
    const dailyCalls = await getDailyCallCount(env);
    if (dailyCalls >= DAILY_LIMIT) {
      logger.info("virustotal_daily_limit", {
        calls: dailyCalls,
        limit: DAILY_LIMIT,
        message: "VirusTotal daily limit reached (480/500), skipping enrichment until tomorrow",
      });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Query high-severity threats without VT data (limit 10 per run)
    const unchecked = await env.DB.prepare(`
      SELECT DISTINCT malicious_domain FROM threats
      WHERE vt_checked = 0
        AND severity IN ('critical', 'high')
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND created_at > datetime('now', '-7 days')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT 10
    `).all<{ malicious_domain: string }>();

    const domains = unchecked.results;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    // Elapsed-time cap so a slow VT run can't push the parent
    // orchestrator's hourly tick past the 15-min navigator reaper
    // threshold. 10 domains × (3-30s fetch + 16s rate-limit sleep) ≈
    // ~3 min in the common path, but a few timeouts can blow it past
    // 5 min easily. 4 min cap keeps the worker headroom for the rest
    // of the orchestrator's work and aligns with the per-feed retry
    // budget (PR-K). Whichever batch gets cut short here is picked up
    // by the next tick — the vt_checked flag makes the iteration
    // resumable across runs.
    const PULL_BUDGET_MS = 4 * 60_000;
    const startTime = Date.now();

    for (const row of domains) {
      if (Date.now() - startTime > PULL_BUDGET_MS) {
        logger.info("virustotal_pull_budget_reached", {
          processed: itemsFetched,
          remaining: domains.length - itemsFetched,
          elapsedMs: Date.now() - startTime,
        });
        break;
      }

      // Re-check daily limit before each call
      const currentCalls = await getDailyCallCount(env);
      if (currentCalls >= DAILY_LIMIT) {
        logger.info("virustotal_daily_limit_mid_run", { calls: currentCalls });
        break;
      }

      itemsFetched++;

      try {
        const result = await enrichWithVirusTotal(row.malicious_domain, env);
        await incrementDailyCallCount(env);

        if (result.malicious_count > 0) {
          // Determine severity escalation and confidence boost
          const shouldEscalate = result.malicious_count > 5;
          const confidenceBoost = result.malicious_count >= 5 ? 20 : 10;

          await env.DB.prepare(`
            UPDATE threats SET
              vt_checked = 1,
              vt_malicious = ?,
              vt_reputation = ?,
              confidence_score = MIN(100, COALESCE(confidence_score, 60) + ?),
              severity = CASE
                WHEN ? = 1 AND severity != 'critical' THEN 'critical'
                ELSE severity
              END
            WHERE malicious_domain = ?
          `).bind(
            result.malicious_count,
            result.reputation,
            confidenceBoost,
            shouldEscalate ? 1 : 0,
            row.malicious_domain,
          ).run();

          // Combined escalation: if VT flagged AND SURBL already listed, auto-escalate to critical
          if (result.malicious_count >= 3) {
            await env.DB.prepare(`
              UPDATE threats SET severity = 'critical'
              WHERE malicious_domain = ?
                AND surbl_listed = 1
                AND vt_malicious >= 3
                AND severity != 'critical'
            `).bind(row.malicious_domain).run();
          }

          itemsNew++;
        } else {
          // Mark as checked, no findings
          await env.DB.prepare(`
            UPDATE threats SET
              vt_checked = 1,
              vt_malicious = 0,
              vt_reputation = ?
            WHERE malicious_domain = ?
          `).bind(result.reputation, row.malicious_domain).run();

          itemsDuplicate++;
        }

        // Rate limit: 4 req/min → wait 16 seconds between calls
        if (domains.indexOf(row) < domains.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 16_000));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("virustotal_enrichment_error", {
          domain: row.malicious_domain,
          error: msg,
        });

        // If rate limited, stop immediately
        if (msg.includes("429")) break;

        itemsError++;
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
