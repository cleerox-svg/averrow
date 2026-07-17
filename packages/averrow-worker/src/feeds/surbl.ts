import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * SURBL — DNS-based domain reputation checks.
 *
 * Two modes:
 * A) Bulk enrichment (runs on cron via ingest()): queries recent threats for
 *    unchecked domains and validates them against multi.surbl.org via DNS-over-HTTPS.
 * B) Inline enrichment (exported checkSURBL function): other feeds call this
 *    after inserting a threat for immediate validation.
 *
 * SURBL bitmask decode:
 *   8  = PH (phishing)
 *   16 = MW (malware)
 *   64 = ABUSE (abused/redirector)
 *
 * Rate limit: max 50 DNS lookups per cron run (SURBL fair use).
 * Results cached in KV with 24h TTL to avoid repeat lookups.
 */

export interface SURBLResult {
  listed: boolean;
  types: string[];
  raw: number | null;
}

const SURBL_BITMASK: Record<number, string> = {
  8: "PH",
  16: "MW",
  64: "ABUSE",
};

function decodeSURBLBitmask(lastOctet: number): string[] {
  const types: string[] = [];
  for (const [bit, label] of Object.entries(SURBL_BITMASK)) {
    if (lastOctet & Number(bit)) {
      types.push(label);
    }
  }
  return types;
}

/**
 * Inline SURBL check — call from other feeds for immediate domain validation.
 * Results are cached in KV with 24h TTL.
 */
export async function checkSURBL(domain: string, env: Env): Promise<SURBLResult> {
  // Check KV cache first
  const cacheKey = `surbl:${domain}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as SURBLResult;
  }

  const result = await dnsLookupSURBL(domain);

  // Cache result for 24h
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });

  return result;
}

async function dnsLookupSURBL(domain: string): Promise<SURBLResult> {
  const queryDomain = `${domain}.multi.surbl.org`;
  const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(queryDomain)}&type=A`;

  const res = await fetch(dohUrl, {
    signal: AbortSignal.timeout(30_000), headers: { Accept: "application/dns-json" },
  });

  if (!res.ok) {
    return { listed: false, types: [], raw: null };
  }

  const data = await res.json() as {
    Status: number;
    Answer?: Array<{ data: string }>;
  };

  // Status 3 = NXDOMAIN (not listed)
  if (data.Status === 3 || !data.Answer || data.Answer.length === 0) {
    return { listed: false, types: [], raw: null };
  }

  // Parse the response IP — 127.0.0.X where X is the bitmask
  for (const answer of data.Answer) {
    const ip = answer.data;
    if (ip.startsWith("127.0.0.")) {
      const lastOctet = parseInt(ip.split(".")[3] ?? "0", 10);
      const types = decodeSURBLBitmask(lastOctet);
      return { listed: true, types, raw: lastOctet };
    }
  }

  return { listed: false, types: [], raw: null };
}

/** Map SURBL type to severity escalation threshold */
function surblSeverityFloor(types: string[]): "critical" | "high" | "medium" {
  if (types.includes("PH") || types.includes("MW")) return "high";
  if (types.includes("ABUSE")) return "medium";
  return "medium";
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const surbl: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    // Query recent threats with unchecked domains (last 7 days, limit 200)
    const unchecked = await env.DB.prepare(`
      SELECT DISTINCT malicious_domain FROM threats
      WHERE surbl_checked = 0
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND created_at > datetime('now', '-7 days')
      LIMIT 200
    `).all<{ malicious_domain: string }>();

    const domains = unchecked.results;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    // Rate limit: max 50 DNS lookups per cron run
    const maxLookups = 50;
    const batch = domains.slice(0, maxLookups);

    for (const row of batch) {
      itemsFetched++;
      try {
        const result = await checkSURBL(row.malicious_domain, env);

        if (result.listed) {
          const surblType = result.types.join(",") || "UNKNOWN";
          const severityFloor = surblSeverityFloor(result.types);
          const confidenceBoost = result.types.includes("PH") ? 15 : 10;

          // Update all threats with this domain: set SURBL fields, escalate severity, boost confidence
          await env.DB.prepare(`
            UPDATE threats SET
              surbl_checked = 1,
              surbl_listed = 1,
              surbl_type = ?,
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
            WHERE malicious_domain = ?
          `).bind(
            surblType,
            confidenceBoost,
            SEVERITY_RANK[severityFloor] ?? 2,
            severityFloor,
            row.malicious_domain,
          ).run();

          // Combined escalation: if SURBL listed AND VT already flagged (>= 3 engines), auto-escalate to critical
          await env.DB.prepare(`
            UPDATE threats SET severity = 'critical'
            WHERE malicious_domain = ?
              AND surbl_listed = 1
              AND vt_malicious >= 3
              AND severity != 'critical'
          `).bind(row.malicious_domain).run();

          itemsNew++;
        } else {
          // Mark as checked but clean. Guard on surbl_checked = 0 so we
          // don't rewrite the (often many) sibling threats that share this
          // domain and were already flagged checked on a prior pass —
          // surbl_checked = 1 is terminal, so re-writing them is pure
          // wasted D1 write volume (Phase 2 write-budget cut).
          await env.DB.prepare(`
            UPDATE threats SET surbl_checked = 1
            WHERE malicious_domain = ?
              AND surbl_checked = 0
          `).bind(row.malicious_domain).run();

          itemsDuplicate++; // "duplicate" in the sense of no new finding
        }
      } catch (err) {
        logger.error("surbl_lookup_error", {
          domain: row.malicious_domain,
          error: err instanceof Error ? err.message : String(err),
        });
        itemsError++;
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
