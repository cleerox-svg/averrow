import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * urlscan.io public search feed.
 *
 * https://urlscan.io — every URL submitted to the public scanner
 * becomes a `result` with rendered HTML, screenshot, DOM, verdicts,
 * IP/ASN/country. We query for recently-flagged-malicious public
 * submissions and ingest the URL + page metadata as threats.
 *
 * No auth required for the public-result search (rate-limited to
 * 1000/day anonymous; we pull ~once per hour at SIZE=200 so we stay
 * comfortably under). An API key bumps the limit to 10K/day if we
 * need it later — set `URLSCAN_API_KEY` env var; the feed picks it
 * up automatically.
 *
 * The scan_url + screenshot_url in the response feed directly into
 * Stride 3 of the OSINT plan (visual hashing pipeline). We stash
 * them under `ioc_value` as JSON for the analyst agent to consume.
 */
const URLSCAN_API = "https://urlscan.io/api/v1/search/";
const SIZE = 200;
// Pull "recent + flagged malicious" — kind:phishing is conservative;
// score>=70 catches things urlscan's own heuristics flag without
// requiring a `verdicts.malicious=true` consensus (which is lagging).
const QUERY = "(verdicts.overall.malicious:true OR verdicts.urlscan.score:>=70) AND date:>now-2h";

interface UrlscanResult {
  task?: { url?: string; uuid?: string; visibility?: string; time?: string };
  page?: {
    url?: string;
    domain?: string;
    ip?: string;
    country?: string;
    asn?: string;
    asnname?: string;
  };
  verdicts?: {
    overall?: { score?: number; malicious?: boolean; categories?: string[] };
    urlscan?: { score?: number };
  };
  _id?: string;
  screenshot?: string;
  // urlscan also returns a top-level "stats" with malicious counts;
  // not needed for the threat row.
}

interface UrlscanSearchResponse {
  results?: UrlscanResult[];
  total?: number;
}

function severityFor(score: number | undefined): "critical" | "high" | "medium" | "low" | "info" {
  if (score === undefined || score === null) return "medium";
  if (score >= 90) return "critical";
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function pickThreatType(categories: string[] | undefined): "phishing" | "malware_distribution" | "credential_harvesting" | "impersonation" {
  // urlscan tags include 'phishing', 'malware', 'credentials', 'brand-impersonation'.
  // Map to our enum with a phishing default — that's >90% of urlscan-flagged URLs.
  if (!categories || categories.length === 0) return "phishing";
  const tags = categories.map((c) => c.toLowerCase());
  if (tags.some((t) => t.includes("malware"))) return "malware_distribution";
  if (tags.some((t) => t.includes("credential"))) return "credential_harvesting";
  if (tags.some((t) => t.includes("impersonat") || t.includes("brand"))) return "impersonation";
  return "phishing";
}

export const urlscanio: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const params = new URLSearchParams({ q: QUERY, size: String(SIZE) });
    const url = (ctx.feedUrl || URLSCAN_API) + (ctx.feedUrl?.includes("?") ? "&" : "?") + params.toString();

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Averrow-ThreatIntel/1.0",
    };
    // Use the API key if it's set — bumps the rate limit and unlocks
    // results that anonymous access can't see (private submissions
    // tagged for a partner org). Falls through to anonymous when
    // unset, which is the common case.
    const apiKey = (ctx.env as unknown as { URLSCAN_API_KEY?: string }).URLSCAN_API_KEY;
    if (apiKey) headers["API-Key"] = apiKey;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      // Surface urlscan's response body in the error. A bare status
      // code hides WHY a request was refused — with a valid API key
      // (confirmed via the key's recorded search activity), a 403 here
      // is a per-query rejection (plan-restricted field, search window,
      // or visibility), not an auth failure. urlscan returns a JSON
      // body like {"status":403,"message":"..."} / {"description":"..."}
      // explaining it. Bounded + whitespace-collapsed to keep the
      // feed_status.last_error column small.
      let detail = "";
      try {
        detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 300);
      } catch {
        // body unreadable — fall through with status only
      }
      throw new Error(`urlscan.io HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }

    const body = (await res.json()) as UrlscanSearchResponse;
    const results = body.results ?? [];

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const r of results) {
      const targetUrl = r.task?.url || r.page?.url;
      if (!targetUrl) continue;
      itemsFetched++;

      try {
        if (await isDuplicate(ctx.env, "url", targetUrl)) {
          itemsDuplicate++;
          continue;
        }

        const domain = r.page?.domain?.toLowerCase() || extractDomain(targetUrl);
        const score = r.verdicts?.overall?.score ?? r.verdicts?.urlscan?.score;
        const categories = r.verdicts?.overall?.categories;

        // Pack urlscan-specific metadata into ioc_value so analyst /
        // future visual-hash pipeline can pull the screenshot and
        // pivot off the urlscan _id (which is also a stable scan URL
        // suffix: https://urlscan.io/result/<id>/).
        const iocValue = JSON.stringify({
          url: targetUrl,
          urlscan_id: r._id,
          screenshot: r.screenshot,
        });

        await insertThreat(ctx.env.DB, {
          id: threatId("urlscanio", "url", targetUrl),
          source_feed: "urlscanio",
          threat_type: pickThreatType(categories),
          malicious_url: targetUrl,
          malicious_domain: domain,
          ip_address: r.page?.ip ?? null,
          asn: r.page?.asn ?? null,
          country_code: r.page?.country ?? null,
          ioc_value: iocValue,
          severity: severityFor(score),
          confidence_score: typeof score === "number" ? Math.min(95, Math.max(40, score)) : 60,
          status: "active",
        });
        await markSeen(ctx.env, "url", targetUrl);
        itemsNew++;
      } catch (err) {
        itemsError++;
        console.error(`[urlscanio] insert error for ${targetUrl}:`, err);
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
