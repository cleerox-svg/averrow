import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * Disposable Email Domains — Community-maintained list of throwaway email providers.
 * Used to flag account registrations and IOCs associated with spam and account fraud.
 */
export const disposableemails: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`Disposable Emails HTTP ${res.status}`);

    const text = await res.text();
    const domains = text
      .split("\n")
      .map(l => l.trim().toLowerCase())
      .filter(l => l.length > 3 && !l.startsWith("#") && l.includes("."));

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;

    for (const domain of domains) {
      try {
        if (await isDuplicate(ctx.env, "domain", domain)) { itemsDuplicate++; continue; }

        await insertThreat(ctx.env.DB, {
          id: threatId("disposableemails", "domain", domain),
          type: "scam",
          title: `Disposable Email: ${domain}`,
          description: `Domain used for disposable/throwaway email addresses. Associated with spam, account fraud, and low-quality registrations.`,
          severity: "low",
          confidence: 0.95,
          source: "disposableemails",
          source_ref: domain,
          ioc_type: "domain",
          ioc_value: domain,
          domain,
          tags: ["disposable-email", "spam-risk", "account-fraud"],
          metadata: {},
          created_by: "disposableemails",
        });
        await markSeen(ctx.env, "domain", domain);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: domains.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
