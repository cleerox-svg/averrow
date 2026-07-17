import type { FeedModule, FeedContext, FeedResult } from "./types";
import { logger } from "../lib/logger";

/**
 * C2IntelFeeds — Additional C2 infrastructure intelligence.
 *
 * Sources: drb-ra/C2IntelFeeds GitHub repository
 * Provides C2 domains and IPs with 30-day rolling windows.
 * Schedule: daily (0 5 * * *)
 *
 * CSV format with headers:
 *   IPC2s-30day.csv: IP,ioc
 *   domainC2s.csv: domain,ioc
 */

const IP_FEED_URL = "https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv";
const DOMAIN_FEED_URL = "https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/domainC2s.csv";
const MAX_PER_RUN = 300;

function parseCSV(text: string): string[][] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return []; // Need header + at least 1 row
  // Skip header row
  return lines.slice(1)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => line.split(",").map(f => f.trim()));
}

function isValidIP(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

function isValidDomain(domain: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(domain);
}

export const c2_intel_feeds: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    // Fetch both CSVs in parallel
    const [ipRes, domainRes] = await Promise.all([
      fetch(IP_FEED_URL).catch(err => {
        logger.error("c2intel_ip_fetch_error", { error: String(err) });
        return null;
      }),
      fetch(DOMAIN_FEED_URL).catch(err => {
        logger.error("c2intel_domain_fetch_error", { error: String(err) });
        return null;
      }),
    ]);

    const ipEntries: { ip: string; ioc: string }[] = [];
    const domainEntries: { domain: string; ioc: string }[] = [];

    if (ipRes?.ok) {
      const text = await ipRes.text();
      const rows = parseCSV(text);
      for (const row of rows) {
        if (row.length >= 1 && isValidIP(row[0]!)) {
          ipEntries.push({ ip: row[0]!, ioc: row[1] ?? "c2" });
        }
      }
    }

    if (domainRes?.ok) {
      const text = await domainRes.text();
      const rows = parseCSV(text);
      for (const row of rows) {
        if (row.length >= 1 && isValidDomain(row[0]!)) {
          domainEntries.push({ domain: row[0]!, ioc: row[1] ?? "c2" });
        }
      }
    }

    itemsFetched = ipEntries.length + domainEntries.length;

    // Process IPs — limit total to MAX_PER_RUN across both types
    let processed = 0;

    for (const entry of ipEntries) {
      if (processed >= MAX_PER_RUN) break;
      processed++;

      try {
        // Check for existing threat (dedup against c2_tracker and self)
        const existing = await env.DB.prepare(`
          SELECT id FROM threats
          WHERE ip_address = ?
            AND source_feed IN ('c2_tracker', 'c2_intel_feeds')
            AND status = 'active'
          LIMIT 1
        `).bind(entry.ip).first<{ id: string }>();

        if (existing) {
          itemsDuplicate++;
          continue;
        }

        await env.DB.prepare(`
          INSERT INTO threats (id, source_feed, threat_type, ip_address, severity, confidence_score, status, first_seen, last_seen, created_at)
          VALUES (?, 'c2_intel_feeds', 'c2_infrastructure', ?, 'critical', 90, 'active', datetime('now'), datetime('now'), datetime('now'))
          ON CONFLICT DO NOTHING
        `).bind(crypto.randomUUID(), entry.ip).run();

        itemsNew++;
      } catch (err) {
        logger.error("c2intel_ip_insert_error", {
          ip: entry.ip,
          error: err instanceof Error ? err.message : String(err),
        });
        itemsError++;
      }
    }

    // Process domains
    for (const entry of domainEntries) {
      if (processed >= MAX_PER_RUN) break;
      processed++;

      try {
        // Check for existing threat (dedup against c2_tracker and self)
        const existing = await env.DB.prepare(`
          SELECT id FROM threats
          WHERE malicious_domain = ?
            AND source_feed IN ('c2_tracker', 'c2_intel_feeds')
            AND status = 'active'
          LIMIT 1
        `).bind(entry.domain).first<{ id: string }>();

        if (existing) {
          itemsDuplicate++;
          continue;
        }

        await env.DB.prepare(`
          INSERT INTO threats (id, source_feed, threat_type, malicious_domain, severity, confidence_score, status, first_seen, last_seen, created_at)
          VALUES (?, 'c2_intel_feeds', 'c2_infrastructure', ?, 'critical', 90, 'active', datetime('now'), datetime('now'), datetime('now'))
          ON CONFLICT DO NOTHING
        `).bind(crypto.randomUUID(), entry.domain).run();

        itemsNew++;
      } catch (err) {
        logger.error("c2intel_domain_insert_error", {
          domain: entry.domain,
          error: err instanceof Error ? err.message : String(err),
        });
        itemsError++;
      }
    }

    logger.info("c2intel_feeds_complete", {
      ip_entries: ipEntries.length,
      domain_entries: domainEntries.length,
      new: itemsNew,
      duplicate: itemsDuplicate,
      errors: itemsError,
    });

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
