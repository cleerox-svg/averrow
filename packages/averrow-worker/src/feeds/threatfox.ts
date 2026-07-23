import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId, extractDomain } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";
import { diagnosticFetch } from "../lib/feedDiagnostic";
import { sanitizeIp } from "../lib/sanitizeIp";

/** ThreatFox (abuse.ch) — IOCs: domains, URLs, IPs, hashes */
export const threatfox: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const feedUrl = ctx.feedUrl || "https://threatfox-api.abuse.ch/api/v1/";
    const res = await diagnosticFetch(ctx.env.DB, "threatfox", feedUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Auth-Key": ctx.env.ABUSECH_AUTH_KEY,
      },
      body: JSON.stringify({ query: "get_iocs", days: 1 }),
    });
    if (!res.ok) throw new Error(`ThreatFox HTTP ${res.status}`);

    const rawText = await res.text();
    let data: { query_status: string; data?: Array<{
      id: number; ioc: string; ioc_type: string; threat_type: string;
      malware?: string; confidence_level?: number; tags?: string[];
    }> };
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(`[threatfox] JSON parse error. Body preview: ${rawText.slice(0, 300)}`);
      throw new Error(`ThreatFox JSON parse failed: ${parseErr}`);
    }
    if (data.query_status !== "ok" || !data.data) {
      console.error(`[threatfox] Unexpected response: query_status=${data.query_status}, data length=${data.data?.length ?? "null"}, body preview: ${rawText.slice(0, 300)}`);
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    const items = data.data.slice(0, 500);

    // Build rows: skip hash/unknown IOC types (can't store as domain/url/ip),
    // dedupe within the payload, then bulk insert.
    const seen = new Set<string>();
    const rows: ThreatRow[] = [];
    for (const ioc of items) {
      const iocType = mapIocType(ioc.ioc_type);
      if (iocType === "hash" || iocType === "unknown") continue;
      // Dedup key includes iocType (matches the old KV key + the
      // threatId space), so the same string under two different types
      // isn't collapsed.
      const dedupKey = `${iocType}:${ioc.ioc}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const domain = iocType === "domain" ? ioc.ioc : extractDomain(ioc.ioc);
      const isUrl = iocType === "url";
      const isIp = iocType === "ip";
      const confidence = ioc.confidence_level ?? 50;

      // ThreatFox emits IPs as `1.2.3.4:port` for ioc_type='ip:port'.
      // Strip the port — every downstream consumer parses bare IPv4 only.
      const ipForRow = isIp ? sanitizeIp(ioc.ioc) : null;
      const domainForRow = iocType === "domain" ? domain : isIp ? ipForRow : domain;

      rows.push({
        id: threatId("threatfox", iocType, ioc.ioc),
        source_feed: "threatfox",
        threat_type: mapThreatType(ioc.threat_type),
        malicious_url: isUrl ? ioc.ioc : null,
        malicious_domain: domainForRow,
        ip_address: ipForRow,
        ioc_value: ioc.ioc,
        severity: confidenceToSeverity(confidence),
        confidence_score: confidence,
      });
    }

    const { itemsNew, itemsDuplicate, itemsError } = await bulkInsertThreats(ctx.env.DB, rows);
    // itemsFetched = rows we attempted to insert (post hash/unknown skip +
    // dedup), so fetched == new + dup + error holds — consistent with the
    // other bulk-migrated feeds.
    return { itemsFetched: rows.length, itemsNew, itemsDuplicate, itemsError };
  },
};

function mapThreatType(t: string): ThreatRow["threat_type"] {
  if (t === "botnet_cc") return "c2";
  if (t === "payload_delivery") return "malware_distribution";
  return "malware_distribution";
}

function mapIocType(t: string): string {
  if (t.includes("domain")) return "domain";
  if (t.includes("url")) return "url";
  if (t.includes("ip")) return "ip";
  if (t.includes("md5") || t.includes("sha")) return "hash";
  return "unknown";
}

function confidenceToSeverity(c: number): ThreatRow["severity"] {
  if (c >= 90) return "critical";
  if (c >= 70) return "high";
  if (c >= 40) return "medium";
  return "low";
}
