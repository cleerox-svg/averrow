import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * NIST National Vulnerability Database — CVE 2.0 JSON API.
 *
 * https://services.nvd.nist.gov/rest/json/cves/2.0
 *
 * Public, no auth required (NVD documents an optional API key for
 * higher rate limits — without one we get the standard 5-request /
 * 30-second budget which is more than enough at the hourly pull
 * cadence used by every other feed in this directory).
 *
 * Why this complements cisa_kev:
 *   - CISA KEV is the curated "known exploited" subset (~1000 CVEs
 *     total, only the ones actively being weaponized in the wild).
 *   - NVD is the FULL CVE catalog — every published CVE, including
 *     those that may be exploited later. We pull a sliding 24h
 *     window of newly-published CVEs so the correlation surface
 *     covers vulns BEFORE they hit KEV.
 *
 * The CVE rows land in `threats` as `threat_type: 'malicious_ip'`
 * with a `cve:<id>` prefix in ioc_value. We don't try to map every
 * CVE to a real IOC (most CVEs don't carry indicators); the value
 * is in the cross-table JOIN — when an incoming threat is later
 * tagged with a CVE reference, this corpus lets us answer
 * "what's the CVSS score?" without a fresh NVD round-trip.
 */
const NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const PUBLISHED_WINDOW_HOURS = 24;
const PAGE_LIMIT = 2000;

interface NvdResponse {
  resultsPerPage?: number;
  startIndex?: number;
  totalResults?: number;
  vulnerabilities?: Array<{
    cve?: NvdCve;
  }>;
}

interface NvdCve {
  id: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  descriptions?: Array<{ lang: string; value: string }>;
  metrics?: {
    cvssMetricV31?: Array<{
      cvssData?: { baseScore?: number; baseSeverity?: string };
    }>;
    cvssMetricV30?: Array<{
      cvssData?: { baseScore?: number; baseSeverity?: string };
    }>;
    cvssMetricV2?: Array<{
      cvssData?: { baseScore?: number; baseSeverity?: string };
    }>;
  };
  references?: Array<{ url?: string }>;
}

function cvssToSeverity(score: number | undefined): "critical" | "high" | "medium" | "low" | "info" {
  if (score === undefined || score === null) return "info";
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  return "low";
}

function extractCvss(cve: NvdCve): number | undefined {
  const v31 = cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore;
  if (typeof v31 === "number") return v31;
  const v30 = cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseScore;
  if (typeof v30 === "number") return v30;
  const v2 = cve.metrics?.cvssMetricV2?.[0]?.cvssData?.baseScore;
  if (typeof v2 === "number") return v2;
  return undefined;
}

function isoNow(): string {
  return new Date().toISOString();
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

export const nvd_cve: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const pubStart = isoHoursAgo(PUBLISHED_WINDOW_HOURS);
    const pubEnd = isoNow();
    const params = new URLSearchParams({
      pubStartDate: pubStart,
      pubEndDate: pubEnd,
      resultsPerPage: String(PAGE_LIMIT),
    });
    const url = (ctx.feedUrl || NVD_API) + "?" + params.toString();

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Averrow-ThreatIntel/1.0",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`NVD HTTP ${res.status}`);

    const body = (await res.json()) as NvdResponse;
    const vulns = body.vulnerabilities ?? [];

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const v of vulns) {
      const cve = v.cve;
      if (!cve?.id) continue;
      itemsFetched++;
      try {
        const cveId = cve.id;
        if (await isDuplicate(ctx.env, "cve", cveId)) {
          itemsDuplicate++;
          continue;
        }

        const cvss = extractCvss(cve);
        const description = cve.descriptions?.find((d) => d.lang === "en")?.value ?? null;
        const confidence = typeof cvss === "number" ? Math.min(95, Math.round(cvss * 10)) : 70;

        await insertThreat(ctx.env.DB, {
          id: threatId("nvd_cve", "cve", cveId),
          source_feed: "nvd_cve",
          // CVEs aren't IPs/URLs/domains. We tag them as malicious_ip
          // as the closest enum value to "infrastructure-class
          // signal" — the real value is the JOIN against threats
          // that reference this CVE elsewhere.
          threat_type: "malicious_ip",
          malicious_url: null,
          malicious_domain: null,
          ip_address: null,
          ioc_value: JSON.stringify({
            cve: cveId,
            cvss,
            severity_band: cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity
              ?? cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseSeverity
              ?? cve.metrics?.cvssMetricV2?.[0]?.cvssData?.baseSeverity
              ?? null,
            published: cve.published,
            description: description ? description.slice(0, 500) : null,
            references: (cve.references ?? []).slice(0, 5).map((r) => r.url).filter(Boolean),
          }),
          severity: cvssToSeverity(cvss),
          confidence_score: confidence,
          status: "active",
        });
        await markSeen(ctx.env, "cve", cveId);
        itemsNew++;
      } catch (err) {
        itemsError++;
        console.error(`[nvd_cve] insert error for ${cve.id}:`, err);
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
