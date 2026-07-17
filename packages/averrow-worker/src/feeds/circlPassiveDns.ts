import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * CIRCL Passive DNS — Historical DNS resolution data.
 *
 * Queries CIRCL's passive DNS database to discover what IPs a domain has
 * resolved to historically. This reveals infrastructure sharing between
 * threat domains — a key signal for NEXUS cluster correlation.
 *
 * Auth: HTTP Basic (env.CIRCL_PDNS_USER, env.CIRCL_PDNS_PASS).
 * Free registration at circl.lu required.
 *
 * Rate conservative: 10 domains per 2-hour run.
 * Registered as DISABLED by default until CIRCL credentials are obtained.
 */

export interface PDNSResult {
  rrname: string;
  rdata: string;
  rrtype: string;
  time_first: string;
  time_last: string;
}

/**
 * Query CIRCL Passive DNS for a single domain.
 * Returns array of DNS resolution records.
 */
export async function queryPassiveDNS(domain: string, env: Env): Promise<PDNSResult[]> {
  if (!env.CIRCL_PDNS_USER || !env.CIRCL_PDNS_PASS) return [];

  const credentials = btoa(`${env.CIRCL_PDNS_USER}:${env.CIRCL_PDNS_PASS}`);

  const res = await fetch(`https://www.circl.lu/pdns/query/${encodeURIComponent(domain)}`, {
    signal: AbortSignal.timeout(30_000), headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    logger.error("circl_pdns_api_error", { domain, status: res.status });
    return [];
  }

  const text = await res.text();
  if (!text.trim()) return [];

  // CIRCL returns NDJSON (one JSON object per line)
  const records: PDNSResult[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as {
        rrname?: string;
        rdata?: string;
        rrtype?: string;
        time_first?: number | string;
        time_last?: number | string;
      };
      if (record.rrname && record.rdata) {
        records.push({
          rrname: record.rrname,
          rdata: record.rdata,
          rrtype: record.rrtype ?? "A",
          time_first: String(record.time_first ?? ""),
          time_last: String(record.time_last ?? ""),
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const circl_pdns: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    // Graceful skip if credentials not set
    if (!env.CIRCL_PDNS_USER || !env.CIRCL_PDNS_PASS) {
      logger.info("circl_pdns_skipped", { reason: "CIRCL_PDNS_USER or CIRCL_PDNS_PASS not set" });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Query high-severity threats without passive DNS data
    const unchecked = await env.DB.prepare(`
      SELECT DISTINCT id, malicious_domain FROM threats
      WHERE pdns_checked = 0
        AND severity IN ('critical', 'high')
        AND malicious_domain IS NOT NULL
        AND first_seen >= datetime('now', '-7 days')
      LIMIT 10
    `).all<{ id: string; malicious_domain: string }>();

    const threats = unchecked.results;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const threat of threats) {
      itemsFetched++;
      try {
        const records = await queryPassiveDNS(threat.malicious_domain, env);

        if (records.length === 0) {
          // Mark as checked even if no results
          await env.DB.prepare(
            "UPDATE threats SET pdns_checked = 1 WHERE id = ?",
          ).bind(threat.id).run();
          itemsDuplicate++;
          continue;
        }

        // Store passive DNS records
        const insertStmts = records.slice(0, 50).map((r) => {
          const recordId = `pdns-${threat.id}-${r.rdata}-${r.rrtype}`.slice(0, 64);
          return env.DB.prepare(`
            INSERT OR IGNORE INTO passive_dns_records
              (id, threat_id, query_domain, resolved_ip, rrtype, time_first, time_last, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'circl', datetime('now'))
          `).bind(
            recordId,
            threat.id,
            threat.malicious_domain,
            r.rdata,
            r.rrtype,
            r.time_first,
            r.time_last,
          );
        });

        if (insertStmts.length > 0) {
          await env.DB.batch(insertStmts);
        }

        // Check for infrastructure correlation: do resolved IPs appear in other threats?
        let correlations = 0;
        const aRecords = records.filter((r) => r.rrtype === "A");
        for (const record of aRecords.slice(0, 10)) {
          const correlated = await env.DB.prepare(`
            SELECT COUNT(*) as count FROM threats
            WHERE ip_address = ? AND id != ?
          `).bind(record.rdata, threat.id).first<{ count: number }>();

          if (correlated && correlated.count > 0) {
            correlations += correlated.count;
            logger.info("pdns_correlation", {
              domain: threat.malicious_domain,
              ip: record.rdata,
              related_threats: correlated.count,
            });
          }
        }

        // Update threat: mark checked, store correlation count
        await env.DB.prepare(`
          UPDATE threats SET
            pdns_checked = 1,
            pdns_correlations = ?
          WHERE id = ?
        `).bind(correlations, threat.id).run();

        itemsNew++;

        // Delay between API calls to be respectful of CIRCL rate limits
        if (itemsFetched < threats.length) {
          await sleep(2000);
        }
      } catch (err) {
        logger.error("circl_pdns_error", {
          domain: threat.malicious_domain,
          error: err instanceof Error ? err.message : String(err),
        });
        itemsError++;
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
