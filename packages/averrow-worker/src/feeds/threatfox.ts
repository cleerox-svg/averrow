import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";
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

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = data.data.slice(0, 500);

    for (const ioc of items) {
      try {
        const iocType = mapIocType(ioc.ioc_type);
        // Skip hash-type IOCs — they can't be stored as domains/URLs/IPs
        if (iocType === "hash" || iocType === "unknown") continue;
        if (await isDuplicate(ctx.env, iocType, ioc.ioc)) { itemsDuplicate++; continue; }

        const domain = iocType === "domain" ? ioc.ioc : extractDomain(ioc.ioc);
        const isUrl = iocType === "url";
        const isIp = iocType === "ip";
        const confidence = ioc.confidence_level ?? 50;

        // ThreatFox emits IPs as `1.2.3.4:port` for ioc_type='ip:port'.
        // Strip the port — every downstream consumer (ip-api batch,
        // MMDB lookup, NEXUS clustering) parses bare IPv4 only. See
        // lib/sanitizeIp.ts. malicious_domain mirrors the same string
        // when the IOC is IP-shaped, so it gets the same treatment.
        const ipForRow = isIp ? sanitizeIp(ioc.ioc) : null;
        const domainForRow = iocType === "domain"
          ? domain
          : isIp
            ? ipForRow
            : domain;

        await insertThreat(ctx.env.DB, {
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
        await markSeen(ctx.env, iocType, ioc.ioc);
        itemsNew++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[threatfox] insert error for ioc=${ioc.ioc} type=${ioc.ioc_type} threat=${ioc.threat_type}: ${msg}`);
        itemsError++;
        if (itemsError <= 3) {
          console.error(`[threatfox] Full error detail:`, err);
        }
      }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError };
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
