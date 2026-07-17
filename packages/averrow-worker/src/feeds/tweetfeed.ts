import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * TweetFeed.live — IOCs aggregated from 90+ infosec researchers
 * who post on X/Twitter. Refreshed every 15 minutes by the
 * upstream service.
 *
 * https://api.tweetfeed.live/v1/{time}/{type}
 *
 *   time: today / week / month — we pull `today` on the hourly
 *         tick (overlap absorbed by dedup at insertThreat).
 *   type: optional — when omitted, all IOC types are returned.
 *
 * Public REST, no API key, no registration. CSV/JSON/RSS/TXT
 * all expose the same dataset; we choose JSON since it carries
 * the IOC type per row (otherwise we'd have to make three
 * separate requests).
 *
 * Each row shape (per upstream docs):
 *   { date, user, type, value, tags: [...], tweet }
 *
 * type values seen in the wild: url, domain, ip, sha256, md5.
 */
const TWEETFEED_API = "https://api.tweetfeed.live/v1/today";

interface TweetFeedRow {
  date?: string;
  user?: string;
  type?: string;
  value?: string;
  tags?: string[];
  tweet?: string;
}

function severityFromTags(tags: string[] | undefined): "critical" | "high" | "medium" {
  const t = (tags ?? []).map((x) => x.toLowerCase());
  if (t.some((x) => /ransom|c2|apt|stealer/.test(x))) return "critical";
  if (t.some((x) => /malware|trojan|cobalt|emotet|loader/.test(x))) return "high";
  return "high"; // TweetFeed entries are pre-curated; baseline high
}

function typeToThreatType(
  t: string | undefined,
): "phishing" | "malicious_ip" | "malware_distribution" {
  if (t === "url" || t === "domain") return "phishing";
  if (t === "ip") return "malicious_ip";
  return "malware_distribution"; // sha256, md5
}

export const tweetfeed: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const url = ctx.feedUrl || TWEETFEED_API;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Averrow-ThreatIntel/1.0",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`TweetFeed HTTP ${res.status}`);

    const body = (await res.json()) as TweetFeedRow[];
    if (!Array.isArray(body)) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const row of body) {
      if (!row.value || typeof row.value !== "string" || !row.type) continue;
      itemsFetched++;
      try {
        const iocType = row.type.toLowerCase();
        const value = row.value;

        // Pick the dedup key + ThreatRow shape per IOC type.
        let dedupType: string;
        // ThreatRow requires malicious_url + malicious_domain even
        // when null; build the full set explicitly per IOC type so
        // we never end up with undefined fields.
        let row_url: string | null = null;
        let row_domain: string | null = null;
        let row_ip: string | null = null;
        let iocValueForId = value;

        switch (iocType) {
          case "url":
            dedupType = "url";
            row_url = value;
            row_domain = extractDomain(value);
            break;
          case "domain":
            dedupType = "domain";
            row_domain = value.toLowerCase();
            iocValueForId = value.toLowerCase();
            break;
          case "ip":
            dedupType = "ip";
            row_ip = value;
            break;
          case "sha256":
            dedupType = "sha256";
            iocValueForId = `hash:sha-256:${value.toLowerCase()}`;
            break;
          case "md5":
            dedupType = "md5";
            iocValueForId = `hash:md5:${value.toLowerCase()}`;
            break;
          default:
            // Unknown type — count as fetched but skip.
            continue;
        }

        if (await isDuplicate(ctx.env, dedupType, value)) {
          itemsDuplicate++;
          continue;
        }

        const tagsList = Array.isArray(row.tags) ? row.tags : [];

        await insertThreat(ctx.env.DB, {
          id: threatId("tweetfeed", dedupType, iocValueForId),
          source_feed: "tweetfeed",
          threat_type: typeToThreatType(iocType),
          malicious_url: row_url,
          malicious_domain: row_domain,
          ip_address: row_ip,
          // Carry researcher attribution + tags in ioc_value so the
          // analyst agent can pivot back to the original tweet.
          ioc_value: JSON.stringify({
            value,
            type: iocType,
            user: row.user,
            tags: tagsList.slice(0, 10),
          }),
          severity: severityFromTags(tagsList),
          confidence_score: 80,
          status: "active",
        });
        await markSeen(ctx.env, dedupType, value);
        itemsNew++;
      } catch (err) {
        itemsError++;
        console.error("[tweetfeed] insert error:", err);
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
