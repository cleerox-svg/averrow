import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";
import { diagnosticFetch } from "../lib/feedDiagnostic";

const CSV_BULK_URL = "https://urlhaus.abuse.ch/downloads/csv_recent/";

/**
 * URLhaus (abuse.ch) — Active malware distribution URLs.
 * Uses the CSV bulk download endpoint (GET) instead of the JSON API
 * which returns HTTP 405 on GET requests.
 */
export const urlhaus: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await diagnosticFetch(ctx.env.DB, "urlhaus", CSV_BULK_URL);
    if (!res.ok) throw new Error(`URLhaus HTTP ${res.status}`);

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));

    // CSV columns: id, dateadded, url, url_status, last_online, threat, tags, urlhaus_link, reporter
    const entries: Array<{
      url: string; host: string; url_status: string;
      threat: string; dateadded: string;
    }> = [];

    for (const line of lines) {
      const match = line.match(
        /^"?(\d+)"?,\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)"/,
      );
      if (!match || !match[3]) continue;
      entries.push({
        url: match[3],
        url_status: match[4] ?? "",
        threat: match[6] ?? "malware_download",
        dateadded: match[2] ?? "",
        host: "",
      });
      if (entries.length >= 1000) break;
    }

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;

    for (const entry of entries) {
      try {
        if (await isDuplicate(ctx.env, "url", entry.url)) { itemsDuplicate++; continue; }

        const domain = extractDomain(entry.url);
        const isActive = entry.url_status === "online";

        let host: string;
        try {
          host = new URL(entry.url).hostname;
        } catch {
          host = domain ?? "";
        }
        const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

        await insertThreat(ctx.env.DB, {
          id: threatId("urlhaus", "url", entry.url),
          source_feed: "urlhaus",
          threat_type: "malware_distribution",
          malicious_url: entry.url,
          malicious_domain: domain,
          ip_address: isIp ? host : null,
          ioc_value: entry.url,
          severity: isActive ? "high" : "medium",
          confidence_score: isActive ? 90 : 75,
          status: isActive ? "active" : "down",
        });
        await markSeen(ctx.env, "url", entry.url);
        itemsNew++;
      } catch (err) {
        console.error(`[urlhaus] insert error for url=${entry.url}: ${err instanceof Error ? err.message : err}`);
        itemsError++;
      }
    }

    return { itemsFetched: entries.length, itemsNew, itemsDuplicate, itemsError };
  },
};
