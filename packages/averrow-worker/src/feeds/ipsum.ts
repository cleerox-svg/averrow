import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Only ingest IPs that appear on at least this many source blocklists.
// IPsum's score column is the count of upstream lists flagging the IP;
// a floor of 3 keeps single-list noise out.
const MIN_SCORE = 3;

// Hard cap on IPs processed per pull.
const MAX_ITEMS = 1000;

/**
 * IPsum (stamparm/ipsum) — aggregated bad-IP reputation feed.
 *
 * Source: a single plaintext file that unions 30+ public IP blocklists
 * daily and annotates each IP with a SCORE = how many of those lists
 * flag it. That score is the value-add over the individual blocklists
 * we already ingest: it lets us set a confidence floor.
 *
 * Ingest builds a filtered+deduped ThreatRow[] and flushes via
 * bulkInsertThreats (chunked db.batch) — no per-row KV round-trips.
 *
 * Format: "# comment" header lines, then "IP<whitespace>SCORE" per line.
 * Schedule: daily (the upstream regenerates once per day).
 */
export const ipsum: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.feedUrl) throw new Error("IPsum: feed_configs.source_url is empty");
    const res = await fetch(ctx.feedUrl, {
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
    });
    if (!res.ok) throw new Error(`IPsum HTTP ${res.status}`);

    const text = await res.text();

    const seen = new Set<string>();
    const rows: ThreatRow[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [ip, scoreStr] = line.split(/\s+/);
      if (!ip || !IP_RE.test(ip) || seen.has(ip)) continue;
      const score = parseInt(scoreStr ?? "1", 10);
      if (!Number.isFinite(score) || score < MIN_SCORE) continue;
      seen.add(ip);
      rows.push({
        id: threatId("ipsum", "ip", ip),
        source_feed: "ipsum",
        threat_type: "malicious_ip",
        malicious_url: null,
        malicious_domain: null,
        ip_address: ip,
        // Carry the blocklist count so downstream classifiers see WHY
        // the IP is here (mirrors feodo's "ip (malware)" convention).
        ioc_value: `${ip} (${score} lists)`,
        severity: scoreToSeverity(score),
        confidence_score: Math.min(50 + score * 6, 98),
      });
      if (rows.length >= MAX_ITEMS) break;
    }

    const { itemsNew, itemsDuplicate, itemsError } = await bulkInsertThreats(ctx.env.DB, rows);
    return { itemsFetched: rows.length, itemsNew, itemsDuplicate, itemsError };
  },
};

function scoreToSeverity(score: number): ThreatRow["severity"] {
  if (score >= 8) return "critical";
  if (score >= 5) return "high";
  return "medium";
}
