import type { FeedModule, FeedContext, FeedResult } from "./types";
import { diagnosticFetch } from "../lib/feedDiagnostic";

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
 * Storage convention (re-architected 2026-06-18, PR for issue tracked
 * in CLAUDE.md §8 — supersedes migration 0173's disable):
 *   A CVE is NOT an IP/URL/domain, so it does NOT belong in the
 *   `threats` table. The original module wrote CVE rows with
 *   threat_type='malicious_ip', which polluted every geo/provider/
 *   severity aggregate. We now mirror feeds/cisa_kev.ts: write a
 *   single aggregated INSIGHT digest to `agent_outputs`
 *   (type='insight') per pull so the Observer agent can reference
 *   recent CVEs in daily briefings, without skewing threat counts.
 *
 * Upstream resilience: NVD's public endpoint is chronically flaky
 * (frequent HTTP 503 + slow responses). A single transient 503 used
 * to throw → trip the per-feed circuit breaker → auto-pause →
 * auto-recover → re-fail loop that spammed operator alerts. We now
 * retry 503/429/network-timeout a few times with backoff before
 * giving up, so a transient blip no longer counts as a feed failure.
 */
const NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const PUBLISHED_WINDOW_HOURS = 24;
const PAGE_LIMIT = 2000;
/** Cap the CVEs we serialize into the digest details so one row stays bounded. */
const DETAILS_LIMIT = 50;
/** Transient-failure retry policy for NVD's flaky endpoint. */
const FETCH_ATTEMPTS = 3;
const FETCH_BACKOFF_MS = [1_000, 3_000]; // delays BETWEEN attempts (n-1 entries)
const FETCH_TIMEOUT_MS = 30_000;

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

type Severity = "critical" | "high" | "medium" | "low" | "info";

function cvssToSeverity(score: number | undefined): Severity {
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

function severityBand(cve: NvdCve): string | null {
  return (
    cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity ??
    cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseSeverity ??
    cve.metrics?.cvssMetricV2?.[0]?.cvssData?.baseSeverity ??
    null
  );
}

function isoNow(): string {
  return new Date().toISOString();
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for failures worth retrying: 5xx, 429, and network/timeout aborts. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetch the NVD page with bounded retry on transient failures. Throws only
 * after exhausting attempts, so the circuit breaker trips on sustained
 * outages but not on a single 503/timeout.
 */
async function fetchNvdWindow(ctx: FeedContext, url: string): Promise<NvdResponse> {
  let lastError = "";
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await diagnosticFetch(ctx.env.DB, "nvd_cve", url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Averrow-ThreatIntel/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        return (await res.json()) as NvdResponse;
      }
      lastError = `NVD HTTP ${res.status}`;
      if (!isTransientStatus(res.status)) {
        // 4xx (other than 429) won't fix itself on retry — fail fast.
        throw new Error(lastError);
      }
    } catch (err) {
      // diagnosticFetch re-throws network/abort errors; AbortSignal.timeout
      // surfaces as a TimeoutError. Treat all of these as transient.
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < FETCH_ATTEMPTS) {
      await sleep(FETCH_BACKOFF_MS[attempt - 1] ?? 3_000);
    }
  }
  throw new Error(`NVD unreachable after ${FETCH_ATTEMPTS} attempts: ${lastError}`);
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

    const body = await fetchNvdWindow(ctx, url);
    const vulns = (body.vulnerabilities ?? [])
      .map((v) => v.cve)
      .filter((c): c is NvdCve => !!c?.id);

    const itemsFetched = vulns.length;
    if (itemsFetched === 0) {
      // Empty window is a legitimate success (a quiet 24h), not a failure.
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Rank by CVSS desc so the digest leads with the most severe CVEs.
    const ranked = [...vulns].sort(
      (a, b) => (extractCvss(b) ?? -1) - (extractCvss(a) ?? -1),
    );

    // Dedup: if the newest-by-publish CVE id already appears in the most
    // recent NVD insight, this window adds nothing — skip the write.
    const newestCve =
      [...vulns].sort((a, b) =>
        (b.published ?? "").localeCompare(a.published ?? ""),
      )[0]?.id ?? "none";

    const lastDigest = await ctx.env.DB.prepare(
      "SELECT summary FROM agent_outputs WHERE agent_id = 'sentinel' AND type = 'insight' AND summary LIKE 'NVD CVE%' ORDER BY created_at DESC LIMIT 1",
    ).first<{ summary: string }>();

    if (lastDigest?.summary?.includes(newestCve)) {
      return { itemsFetched, itemsNew: 0, itemsDuplicate: itemsFetched, itemsError: 0 };
    }

    const counts: Record<Severity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    for (const cve of ranked) {
      counts[cvssToSeverity(extractCvss(cve))]++;
    }

    const topEntries = ranked
      .slice(0, 5)
      .map((cve) => {
        const score = extractCvss(cve);
        const scoreStr = typeof score === "number" ? score.toFixed(1) : "n/a";
        const desc = cve.descriptions?.find((d) => d.lang === "en")?.value ?? "";
        return `${cve.id} (CVSS ${scoreStr}) — ${desc.slice(0, 120)}`;
      })
      .join("\n");

    const summary =
      `NVD CVE Update: ${itemsFetched} CVEs published in the last ${PUBLISHED_WINDOW_HOURS}h ` +
      `(latest ${newestCve}). ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium. ` +
      `Most severe:\n${topEntries}`;

    const details = JSON.stringify(
      ranked.slice(0, DETAILS_LIMIT).map((cve) => ({
        cve: cve.id,
        cvss: extractCvss(cve),
        severity_band: severityBand(cve),
        published: cve.published,
        description:
          cve.descriptions?.find((d) => d.lang === "en")?.value?.slice(0, 500) ?? null,
        references: (cve.references ?? [])
          .slice(0, 5)
          .map((r) => r.url)
          .filter(Boolean),
      })),
    );

    // Digest severity = the worst band present in the window.
    const digestSeverity: Severity =
      counts.critical > 0 ? "critical" :
      counts.high > 0 ? "high" :
      counts.medium > 0 ? "medium" :
      itemsFetched > 0 ? "low" : "info";

    const digestId = "nvd_" + Date.now();
    try {
      await ctx.env.DB.prepare(
        "INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at) VALUES (?, 'sentinel', 'insight', ?, ?, ?, datetime('now'))",
      )
        .bind(digestId, summary, digestSeverity, details)
        .run();
    } catch (insertErr) {
      console.error(`[nvd_cve] INSERT FAILED: ${insertErr}`);
      throw insertErr;
    }

    return { itemsFetched, itemsNew: 1, itemsDuplicate: itemsFetched - 1, itemsError: 0 };
  },
};
