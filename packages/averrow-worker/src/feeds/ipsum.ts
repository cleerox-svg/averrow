import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Only ingest IPs that appear on at least this many source blocklists.
// IPsum's score column is the count of upstream lists flagging the IP;
// a floor of 3 keeps single-list noise out. Every IP below this is
// dropped BEFORE the dedup / insert path, so it costs nothing.
const MIN_SCORE = 3;

// Hard cap on IPs processed per pull. The score>=3 subset is routinely
// several thousand IPs; without a bound the per-row isDuplicate → insert
// → markSeen round-trips can overrun the worker wall-clock budget and get
// reaped (the greynoise/seclookup starvation class, CLAUDE.md §6). Matches
// the migration's batch_size intent and the sibling domain feeds' caps.
const MAX_ITEMS = 1000;

/**
 * IPsum (stamparm/ipsum) — aggregated bad-IP reputation feed.
 *
 * Source: a single plaintext file that unions 30+ public IP blocklists
 * daily and annotates each IP with a SCORE = how many of those lists
 * flag it. That score is the value-add over the individual blocklists
 * we already ingest (dshield / cins_army / blocklist_de / spamhaus_drop):
 * it lets us set a confidence floor instead of treating every listed IP
 * equally. Overlap with those feeds is absorbed by the deterministic
 * threatId PK + KV dedup, so double-counting is a non-issue.
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

    // Build the filtered + capped candidate set up front: valid IPs at or
    // above the score floor, bounded to MAX_ITEMS. Slicing here (rather
    // than inside the insert loop) keeps the per-row work bounded and lets
    // itemsFetched report the true candidate count, like the sibling feeds.
    const candidates: Array<{ ip: string; score: number }> = [];
    for (const line of text.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [ip, scoreStr] = line.split(/\s+/);
      if (!ip || !IP_RE.test(ip)) continue;
      const score = parseInt(scoreStr ?? "1", 10);
      if (!Number.isFinite(score) || score < MIN_SCORE) continue;
      candidates.push({ ip, score });
      if (candidates.length >= MAX_ITEMS) break;
    }

    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const { ip, score } of candidates) {
      try {
        if (await isDuplicate(ctx.env, "ip", ip)) {
          itemsDuplicate++;
          continue;
        }

        // Carry the blocklist count in ioc_value so downstream
        // classifiers can see WHY the IP is here (mirrors feodo's
        // "ip (malware)" convention).
        await insertThreat(ctx.env.DB, {
          id: threatId("ipsum", "ip", ip),
          source_feed: "ipsum",
          threat_type: "malicious_ip",
          malicious_url: null,
          malicious_domain: null,
          ip_address: ip,
          ioc_value: `${ip} (${score} lists)`,
          severity: scoreToSeverity(score),
          confidence_score: Math.min(50 + score * 6, 98),
        });
        await markSeen(ctx.env, "ip", ip);
        itemsNew++;
      } catch (err) {
        console.error(`[ipsum] insert error for ip=${ip}: ${err instanceof Error ? err.message : err}`);
        itemsError++;
      }
    }

    return { itemsFetched: candidates.length, itemsNew, itemsDuplicate, itemsError };
  },
};

function scoreToSeverity(score: number): ThreatRow["severity"] {
  if (score >= 8) return "critical";
  if (score >= 5) return "high";
  return "medium";
}
