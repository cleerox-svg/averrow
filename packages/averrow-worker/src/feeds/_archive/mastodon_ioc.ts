import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** Mastodon Infosec — IOCs from infosec.exchange community */
export const mastodon_ioc: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl, {
      headers: { Accept: "application/json", ...ctx.headers },
    });
    if (!res.ok) throw new Error(`Mastodon IOC HTTP ${res.status}`);

    const data = await res.json() as Array<{
      id: string;
      content: string;
      created_at: string;
      url?: string;
      account?: { acct: string; display_name?: string };
      tags?: Array<{ name: string }>;
    }>;

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = (Array.isArray(data) ? data : []).slice(0, 200);

    // Regex patterns for IOC extraction
    const iocPatterns = {
      ip: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
      domain: /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\[?\.\]?(?:com|net|org|io|xyz|info|ru|cn|top|tk|ml|ga|cf|pw|cc))\b/gi,
      hash: /\b([a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/gi,
    };

    for (const post of items) {
      try {
        // Strip HTML tags from content
        const text = post.content.replace(/<[^>]+>/g, " ").replace(/\[.\]/g, ".").trim();
        const postId = post.id;

        // Extract IOCs from post content
        const iocs: Array<{ type: string; value: string }> = [];
        for (const [type, pattern] of Object.entries(iocPatterns)) {
          for (const match of text.matchAll(pattern)) {
            if (match[1]) iocs.push({ type, value: match[1].replace(/\[.\]/g, ".") });
          }
        }

        if (iocs.length === 0) continue;

        for (const ioc of iocs.slice(0, 10)) {
          if (await isDuplicate(ctx.env, ioc.type, ioc.value)) { itemsDuplicate++; continue; }

          await insertThreat(ctx.env.DB, {
            id: threatId("mastodon_ioc", ioc.type, ioc.value),
            type: "malware",
            title: `Mastodon IOC: ${ioc.value.slice(0, 50)}`,
            description: `IOC extracted from infosec Mastodon post by ${post.account?.acct ?? "unknown"}`,
            severity: "medium",
            confidence: 0.6,
            source: "mastodon_ioc",
            source_ref: post.url ?? postId,
            ioc_type: ioc.type,
            ioc_value: ioc.value,
            domain: ioc.type === "domain" ? ioc.value : undefined,
            ip_address: ioc.type === "ip" ? ioc.value : undefined,
            tags: [
              "mastodon", "osint",
              ...(post.tags?.map(t => t.name.toLowerCase()) ?? []),
            ],
            metadata: {
              author: post.account?.acct,
              post_url: post.url,
              created_at: post.created_at,
            },
            created_by: "mastodon_ioc",
          });
          await markSeen(ctx.env, ioc.type, ioc.value);
          itemsNew++;
        }
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
