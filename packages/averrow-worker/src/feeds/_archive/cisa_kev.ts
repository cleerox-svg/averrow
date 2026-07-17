import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** CISA Known Exploited Vulnerabilities Catalog */
export const cisa_kev: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`CISA KEV HTTP ${res.status}`);

    const data = await res.json() as {
      title?: string;
      catalogVersion?: string;
      vulnerabilities: Array<{
        cveID: string;
        vendorProject: string;
        product: string;
        vulnerabilityName: string;
        shortDescription: string;
        dateAdded: string;
        dueDate: string;
        requiredAction: string;
        knownRansomwareCampaignUse: string;
      }>;
    };

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = data.vulnerabilities.slice(0, 500);

    for (const vuln of items) {
      try {
        if (await isDuplicate(ctx.env, "cve", vuln.cveID)) { itemsDuplicate++; continue; }

        const isRansomware = vuln.knownRansomwareCampaignUse === "Known";
        const severity = isRansomware ? "critical" : "high";

        await insertThreat(ctx.env.DB, {
          id: threatId("cisa_kev", "cve", vuln.cveID),
          type: isRansomware ? "ransomware" : "malware",
          title: `CISA KEV: ${vuln.cveID} — ${vuln.vendorProject} ${vuln.product}`,
          description: vuln.shortDescription,
          severity,
          confidence: 0.99,
          source: "cisa_kev",
          source_ref: vuln.cveID,
          ioc_type: "cve",
          ioc_value: vuln.cveID,
          tags: [
            "kev", "cisa", vuln.vendorProject.toLowerCase(),
            ...(isRansomware ? ["ransomware"] : []),
          ],
          metadata: {
            product: vuln.product,
            date_added: vuln.dateAdded,
            due_date: vuln.dueDate,
            required_action: vuln.requiredAction,
            ransomware_use: vuln.knownRansomwareCampaignUse,
          },
          created_by: "cisa_kev",
        });
        await markSeen(ctx.env, "cve", vuln.cveID);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
