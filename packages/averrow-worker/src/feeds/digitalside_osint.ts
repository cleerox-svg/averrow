import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * DigitalSide.it OSINT — three plain-text lists of recent malicious
 * IOCs (URLs, IPs, domains), continuously refreshed by the
 * DigitalSide project.
 *
 * Public, no auth required. The same data is also published as
 * MISP/STIX2/CSV, but the .txt lists are the cheapest path for
 * us — one line per IOC, no parser needed beyond split().
 *
 * Endpoints:
 *   https://osint.digitalside.it/Threat-Intel/lists/latesturls.txt
 *   https://osint.digitalside.it/Threat-Intel/lists/latestips.txt
 *   https://osint.digitalside.it/Threat-Intel/lists/latestdomains.txt
 *
 * Pulled together in one module so the feed_configs row count
 * stays low; the module fans out to all three endpoints and
 * accumulates into a single FeedResult.
 */

const ENDPOINTS = {
  urls: "https://osint.digitalside.it/Threat-Intel/lists/latesturls.txt",
  ips: "https://osint.digitalside.it/Threat-Intel/lists/latestips.txt",
  domains: "https://osint.digitalside.it/Threat-Intel/lists/latestdomains.txt",
};

async function fetchList(url: string): Promise<string[]> {
  const res = await fetch(url, {
    headers: {
      Accept: "text/plain",
      "User-Agent": "Averrow-ThreatIntel/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`digitalside_osint HTTP ${res.status} from ${url}`);
  const text = await res.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export const digitalside_osint: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    // URLs — already malicious; threat_type 'phishing' is the
    // broadest default for DigitalSide's URL list (mix of phish
    // + malware drop sites).
    try {
      const urls = await fetchList(ENDPOINTS.urls);
      for (const u of urls) {
        itemsFetched++;
        try {
          if (!u.startsWith("http")) continue;
          if (await isDuplicate(ctx.env, "url", u)) {
            itemsDuplicate++;
            continue;
          }
          await insertThreat(ctx.env.DB, {
            id: threatId("digitalside_osint", "url", u),
            source_feed: "digitalside_osint",
            threat_type: "phishing",
            malicious_url: u,
            malicious_domain: extractDomain(u),
            ioc_value: u,
            severity: "high",
            confidence_score: 80,
            status: "active",
          });
          await markSeen(ctx.env, "url", u);
          itemsNew++;
        } catch (err) {
          itemsError++;
          console.error("[digitalside_osint] url insert error:", err);
        }
      }
    } catch (err) {
      itemsError++;
      console.error("[digitalside_osint] urls fetch failed:", err);
    }

    // IPs — typically C2 / malware-distribution infrastructure.
    try {
      const ips = await fetchList(ENDPOINTS.ips);
      for (const ip of ips) {
        itemsFetched++;
        try {
          // Cheap sanity filter — only accept things that look
          // like dotted-quad or v6 colons.
          if (!/^[\da-f.:]+$/i.test(ip)) continue;
          if (await isDuplicate(ctx.env, "ip", ip)) {
            itemsDuplicate++;
            continue;
          }
          await insertThreat(ctx.env.DB, {
            id: threatId("digitalside_osint", "ip", ip),
            source_feed: "digitalside_osint",
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
          console.error("[digitalside_osint] ip insert error:", err);
        }
      }
    } catch (err) {
      itemsError++;
      console.error("[digitalside_osint] ips fetch failed:", err);
    }

    // Domains.
    try {
      const domains = await fetchList(ENDPOINTS.domains);
      for (const d of domains) {
        itemsFetched++;
        try {
          const dom = d.toLowerCase();
          if (!dom.includes(".") || dom.length < 4) continue;
          if (await isDuplicate(ctx.env, "domain", dom)) {
            itemsDuplicate++;
            continue;
          }
          await insertThreat(ctx.env.DB, {
            id: threatId("digitalside_osint", "domain", dom),
            source_feed: "digitalside_osint",
            threat_type: "phishing",
            malicious_url: null,
            malicious_domain: dom,
            ioc_value: dom,
            severity: "high",
            confidence_score: 80,
            status: "active",
          });
          await markSeen(ctx.env, "domain", dom);
          itemsNew++;
        } catch (err) {
          itemsError++;
          console.error("[digitalside_osint] domain insert error:", err);
        }
      }
    } catch (err) {
      itemsError++;
      console.error("[digitalside_osint] domains fetch failed:", err);
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
