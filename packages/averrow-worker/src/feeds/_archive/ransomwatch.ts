import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** Ransomwatch — Ransomware group leak site monitoring */
export const ransomwatch: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`Ransomwatch HTTP ${res.status}`);

    const data = await res.json() as Array<{
      post_title: string;
      group_name: string;
      discovered: string;
      description?: string;
      website?: string;
      post_url?: string;
    }>;

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = (Array.isArray(data) ? data : []).slice(0, 500);

    for (const post of items) {
      try {
        const key = `${post.group_name}:${post.post_title}`;
        if (await isDuplicate(ctx.env, "domain", key)) { itemsDuplicate++; continue; }

        let domain: string | undefined;
        if (post.website) {
          try { domain = new URL(post.website.startsWith("http") ? post.website : `https://${post.website}`).hostname; } catch {}
        }

        await insertThreat(ctx.env.DB, {
          id: threatId("ransomwatch", "domain", key),
          type: "ransomware",
          title: `Ransomwatch: ${post.group_name} — ${post.post_title.slice(0, 80)}`,
          description: `Ransomware group "${post.group_name}" posted victim: ${post.post_title}`,
          severity: "critical",
          confidence: 0.88,
          source: "ransomwatch",
          source_ref: post.post_url ?? key,
          ioc_type: "domain",
          ioc_value: domain ?? post.post_title,
          domain,
          url: post.post_url,
          tags: ["ransomware", "leak-site", post.group_name.toLowerCase()],
          metadata: {
            group: post.group_name,
            discovered: post.discovered,
            website: post.website,
          },
          created_by: "ransomwatch",
        });
        await markSeen(ctx.env, "domain", key);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
