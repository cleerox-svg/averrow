import type { FeedModule, FeedContext, FeedResult } from "./types";

/**
 * Cloudflare Radar Email Security Trends — Daily intelligence feed.
 *
 * Pulls global email threat summaries (spam, spoof, malicious, threat categories)
 * and stores as agent_output intelligence + KV for Trends tab.
 * Schedule: daily (0 6 * * *)
 */

interface RadarSummaryResponse {
  success: boolean;
  result?: {
    summary_0?: Record<string, string>;
    meta?: Record<string, unknown>;
  };
  errors?: Array<{ message: string }>;
}

const EMAIL_ENDPOINTS = [
  { key: "spam", path: "/radar/email/security/summary/spam" },
  { key: "spoof", path: "/radar/email/security/summary/spoof" },
  { key: "malicious", path: "/radar/email/security/summary/malicious" },
  { key: "threat_category", path: "/radar/email/security/summary/threat_category" },
] as const;

export const cloudflare_email: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const token = ctx.env.CF_API_TOKEN;

    if (!token) {
      console.warn("[cf_email] CF_API_TOKEN not configured — skipping");
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    const summaries: Record<string, Record<string, string>> = {};
    let errors = 0;

    for (const ep of EMAIL_ENDPOINTS) {
      try {
        const res = await fetch(`https://api.cloudflare.com/client/v4${ep.path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          console.error(`[cf_email] HTTP ${res.status} for ${ep.key}: ${(await res.text()).slice(0, 200)}`);
          errors++;
          continue;
        }

        const data = await res.json() as RadarSummaryResponse;
        if (data.success && data.result?.summary_0) {
          summaries[ep.key] = data.result.summary_0;
        } else {
          console.warn(`[cf_email] ${ep.key}: no summary_0 in response`);
          errors++;
        }
      } catch (err) {
        console.error(`[cf_email] fetch error for ${ep.key}:`, err);
        errors++;
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    const fetched = EMAIL_ENDPOINTS.length;

    if (Object.keys(summaries).length === 0) {
      console.error("[cf_email] all endpoints failed — no data to store");
      return { itemsFetched: fetched, itemsNew: 0, itemsDuplicate: 0, itemsError: errors };
    }

    // Build human-readable summary for agent_output
    const parts: string[] = [];
    if (summaries.spam) {
      const spamPct = summaries.spam.SPAM ?? summaries.spam.spam;
      if (spamPct) parts.push(`${parseFloat(spamPct).toFixed(1)}% spam`);
    }
    if (summaries.spoof) {
      const spoofPct = summaries.spoof.SPOOF ?? summaries.spoof.spoof;
      if (spoofPct) parts.push(`${parseFloat(spoofPct).toFixed(1)}% spoofed`);
    }
    if (summaries.malicious) {
      const malPct = summaries.malicious.MALICIOUS ?? summaries.malicious.malicious;
      if (malPct) parts.push(`${parseFloat(malPct).toFixed(1)}% malicious`);
    }
    if (summaries.threat_category) {
      const top = Object.entries(summaries.threat_category)
        .sort(([, a], [, b]) => parseFloat(b) - parseFloat(a))
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${parseFloat(v).toFixed(1)}%`);
      if (top.length > 0) parts.push(`top categories: ${top.join(", ")}`);
    }

    const summary = `Cloudflare Email Security: ${parts.join(", ") || "data collected"}`;

    // Store as agent_output intelligence
    try {
      await ctx.env.DB.prepare(
        `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at)
         VALUES (?, 'observer', 'insight', ?, 'info', ?, datetime('now'))`,
      ).bind(
        `cf_email_${new Date().toISOString().slice(0, 10)}`,
        summary,
        JSON.stringify(summaries),
      ).run();
    } catch (err) {
      // Might fail on duplicate key if already ran today — that's fine
      console.warn(`[cf_email] agent_output insert:`, err);
    }

    // Store in KV for Trends tab
    const today = new Date().toISOString().slice(0, 10);
    try {
      await ctx.env.CACHE.put(`cf_email_${today}`, JSON.stringify(summaries), {
        expirationTtl: 90 * 86400, // 90 days
      });
    } catch (err) {
      console.error(`[cf_email] KV put failed:`, err);
    }

    return {
      itemsFetched: fetched,
      itemsNew: 1,
      itemsDuplicate: 0,
      itemsError: errors,
    };
  },
};
