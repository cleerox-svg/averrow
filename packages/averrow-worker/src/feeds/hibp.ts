// TODO: Enable when HIBP Pro subscription is purchased
// Set HIBP_API_KEY secret and enable feed in feed_configs
// This provides credential exposure data for monitored brand domains
// Value prop: "X credentials for your brand's login page found in stealer logs"

import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * HIBP Stealer Logs — Credential exposure checks for monitored brand domains.
 *
 * Requires a HIBP Pro subscription (paid). This module is a stub interface
 * that returns null gracefully when no API key is configured, and performs
 * real lookups when the key is set.
 *
 * API: GET https://haveibeenpwned.com/api/v3/stealerlogsearchresult/{domain}
 * Headers: hibp-api-key, user-agent (required by HIBP)
 */

export interface HIBPResult {
  entriesCount: number;
  latestEntryDate: string | null;
  rawResponse: string;
}

/**
 * Check a domain against HIBP stealer log database.
 * Returns null if HIBP_API_KEY is not configured (feed disabled).
 */
export async function checkHIBPStealerLogs(domain: string, env: Env): Promise<HIBPResult | null> {
  if (!env.HIBP_API_KEY) {
    logger.info("hibp_disabled", { message: "HIBP feed disabled — API key not configured" });
    return null;
  }

  const res = await fetch(
    `https://haveibeenpwned.com/api/v3/stealerlogsearchresult/${encodeURIComponent(domain)}`,
    {
      signal: AbortSignal.timeout(30_000), headers: {
        "hibp-api-key": env.HIBP_API_KEY,
        "user-agent": "Averrow-ThreatIntel/1.0",
      },
    },
  );

  if (res.status === 404) {
    // No stealer log entries found for this domain
    return { entriesCount: 0, latestEntryDate: null, rawResponse: "[]" };
  }

  if (res.status === 401) {
    throw new Error("HIBP: Invalid API key (HTTP 401)");
  }

  if (res.status === 429) {
    throw new Error("HIBP: Rate limit exceeded (HTTP 429)");
  }

  if (!res.ok) {
    throw new Error(`HIBP HTTP ${res.status}`);
  }

  const rawResponse = await res.text();
  const entries = JSON.parse(rawResponse) as Array<{
    EmailAddress?: string;
    DateFound?: string;
  }>;

  let latestEntryDate: string | null = null;
  for (const entry of entries) {
    if (entry.DateFound && (!latestEntryDate || entry.DateFound > latestEntryDate)) {
      latestEntryDate = entry.DateFound;
    }
  }

  return {
    entriesCount: entries.length,
    latestEntryDate,
    rawResponse,
  };
}

export const hibp_stealer_logs: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    if (!env.HIBP_API_KEY) {
      logger.info("hibp_stealer_logs_skipped", {
        message: "HIBP feed disabled — API key not configured",
      });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Query monitored brand domains that haven't been checked recently
    const brands = await env.DB.prepare(`
      SELECT b.id AS brand_id, b.canonical_domain
      FROM brands b
      WHERE b.canonical_domain IS NOT NULL
        AND b.canonical_domain != ''
        AND b.monitoring_status = 'active'
        AND b.id NOT IN (
          SELECT slr.brand_id FROM stealer_log_results slr
          WHERE slr.brand_id IS NOT NULL
            AND slr.checked_at > datetime('now', '-7 days')
        )
      ORDER BY b.threat_count DESC
      LIMIT 20
    `).all<{ brand_id: string; canonical_domain: string }>();

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const brand of brands.results) {
      itemsFetched++;
      try {
        const result = await checkHIBPStealerLogs(brand.canonical_domain, env);
        if (!result) break; // API key removed mid-run

        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT OR REPLACE INTO stealer_log_results
            (id, domain, brand_id, entries_count, latest_entry_date, checked_at, raw_response)
          VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
        `).bind(
          id,
          brand.canonical_domain,
          brand.brand_id,
          result.entriesCount,
          result.latestEntryDate,
          result.rawResponse,
        ).run();

        if (result.entriesCount > 0) {
          itemsNew++;
        } else {
          itemsDuplicate++;
        }

        // HIBP rate limit: 1 request per 1.5 seconds
        if (brands.results.indexOf(brand) < brands.results.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1600));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("hibp_stealer_logs_error", {
          domain: brand.canonical_domain,
          error: msg,
        });

        if (msg.includes("429")) break;
        itemsError++;
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
