import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** MalwareBazaar — Recent malware samples */
export const malbazaar: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl, {
      method: ctx.method || "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...ctx.headers },
      body: "query=get_recent&selector=time",
    });
    if (!res.ok) throw new Error(`MalBazaar HTTP ${res.status}`);

    const body = await res.json() as {
      query_status: string;
      data?: Array<{
        sha256_hash: string;
        md5_hash?: string;
        sha1_hash?: string;
        file_type?: string;
        file_size?: number;
        signature?: string;
        reporter?: string;
        tags?: string[];
        first_seen?: string;
        delivery_method?: string;
      }>;
    };

    if (body.query_status !== "ok" || !body.data) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0, threatsCreated: 0 };
    }

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = body.data.slice(0, 1000);

    for (const sample of items) {
      try {
        if (await isDuplicate(ctx.env, "hash", sample.sha256_hash)) { itemsDuplicate++; continue; }

        const sig = sample.signature ?? "Unknown";
        const severity = sig.toLowerCase().includes("ransom") ? "critical" : "high";

        await insertThreat(ctx.env.DB, {
          id: threatId("malbazaar", "hash", sample.sha256_hash),
          type: sig.toLowerCase().includes("ransom") ? "ransomware" : "malware",
          title: `MalBazaar: ${sig} — ${sample.sha256_hash.slice(0, 12)}…`,
          description: `Malware sample (${sample.file_type ?? "unknown"}). Signature: ${sig}. SHA256: ${sample.sha256_hash}`,
          severity,
          confidence: 0.92,
          source: "malbazaar",
          source_ref: sample.sha256_hash,
          ioc_type: "hash",
          ioc_value: sample.sha256_hash,
          tags: [
            "malware", ...(sample.tags ?? []).map(t => t.toLowerCase()),
            ...(sample.file_type ? [sample.file_type.toLowerCase()] : []),
          ],
          metadata: {
            md5: sample.md5_hash,
            sha1: sample.sha1_hash,
            file_type: sample.file_type,
            file_size: sample.file_size,
            signature: sample.signature,
            reporter: sample.reporter,
            delivery_method: sample.delivery_method,
            first_seen: sample.first_seen,
          },
          created_by: "malbazaar",
        });
        await markSeen(ctx.env, "hash", sample.sha256_hash);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
