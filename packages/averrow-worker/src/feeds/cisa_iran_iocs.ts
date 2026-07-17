import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";
import { diagnosticFetch } from "../lib/feedDiagnostic";

/**
 * CISA Iran IOC Feed — Iranian APT indicators of compromise.
 *
 * Primary source: APT35 IOC GitHub repo (structured JSON with IPs, domains, hashes).
 * Supplements with manually curated IOCs from CISA advisories and ThreatHunter.ai reports.
 *
 * All IOCs tagged with campaign_id 'iran-irgc-2026' and severity 'critical'
 * as they represent known nation-state infrastructure.
 *
 * Schedule: every 6 hours.
 */

interface Apt35Ioc {
  type?: string;       // "ip", "domain", "hash", "url"
  indicator?: string;  // the IOC value
  value?: string;      // alternative key for indicator
  source?: string;
  description?: string;
  tags?: string[];
}

// Manually curated IOCs from recent ThreatHunter.ai and Hunt.io reports
const SEED_IOCS: Array<{ type: "ip" | "domain"; value: string; description: string }> = [
  { type: "ip", value: "157.20.182.49", description: "Iranian ops server (hostname: sdrhi) — ThreatHunter.ai" },
  { type: "ip", value: "38.180.239.161", description: "Dark Scepter C2 on M247 — Hunt.io" },
  { type: "ip", value: "91.132.197.186", description: "APT35 known infrastructure" },
  { type: "ip", value: "104.129.28.18", description: "APT35 known infrastructure" },
];

export const cisa_iran_iocs: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const feedUrl = ctx.feedUrl ||
      "https://raw.githubusercontent.com/JayGLXR/APT35-IOCs/main/IOCs/master_feed.json";

    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;
    let totalFetched = 0;

    // ─── 1. Fetch structured IOCs from GitHub repo ──────────────
    try {
      const res = await diagnosticFetch(ctx.env.DB, "cisa_iran_iocs", feedUrl, {
        headers: {
          "User-Agent": "Averrow-ThreatIntel/1.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      });

      if (res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch (jsonErr) {
          console.error("[cisa_iran_iocs] JSON parse error:", jsonErr);
          body = null;
        }

        // Handle various JSON structures: array of IOCs or object with nested arrays
        const iocs = normalizeIocData(body);

        for (const ioc of iocs) {
          if (totalFetched >= 200) break;

          const iocType = ioc.type?.toLowerCase();
          const iocValue = (ioc.indicator ?? ioc.value ?? "").trim();
          if (!iocValue || iocValue.length < 3) continue;

          // Only process IPs, domains, and URLs
          if (iocType !== "ip" && iocType !== "domain" && iocType !== "url" &&
              iocType !== "ipv4" && iocType !== "ipv6") continue;

          try {
            if (await isDuplicate(ctx.env, iocType, iocValue)) {
              itemsDuplicate++;
              continue;
            }

            const isIp = iocType === "ip" || iocType === "ipv4" || iocType === "ipv6";
            const isDomainType = iocType === "domain";
            const isUrl = iocType === "url";

            await insertThreat(ctx.env.DB, {
              id: threatId("cisa_iran", iocType, iocValue),
              source_feed: "cisa_iran_iocs",
              threat_type: "c2",
              malicious_url: isUrl ? iocValue : null,
              malicious_domain: isDomainType ? iocValue : (isUrl ? extractDomain(iocValue) : null),
              ip_address: isIp ? iocValue : null,
              ioc_value: iocValue,
              severity: "critical",
              confidence_score: 90,
            });
            await markSeen(ctx.env, iocType, iocValue);
            itemsNew++;
            totalFetched++;
          } catch (e) {
            itemsError++;
            if (itemsError <= 5) console.error(`[cisa_iran_iocs] item error:`, e);
          }
        }
      } else {
        console.error(`[cisa_iran_iocs] GitHub feed HTTP ${res.status}`);
        itemsError++;
      }
    } catch (fetchErr) {
      console.error("[cisa_iran_iocs] fetch error:", fetchErr);
      itemsError++;
    }

    // ─── 2. Ingest manually curated seed IOCs ───────────────────
    for (const seed of SEED_IOCS) {
      try {
        if (await isDuplicate(ctx.env, seed.type, seed.value)) {
          itemsDuplicate++;
          continue;
        }

        const isIp = seed.type === "ip";
        await insertThreat(ctx.env.DB, {
          id: threatId("cisa_iran_seed", seed.type, seed.value),
          source_feed: "cisa_iran_iocs",
          threat_type: "c2",
          malicious_url: null,
          malicious_domain: isIp ? null : seed.value,
          ip_address: isIp ? seed.value : null,
          ioc_value: seed.value,
          severity: "critical",
          confidence_score: 95,
        });
        await markSeen(ctx.env, seed.type, seed.value);
        itemsNew++;
        totalFetched++;
      } catch (e) {
        itemsError++;
        console.error(`[cisa_iran_iocs] seed IOC error (${seed.value}):`, e);
      }
    }

    console.log(`[cisa_iran_iocs] Complete: fetched=${totalFetched} new=${itemsNew} dup=${itemsDuplicate} errors=${itemsError}`);
    return { itemsFetched: totalFetched, itemsNew, itemsDuplicate, itemsError };
  },
};

/**
 * Normalize various IOC JSON structures into a flat array of IOC entries.
 * Handles: plain arrays, objects with "indicators"/"iocs"/"data" keys,
 * or nested objects with type-grouped IOCs.
 */
function normalizeIocData(body: unknown): Apt35Ioc[] {
  if (!body) return [];

  // Direct array of IOCs
  if (Array.isArray(body)) return body as Apt35Ioc[];

  if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;

    // Common keys: indicators, iocs, data, results
    for (const key of ["indicators", "iocs", "data", "results", "IOCs"]) {
      if (Array.isArray(obj[key])) return obj[key] as Apt35Ioc[];
    }

    // Type-grouped structure: { ips: [...], domains: [...], urls: [...] }
    const results: Apt35Ioc[] = [];
    for (const [key, val] of Object.entries(obj)) {
      if (!Array.isArray(val)) continue;
      const typeHint = key.toLowerCase();
      let iocType = "unknown";
      if (typeHint.includes("ip")) iocType = "ip";
      else if (typeHint.includes("domain") || typeHint.includes("host")) iocType = "domain";
      else if (typeHint.includes("url")) iocType = "url";
      else if (typeHint.includes("hash") || typeHint.includes("md5") || typeHint.includes("sha")) iocType = "hash";
      else continue;

      for (const item of val) {
        if (typeof item === "string") {
          results.push({ type: iocType, indicator: item });
        } else if (typeof item === "object" && item !== null) {
          results.push({ ...item as Apt35Ioc, type: (item as Apt35Ioc).type ?? iocType });
        }
      }
    }
    if (results.length > 0) return results;
  }

  return [];
}
