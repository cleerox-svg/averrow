/**
 * TrustBot Agent — Interactive AI threat intelligence copilot.
 * Answers questions about threats, IOCs, and platform status using DB context.
 */

import type { AgentModule, AgentContext, AgentResult } from "../lib/agentRunner";

export const trustbotAgent: AgentModule = {
  name: "trustbot",
  displayName: "TrustBot",
  description: "Interactive AI threat intelligence copilot",
  color: "#60A5FA",
  trigger: "manual",
  requiresApproval: false,
  stallThresholdMinutes: 5,
  parallelMax: 4,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 5_000_000 },
  reads: [
    { kind: "d1_table", name: "feed_schedules" },
    { kind: "d1_table", name: "radar_agent_runs" },
    { kind: "d1_table", name: "threats" },
  ],
  writes: [],
  outputs: [],
  status: "active",
  // TrustBot is a chat utility module — not in agentModules + not on
  // the Agents page. Position is far past the visible range so any
  // accidental render lands at the bottom.
  category: "ops",
  pipelinePosition: 99,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const query = (ctx.input.query as string) ?? "";

    if (!query.trim()) {
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { response: "Please provide a question or query.", context: {} },
      };
    }

    // Gather relevant context based on query keywords
    const context: Record<string, unknown> = {};
    const lowerQuery = query.toLowerCase();

    // Threat overview
    if (lowerQuery.includes("threat") || lowerQuery.includes("overview") || lowerQuery.includes("status") || lowerQuery.includes("summary")) {
      const stats = await ctx.env.DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
           SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) as high,
           SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as unprocessed
         FROM threats WHERE created_at >= datetime('now', '-24 hours')`
      ).first();
      context.threatStats24h = stats;
    }

    // Domain/IP lookup
    if (lowerQuery.includes("domain") || lowerQuery.match(/\b[a-z0-9.-]+\.[a-z]{2,}\b/)) {
      const domainMatch = query.match(/\b([a-z0-9.-]+\.[a-z]{2,})\b/i);
      if (domainMatch) {
        const threats = await ctx.env.DB.prepare(
          "SELECT id, threat_type AS type, title, severity, source, created_at FROM threats WHERE domain = ? ORDER BY created_at DESC LIMIT 10"
        ).bind(domainMatch[1]).all();
        context.domainThreats = { domain: domainMatch[1], threats: threats.results };
      }
    }

    // IP lookup
    if (lowerQuery.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)) {
      const ipMatch = query.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
      if (ipMatch) {
        const threats = await ctx.env.DB.prepare(
          "SELECT id, threat_type AS type, title, severity, source, created_at FROM threats WHERE ip_address = ? ORDER BY created_at DESC LIMIT 10"
        ).bind(ipMatch[1]).all();
        context.ipThreats = { ip: ipMatch[1], threats: threats.results };
      }
    }

    // Recent critical
    if (lowerQuery.includes("critical") || lowerQuery.includes("urgent") || lowerQuery.includes("alert")) {
      const critical = await ctx.env.DB.prepare(
        "SELECT id, title, threat_type AS type, domain, ip_address, source, created_at FROM threats WHERE severity = 'critical' ORDER BY created_at DESC LIMIT 10"
      ).all();
      context.criticalThreats = critical.results;
    }

    // Feed status
    if (lowerQuery.includes("feed") || lowerQuery.includes("ingestion")) {
      const feedStats = await ctx.env.DB.prepare(
        `SELECT COUNT(*) as total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN circuit_open = 1 THEN 1 ELSE 0 END) as circuit_open
         FROM feed_schedules`
      ).first();
      context.feedStats = feedStats;
    }

    // Agent status
    if (lowerQuery.includes("agent") || lowerQuery.includes("bot") || lowerQuery.includes("automation")) {
      const recentRuns = await ctx.env.DB.prepare(
        "SELECT agent_name, status, items_processed, duration_ms, created_at FROM radar_agent_runs ORDER BY created_at DESC LIMIT 10"
      ).all();
      context.recentAgentRuns = recentRuns.results;
    }

    // Build response based on gathered context
    const response = formatBotResponse(query, context);

    return {
      itemsProcessed: 1,
      itemsCreated: 0,
      itemsUpdated: 0,
      output: { response, context, query },
    };
  },
};

function formatBotResponse(query: string, context: Record<string, unknown>): string {
  const parts: string[] = [];

  if (context.threatStats24h) {
    const s = context.threatStats24h as Record<string, number>;
    parts.push(`**Threat Overview (24h):** ${s.total ?? 0} total threats — ${s.critical ?? 0} critical, ${s.high ?? 0} high, ${s.unprocessed ?? 0} unprocessed.`);
  }

  if (context.domainThreats) {
    const d = context.domainThreats as { domain: string; threats: Array<Record<string, unknown>> };
    if (d.threats.length > 0) {
      parts.push(`**Domain ${d.domain}:** ${d.threats.length} threat(s) found.`);
      for (const t of d.threats.slice(0, 3)) {
        parts.push(`- ${t.severity} ${t.type}: ${t.title} (via ${t.source})`);
      }
    } else {
      parts.push(`**Domain ${d.domain}:** No threats found in database.`);
    }
  }

  if (context.ipThreats) {
    const d = context.ipThreats as { ip: string; threats: Array<Record<string, unknown>> };
    if (d.threats.length > 0) {
      parts.push(`**IP ${d.ip}:** ${d.threats.length} threat(s) found.`);
      for (const t of d.threats.slice(0, 3)) {
        parts.push(`- ${t.severity} ${t.type}: ${t.title}`);
      }
    } else {
      parts.push(`**IP ${d.ip}:** No threats found.`);
    }
  }

  if (context.criticalThreats) {
    const threats = context.criticalThreats as Array<Record<string, unknown>>;
    parts.push(`**Critical Threats:** ${threats.length} active.`);
    for (const t of threats.slice(0, 5)) {
      parts.push(`- ${t.title} (${t.type}, from ${t.source})`);
    }
  }

  if (context.feedStats) {
    const f = context.feedStats as Record<string, number>;
    parts.push(`**Feeds:** ${f.active ?? 0}/${f.total ?? 0} active, ${f.circuit_open ?? 0} circuit breakers open.`);
  }

  if (context.recentAgentRuns) {
    const runs = context.recentAgentRuns as Array<Record<string, unknown>>;
    parts.push(`**Recent Agent Runs:** ${runs.length} recent.`);
    for (const r of runs.slice(0, 3)) {
      parts.push(`- ${r.agent_name}: ${r.status} (${r.items_processed} items, ${r.duration_ms ?? "—"}ms)`);
    }
  }

  if (parts.length === 0) {
    parts.push(`I searched the database for context related to your query: "${query}"\n\nNo specific data found. Try asking about:\n- Threat overview/status\n- A specific domain or IP\n- Critical alerts\n- Feed status\n- Agent runs`);
  }

  return parts.join("\n\n");
}
