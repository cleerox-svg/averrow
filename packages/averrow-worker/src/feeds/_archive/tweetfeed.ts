import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** TweetFeed — IOCs shared on Twitter/X by security researchers */
export const tweetfeed: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`TweetFeed HTTP ${res.status}`);

    const text = await res.text();
    const lines = text.split("\n").filter(l => l.trim() && !l.startsWith("#"));

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = lines.slice(0, 500);

    for (const line of items) {
      try {
        // CSV: date,value,type,tags,tweet_url
        const parts = line.split(",");
        if (parts.length < 3) continue;

        const [date, value, iocType, tags, tweetUrl] = parts.map(s => s.trim());
        if (!value || !iocType) continue;

        const normalType = iocType.toLowerCase();
        let feedIocType = "domain";
        if (normalType.includes("ip")) feedIocType = "ip";
        else if (normalType.includes("url")) feedIocType = "url";
        else if (normalType.includes("hash") || normalType.includes("sha") || normalType.includes("md5")) feedIocType = "hash";

        if (await isDuplicate(ctx.env, feedIocType, value)) { itemsDuplicate++; continue; }

        let domain: string | undefined;
        let ip: string | undefined;
        if (feedIocType === "url") { try { domain = new URL(value).hostname; } catch {} }
        if (feedIocType === "ip") ip = value;
        if (feedIocType === "domain") domain = value;

        const tagList = tags ? tags.split("|").map(t => t.trim().toLowerCase()).filter(Boolean) : [];

        await insertThreat(ctx.env.DB, {
          id: threatId("tweetfeed", feedIocType, value),
          type: "malware",
          title: `TweetFeed: ${value.slice(0, 60)}`,
          description: `IOC shared by security researchers on Twitter. Type: ${iocType}`,
          severity: "medium",
          confidence: 0.7,
          source: "tweetfeed",
          source_ref: tweetUrl ?? value,
          ioc_type: feedIocType,
          ioc_value: value,
          domain,
          ip_address: ip,
          url: feedIocType === "url" ? value : undefined,
          tags: ["tweetfeed", "osint", ...tagList],
          metadata: { date, tweet_url: tweetUrl, original_type: iocType },
          created_by: "tweetfeed",
        });
        await markSeen(ctx.env, feedIocType, value);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
