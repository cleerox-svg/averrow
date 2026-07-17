import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * Cisco Talos / Snort community IP blocklist.
 *
 * https://www.talosintelligence.com/documents/ip-blacklist
 *
 * The Talos-curated blocklist that powers Snort's community rules.
 * Plain-text, one IP per line, refreshed daily. Free, no auth.
 *
 * Note: this is the FEED-shaped Talos data, not a programmatic
 * reputation API. Cisco does not publish a documented per-IOC
 * reputation API (their web reputation_center lookup is web-UI
 * only). Using the bulk blocklist as a feed avoids any TOS
 * ambiguity around scraping the lookup pages.
 */
const TALOS_IP_BLOCKLIST = "https://www.talosintelligence.com/documents/ip-blacklist";

export const talos_ips: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const url = ctx.feedUrl || TALOS_IP_BLOCKLIST;
    const res = await fetch(url, {
      headers: {
        Accept: "text/plain",
        "User-Agent": "Averrow-ThreatIntel/1.0",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`talos_ips HTTP ${res.status}`);

    const text = await res.text();
    const ips = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      // Talos publishes a flat IP list; tolerate bare values only
      // (header rows, if any, get filtered out by the regex).
      .filter((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l));

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const ip of ips) {
      itemsFetched++;
      try {
        if (await isDuplicate(ctx.env, "ip", ip)) {
          itemsDuplicate++;
          continue;
        }
        await insertThreat(ctx.env.DB, {
          id: threatId("talos_ips", "ip", ip),
          source_feed: "talos_ips",
          threat_type: "malicious_ip",
          malicious_url: null,
          malicious_domain: null,
          ip_address: ip,
          ioc_value: ip,
          severity: "high",
          confidence_score: 80,
          status: "active",
        });
        await markSeen(ctx.env, "ip", ip);
        itemsNew++;
      } catch (err) {
        itemsError++;
        console.error(`[talos_ips] insert error for ${ip}:`, err);
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
