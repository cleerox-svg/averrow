import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * CryptoScamDB — community-maintained scam URL + wallet-address
 * blacklist for crypto / web3 phishing and fake-exchange schemes.
 *
 * https://github.com/CryptoScamDB/blacklist (the source of truth)
 *
 * The repo publishes JSON dumps under /data/urls/*.json and
 * /data/addresses/*.json. We fetch the consolidated URLs dump
 * from the project's mirrored JSON endpoint (no auth, no rate
 * limit beyond GitHub's public CDN). Wallet addresses are
 * intentionally OUT for v1 — our `threats` schema isn't shaped
 * for crypto address IOCs yet; a follow-up can add a dedicated
 * crypto-address column or a JSON wrapper in ioc_value.
 *
 * Brand-protection value: directly relevant to any fintech /
 * exchange customer (Crypto.com is already in our catalog).
 * Complementary to PhishTank / OpenPhish — those catalogs have
 * uneven crypto coverage; CryptoScamDB is purpose-built.
 */
const CRYPTOSCAMDB_URLS_RAW =
  "https://raw.githubusercontent.com/CryptoScamDB/blacklist/master/data/urls.json";

interface CryptoScamUrlEntry {
  // The repo shape varies — sometimes flat strings, sometimes
  // objects with metadata. We accept both.
  url?: string;
  name?: string;
  category?: string;
  subcategory?: string;
  description?: string;
  reporter?: string;
}

export const cryptoscamdb: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const url = ctx.feedUrl || CRYPTOSCAMDB_URLS_RAW;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Averrow-ThreatIntel/1.0",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`CryptoScamDB HTTP ${res.status}`);

    // Body is either an array of strings, an array of objects, or
    // an object keyed by URL. Normalize to a list of (url, entry).
    const raw = (await res.json()) as
      | string[]
      | CryptoScamUrlEntry[]
      | Record<string, CryptoScamUrlEntry>;

    const normalized: Array<{ url: string; entry: CryptoScamUrlEntry | null }> = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === "string") {
          normalized.push({ url: item, entry: null });
        } else if (item && typeof item === "object" && typeof item.url === "string") {
          normalized.push({ url: item.url, entry: item });
        }
      }
    } else if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof k === "string" && k.startsWith("http")) {
          normalized.push({ url: k, entry: v });
        } else if (v && typeof v.url === "string") {
          normalized.push({ url: v.url, entry: v });
        }
      }
    }

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const { url: scamUrl, entry } of normalized) {
      itemsFetched++;
      try {
        // Skip if URL is malformed.
        if (!/^https?:\/\//i.test(scamUrl)) continue;

        if (await isDuplicate(ctx.env, "url", scamUrl)) {
          itemsDuplicate++;
          continue;
        }

        // Map category → threat_type / severity. The repo uses
        // categories like 'Phishing', 'Scam', 'Fake ICO', etc.
        const category = (entry?.category ?? "").toLowerCase();
        const subcategory = (entry?.subcategory ?? "").toLowerCase();
        const threatType: "phishing" | "impersonation" | "credential_harvesting" =
          category.includes("phish") || subcategory.includes("phish")
            ? "phishing"
            : category.includes("impersonat") || subcategory.includes("impersonat")
              ? "impersonation"
              : "credential_harvesting";

        // CryptoScamDB entries are community-vetted; treat as
        // high-confidence + high-severity by default. Critical
        // only when explicitly tagged.
        const severity: "critical" | "high" =
          subcategory.includes("drainer") || category.includes("malware") ? "critical" : "high";

        const domain = extractDomain(scamUrl);

        await insertThreat(ctx.env.DB, {
          id: threatId("cryptoscamdb", "url", scamUrl),
          source_feed: "cryptoscamdb",
          threat_type: threatType,
          malicious_url: scamUrl,
          malicious_domain: domain,
          ioc_value: JSON.stringify({
            url: scamUrl,
            name: entry?.name,
            category: entry?.category,
            subcategory: entry?.subcategory,
            description: entry?.description?.slice(0, 300),
            reporter: entry?.reporter,
          }),
          severity,
          confidence_score: 85,
          status: "active",
        });
        await markSeen(ctx.env, "url", scamUrl);
        itemsNew++;
      } catch (err) {
        itemsError++;
        console.error(`[cryptoscamdb] insert error for ${scamUrl}:`, err);
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
