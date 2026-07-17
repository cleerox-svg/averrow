import type { FeedModule, FeedContext, FeedResult } from "./types";
import { diagnosticFetch } from "../lib/feedDiagnostic";

/**
 * CISA Known Exploited Vulnerabilities — Daily catalog.
 * No API key required.
 * Stores the most recent 50 KEVs as insight entries in agent_outputs
 * so the Observer agent can reference them in daily briefings.
 * Schedule: daily at 6 AM UTC.
 */

interface KevEntry {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  shortDescription: string;
  requiredAction: string;
  dueDate: string;
  knownRansomwareCampaignUse: string;
}

export const cisa_kev: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const feedUrl = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

    const res = await diagnosticFetch(ctx.env.DB, "cisa_kev", feedUrl, {
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`CISA KEV HTTP ${res.status}`);

    let body: { title?: string; catalogVersion?: string; vulnerabilities?: KevEntry[] };
    try {
      body = await res.json() as typeof body;
    } catch (jsonErr) {
      console.error(`[cisa_kev] JSON parse error:`, jsonErr);
      throw new Error(`CISA KEV JSON parse failed: ${jsonErr}`);
    }

    const vulns = body.vulnerabilities ?? [];

    // Sort by dateAdded descending, take most recent 50
    const recent = vulns
      .sort((a, b) => (b.dateAdded ?? "").localeCompare(a.dateAdded ?? ""))
      .slice(0, 50);

    // Check what we already stored to avoid duplicates
    const lastDigest = await ctx.env.DB.prepare(
      "SELECT summary FROM agent_outputs WHERE agent_id = 'sentinel' AND type = 'insight' AND summary LIKE 'CISA KEV%' ORDER BY created_at DESC LIMIT 1"
    ).first<{ summary: string }>();

    const newestCve = recent[0]?.cveID ?? "none";
    if (lastDigest?.summary?.includes(newestCve)) {
      return { itemsFetched: recent.length, itemsNew: 0, itemsDuplicate: recent.length, itemsError: 0 };
    }

    // Build summary of recent KEVs
    const ransomwareCount = recent.filter(v => v.knownRansomwareCampaignUse === "Known").length;
    const topEntries = recent.slice(0, 5).map(v =>
      `${v.cveID} — ${v.vendorProject} ${v.product}: ${v.vulnerabilityName}`
    ).join("\n");

    const summary = `CISA KEV Update: ${recent.length} most recent actively exploited vulnerabilities. ` +
      `${ransomwareCount} linked to ransomware campaigns. ` +
      `Most critical:\n${topEntries}`;

    const details = JSON.stringify(recent.map(v => ({
      cve: v.cveID,
      vendor: v.vendorProject,
      product: v.product,
      name: v.vulnerabilityName,
      added: v.dateAdded,
      due: v.dueDate,
      ransomware: v.knownRansomwareCampaignUse,
      description: v.shortDescription,
    })));

    // Use type='insight' — matches agent_outputs CHECK constraint
    const kevId = 'kev_' + Date.now();
    try {
      const insertResult = await ctx.env.DB.prepare(
        "INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at) VALUES (?, 'sentinel', 'insight', ?, 'high', ?, datetime('now'))"
      ).bind(kevId, summary, details).run();
    } catch (insertErr) {
      console.error(`[cisa_kev] INSERT FAILED: ${insertErr}`);
      throw insertErr;
    }

    return { itemsFetched: recent.length, itemsNew: 1, itemsDuplicate: 0, itemsError: 0 };
  },
};
