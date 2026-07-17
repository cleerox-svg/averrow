import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * VirusTotal — URL/domain threat intelligence (API key required)
 *
 * Premium keys: Uses /intelligence/search for bulk IOC discovery.
 * Free keys: Falls back to checking recently seen malicious domains via
 * individual domain lookups (4 req/min, 500/day quota).
 */
export const virustotal: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.apiKey) throw new Error("VirusTotal requires an API key");

    const headers = {
      "x-apikey": ctx.apiKey,
      Accept: "application/json",
      ...ctx.headers,
    };

    // Try the intelligence search endpoint first (premium)
    const searchUrl = "https://www.virustotal.com/api/v3/intelligence/search?query=" +
      encodeURIComponent("entity:url p:5+ last_analysis_date:1d+") + "&limit=200";

    const res = await fetch(searchUrl, { headers });

    // Premium works — parse intelligence search results
    if (res.ok) {
      return parseUrlResults(ctx, await res.json() as VTSearchResponse);
    }

    // 401/403 could be invalid key OR free-tier hitting premium endpoint
    if (res.status === 401) {
      throw new Error("VirusTotal: Invalid API key (HTTP 401)");
    }
    if (res.status === 429) {
      throw new Error("VirusTotal: API quota exceeded (HTTP 429). Free tier: 4 req/min, 500/day");
    }

    // 403 on intelligence/search = free key; fall back to popular domain checks
    if (res.status === 403) {
      return freeTierFallback(ctx, headers);
    }

    throw new Error(`VirusTotal HTTP ${res.status}`);
  },
};

// ─── Premium: parse /intelligence/search results ─────────────────

interface VTSearchResponse {
  data?: Array<{
    id: string;
    type: string;
    attributes: {
      url?: string;
      last_analysis_stats?: { malicious: number; suspicious: number; harmless: number; undetected: number };
      last_final_url?: string;
      title?: string;
      tags?: string[];
      threat_names?: string[];
      last_http_response_content_sha256?: string;
      last_analysis_date?: number;
    };
  }>;
}

async function parseUrlResults(ctx: FeedContext, body: VTSearchResponse): Promise<FeedResult> {
  let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
  const items = (body.data ?? []).slice(0, 500);

  for (const entry of items) {
    try {
      const attrs = entry.attributes;
      const value = attrs.url ?? entry.id;
      if (await isDuplicate(ctx.env, "url", value)) { itemsDuplicate++; continue; }

      const stats = attrs.last_analysis_stats;
      const malicious = stats?.malicious ?? 0;
      const total = (stats?.malicious ?? 0) + (stats?.suspicious ?? 0) + (stats?.harmless ?? 0) + (stats?.undetected ?? 0);
      const ratio = total > 0 ? malicious / total : 0;

      const severity = ratio > 0.5 ? "critical" : ratio > 0.2 ? "high" : ratio > 0.05 ? "medium" : "low";

      let domain: string | undefined;
      try { domain = new URL(value).hostname; } catch { /* ignore */ }

      await insertThreat(ctx.env.DB, {
        id: threatId("virustotal", "url", value),
        type: "malware",
        title: `VirusTotal: ${domain ?? value.slice(0, 50)} (${malicious}/${total} detections)`,
        description: `VirusTotal scan: ${malicious} engines flagged as malicious out of ${total}.${attrs.threat_names?.length ? ` Threats: ${attrs.threat_names.join(", ")}` : ""}`,
        severity,
        confidence: Math.min(0.5 + ratio, 0.99),
        source: "virustotal",
        source_ref: entry.id,
        ioc_type: "url",
        ioc_value: value,
        domain,
        url: value,
        tags: [
          "virustotal", ...(attrs.tags ?? []).map(t => t.toLowerCase()),
          ...(attrs.threat_names ?? []).map(t => t.toLowerCase()),
        ],
        metadata: {
          analysis_stats: stats,
          title: attrs.title,
          content_sha256: attrs.last_http_response_content_sha256,
          analysis_date: attrs.last_analysis_date,
        },
        created_by: "virustotal",
      });
      await markSeen(ctx.env, "url", value);
      itemsNew++;
    } catch { itemsError++; }
  }

  return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
}

// ─── Free tier: check recent threat IPs/domains from our DB against VT ──

async function freeTierFallback(ctx: FeedContext, headers: Record<string, string>): Promise<FeedResult> {
  // Get recent high-severity threat IPs from our own DB that haven't been enriched by VT yet
  const recent = await ctx.env.DB.prepare(`
    SELECT DISTINCT ip_address FROM threats
    WHERE ip_address IS NOT NULL
      AND severity IN ('critical', 'high')
      AND source != 'virustotal'
      AND ip_address NOT IN (SELECT ioc_value FROM threats WHERE source = 'virustotal' AND ioc_type = 'ip')
    ORDER BY created_at DESC LIMIT 20
  `).all<{ ip_address: string }>();

  const ips = recent.results ?? [];
  let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;

  // Free tier: 4 req/min. Check up to 4 IPs per run to stay within limits.
  const batch = ips.slice(0, 4);

  for (const row of batch) {
    try {
      if (await isDuplicate(ctx.env, "ip", `vt:${row.ip_address}`)) { itemsDuplicate++; continue; }

      const ipRes = await fetch(`https://www.virustotal.com/api/v3/ip_addresses/${row.ip_address}`, { headers });
      if (ipRes.status === 429) break; // quota hit, stop
      if (!ipRes.ok) { itemsError++; continue; }

      const ipBody = await ipRes.json() as {
        data: {
          id: string;
          attributes: {
            last_analysis_stats?: { malicious: number; suspicious: number; harmless: number; undetected: number };
            country?: string;
            as_owner?: string;
            asn?: number;
            network?: string;
            reputation?: number;
            tags?: string[];
          };
        };
      };

      const attrs = ipBody.data.attributes;
      const stats = attrs.last_analysis_stats;
      const malicious = stats?.malicious ?? 0;
      const total = (stats?.malicious ?? 0) + (stats?.suspicious ?? 0) + (stats?.harmless ?? 0) + (stats?.undetected ?? 0);
      const ratio = total > 0 ? malicious / total : 0;

      if (malicious === 0) { itemsDuplicate++; continue; } // not flagged by VT, skip

      const severity = ratio > 0.5 ? "critical" : ratio > 0.2 ? "high" : ratio > 0.05 ? "medium" : "low";

      await insertThreat(ctx.env.DB, {
        id: threatId("virustotal", "ip", row.ip_address),
        type: "reputation",
        title: `VirusTotal: ${row.ip_address} (${malicious}/${total} detections)`,
        description: `VirusTotal IP scan: ${malicious} engines flagged as malicious. ASN: ${attrs.as_owner ?? "N/A"} (${attrs.asn ?? "N/A"})`,
        severity,
        confidence: Math.min(0.5 + ratio, 0.99),
        source: "virustotal",
        source_ref: row.ip_address,
        ioc_type: "ip",
        ioc_value: row.ip_address,
        ip_address: row.ip_address,
        country_code: attrs.country,
        tags: ["virustotal", "ip-reputation", ...(attrs.tags ?? [])],
        metadata: {
          analysis_stats: stats,
          asn: attrs.asn,
          as_owner: attrs.as_owner,
          network: attrs.network,
          vt_reputation: attrs.reputation,
        },
        created_by: "virustotal",
      });
      await markSeen(ctx.env, "ip", `vt:${row.ip_address}`);
      itemsNew++;
    } catch { itemsError++; }
  }

  return { itemsFetched: batch.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
}
