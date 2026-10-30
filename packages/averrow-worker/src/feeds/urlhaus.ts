import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId, extractDomain } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";
import { diagnosticFetch } from "../lib/feedDiagnostic";

// The legacy urlhaus.abuse.ch/downloads/csv_recent/ endpoint now
// returns HTTP 410. abuse.ch moved the exports to the community API,
// which takes the Auth-Key as a path segment rather than a header.
const CSV_EXPORT_BASE = "https://urlhaus-api.abuse.ch/v2/files/exports";

export function urlhausExportUrl(authKey: string): string {
  return `${CSV_EXPORT_BASE}/${encodeURIComponent(authKey)}/recent.csv`;
}

/**
 * URLhaus (abuse.ch) — Active malware distribution URLs.
 * Pulls the "recent" CSV export (URLs added in the past 30 days).
 * The dump regenerates every 5 minutes — do not fetch more often.
 */
export const urlhaus: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const authKey = ctx.env.ABUSECH_AUTH_KEY;
    if (!authKey) throw new Error("URLhaus: ABUSECH_AUTH_KEY not configured");

    // Shared abuse.ch key (ThreatFox / MalwareBazaar / Feodo / SSLBL).
    // It sits in the URL path, so diagnosticFetch redacts it from logs.
    const res = await diagnosticFetch(
      ctx.env.DB,
      "urlhaus",
      urlhausExportUrl(authKey),
      { headers: { "User-Agent": "Averrow-ThreatIntel/1.0" } },
      authKey,
    );
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
