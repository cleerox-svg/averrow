import type { FeedModule, FeedContext, FeedResult } from "./types";
import { diagnosticFetch } from "../lib/feedDiagnostic";
import { agentOutputsStore } from "../db/agent-outputs";
import { byDesc, historyParts, unionFirst } from "../lib/telemetry-read";

/**
 * EPSS — Exploit Prediction Scoring System (FIRST.org).
 *
 * EPSS gives every CVE a daily-updated probability (0–1) that it will
 * be exploited in the wild within the next 30 days. This feed pulls the
 * highest-probability CVEs and stores them as an `insight` row in
 * agent_outputs — the same pattern cisa_kev/nvd_cve use — so the
 * Observer agent can prioritize the vuln signal class by real-world
 * exploitation likelihood rather than CVSS alone. No API key required.
 *
 * Endpoint: https://api.first.org/data/v1/epss?order=!epss&limit=N
 * Response: { status, data: [{ cve, epss, percentile, date }], ... }
 * Schedule: daily.
 */

interface EpssRow {
  cve: string;
  epss: string;        // probability as a string, e.g. "0.97456"
  percentile: string;  // percentile as a string
  date: string;        // scoring date, e.g. "2026-07-22"
}

const TOP_N = 100;

export const epss: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const feedUrl = ctx.feedUrl || `https://api.first.org/data/v1/epss?order=!epss&limit=${TOP_N}`;

    const res = await diagnosticFetch(ctx.env, "epss", feedUrl, {
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`EPSS HTTP ${res.status}`);

    let body: { status?: string; data?: EpssRow[] };
    try {
      body = (await res.json()) as typeof body;
    } catch (jsonErr) {
      console.error(`[epss] JSON parse error:`, jsonErr);
      throw new Error(`EPSS JSON parse failed: ${jsonErr}`);
    }

    const rows = (body.data ?? []).filter((r) => r.cve && r.epss);
    if (rows.length === 0) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // The API is date-stamped; skip if we've already stored today's
    // scoring run (dedup on the scoring date, mirrors cisa_kev's
    // newest-CVE guard).
    const scoreDate = rows[0]?.date ?? "";
    // agent_outputs spans telemetry ∪ core (Track B1 wave 2): the newest
    // digest on EITHER DB counts, or a flip would re-post today's scores.
    const lastDigest = await unionFirst<{ summary: string; created_at: string }>(await historyParts(ctx.env, "agent_outputs"), () => ({
      sql: "SELECT summary, created_at FROM agent_outputs WHERE agent_id = 'sentinel' AND type = 'insight' AND summary LIKE 'EPSS%' ORDER BY created_at DESC LIMIT 1",
      binds: [],
    }), { sort: byDesc<{ summary: string; created_at: string }>("created_at") });
    if (scoreDate && lastDigest?.summary?.includes(scoreDate)) {
      return { itemsFetched: rows.length, itemsNew: 0, itemsDuplicate: rows.length, itemsError: 0 };
    }

    const pct = (v: string) => `${(parseFloat(v) * 100).toFixed(1)}%`;
    const topEntries = rows
      .slice(0, 5)
      .map((r) => `${r.cve} — ${pct(r.epss)} exploit probability (p${(parseFloat(r.percentile) * 100).toFixed(0)})`)
      .join("\n");

    const summary =
      `EPSS Update (${scoreDate}): top ${rows.length} CVEs by exploit-prediction score. ` +
      `Highest exploitation likelihood right now:\n${topEntries}`;

    const details = JSON.stringify(
      rows.map((r) => ({
        cve: r.cve,
        epss: parseFloat(r.epss),
        percentile: parseFloat(r.percentile),
        date: r.date,
      })),
    );

    const epssId = "epss_" + Date.now();
    try {
      await (await agentOutputsStore(ctx.env)).prepare(
        "INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at) VALUES (?, 'sentinel', 'insight', ?, 'high', ?, datetime('now'))",
      ).bind(epssId, summary, details).run();
    } catch (insertErr) {
      console.error(`[epss] INSERT FAILED: ${insertErr}`);
      throw insertErr;
    }

    return { itemsFetched: rows.length, itemsNew: 1, itemsDuplicate: 0, itemsError: 0 };
  },
};
