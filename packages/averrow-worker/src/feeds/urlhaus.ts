import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId, extractDomain } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";
import { diagnosticFetch } from "../lib/feedDiagnostic";

const CSV_BULK_URL = "https://urlhaus.abuse.ch/downloads/csv_recent/";

/**
 * URLhaus (abuse.ch) — Active malware distribution URLs.
 * Uses the CSV bulk download endpoint (GET) instead of the JSON API
 * which returns HTTP 405 on GET requests.
 */
export const urlhaus: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    // abuse.ch is deprecating anonymous access to its download
    // endpoints — send the shared Auth-Key (same secret ThreatFox /
    // MalwareBazaar already use) so this CSV pull keeps working once
    // anonymous pulls are cut off. Harmless while still optional.
    const res = await diagnosticFetch(ctx.env.DB, "urlhaus", CSV_BULK_URL, {
      headers: {
        "Auth-Key": ctx.env.ABUSECH_AUTH_KEY,
        "User-Agent": "Averrow-ThreatIntel/1.0",
      },
    });
    if (!res.ok) throw new Error(`URLhaus HTTP ${res.status}`);

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));

    // CSV columns: id, dateadded, url, url_status, last_online, threat, tags, urlhaus_link, reporter
    // Parse → dedupe within the payload → bulk insert.
    const seen = new Set<string>();
    const rows: ThreatRow[] = [];
    for (const line of lines) {
      const match = line.match(
        /^"?(\d+)"?,\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)"/,
      );
      if (!match || !match[3]) continue;
      const url = match[3];
      if (seen.has(url)) continue;
      seen.add(url);

      const urlStatus = match[4] ?? "";
      const domain = extractDomain(url);
      const isActive = urlStatus === "online";

      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        host = domain ?? "";
      }
      const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

      rows.push({
        id: threatId("urlhaus", "url", url),
        source_feed: "urlhaus",
        threat_type: "malware_distribution",
        malicious_url: url,
        malicious_domain: domain,
        ip_address: isIp ? host : null,
        ioc_value: url,
        severity: isActive ? "high" : "medium",
        confidence_score: isActive ? 90 : 75,
        status: isActive ? "active" : "down",
      });
      if (rows.length >= 1000) break;
    }

    const { itemsNew, itemsDuplicate, itemsError } = await bulkInsertThreats(ctx.env.DB, rows);
    return { itemsFetched: rows.length, itemsNew, itemsDuplicate, itemsError };
  },
};
