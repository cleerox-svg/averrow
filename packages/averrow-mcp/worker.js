// ─── Averrow MCP Server ─────────────────────────────────────────
//
// A lightweight Cloudflare Worker that implements the MCP Streamable
// HTTP transport, proxying authenticated requests to the Averrow
// platform API. Gives Claude Code direct operational access to
// platform diagnostics, feed health, agent status, and triggers.
//
// MCP spec: https://modelcontextprotocol.io/specification/2025-03-26
//
// Required secrets (set via CF Dashboard → Worker → Settings → Variables):
//   AVERROW_INTERNAL_SECRET  — authenticates with averrow.com internal API
//   MCP_AUTH_TOKEN            — authenticates Claude Code with this MCP server

const AVERROW_API = "https://averrow.com";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "averrow-mcp";
const SERVER_VERSION = "1.0.0";

// ─── Auth helpers ───────────────────────────────────────────────
// Constant-time secret comparison (M3, SECURITY_AUDIT_2026-06-10).
// Mirrors packages/averrow-mcp/src/index.ts (ported from
// packages/averrow-worker/src/lib/internal-secret.ts). `!==` short-circuits
// at the first mismatching byte, leaking the matching-prefix length via
// timing; the XOR loop runs all bytes regardless of where the first
// mismatch sits.

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Constant-time check of an `Authorization: Bearer <secret>` header.
// Fails closed: returns false for an unset secret, a missing header,
// or any byte mismatch.
function timingSafeBearerEq(authHeader, secret) {
  if (!secret) return false;
  if (!authHeader) return false;
  return timingSafeEqual(authHeader, "Bearer " + secret);
}

// ─── Tool Definitions ──────────────────────────────────────────

const TOOLS = [
  // ── Diagnostics & Health ────────────────────────────────────
  {
    name: "platform_diagnostics",
    description:
      "Comprehensive platform health check. Returns enrichment pipeline state " +
      "(stuck pile, cartographer queue, enrichment throughput), per-feed failure " +
      "rates with auto-pause risk, per-agent run counts with stall detection, " +
      "backlog trends, AI spend, and cron health. This is the primary diagnostic tool.",
    inputSchema: {
      type: "object",
      properties: {
        hours: {
          type: "number",
          description: "Lookback window in hours (default 6, max 48)",
          default: 6,
        },
      },
    },
    handler: async (args, env) => {
      const hours = Math.min(Number(args.hours) || 6, 48);
      return apiGet("/api/internal/platform-diagnostics?hours=" + hours, env);
    },
  },
  {
    name: "system_health",
    description:
      "High-level system health: total threats (today/week), agent run success/error " +
      "counts (24h), feed pull totals, active sessions, migration info, 14-day threat trend.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => apiGet("/api/internal/system-health", env),
  },
  {
    name: "pipeline_status",
    description:
      "Per-pipeline backlog counts with trend direction (up/down/flat), owning agent, " +
      "last run time. Covers: cartographer, analyst, DNS resolution, brand enrichment, " +
      "SURBL, VirusTotal, Safe Browsing, Spamhaus DBL, AbuseIPDB, Passive DNS, " +
      "GreyNoise, SecLookup. Pre-computed from backlog_history — fast and cheap.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => apiGet("/api/internal/pipeline-status", env),
  },
  {
    name: "admin_stats",
    description:
      "Platform statistics: user counts by role, threat totals (active vs total), " +
      "active sessions, agent backlogs (sentinel, analyst, cartographer, strategist), " +
      "observer last run, AI attribution pending count, brand count.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => apiGet("/api/internal/stats", env),
  },
  {
    name: "agent_health",
    description:
      "24-hour health breakdown for a specific agent. Returns hourly arrays of " +
      "run durations, error counts, and outputs generated. Useful for spotting " +
      "patterns like an agent that fails at specific hours.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description:
            "Agent ID: cartographer, analyst, sentinel, strategist, sparrow, " +
            "observer, pathfinder, flight_control, navigator, nexus, curator, watchdog " +
            "(legacy 'fast_tick' still accepted for historical rows)",
        },
      },
      required: ["agent_name"],
    },
    handler: async (args, env) => {
      const name = String(args.agent_name).replace(/[^a-z0-9_-]/gi, "");
      return apiGet("/api/internal/agents/" + name + "/health", env);
    },
  },

  // ── Budget & AI Spend ───────────────────────────────────────
  {
    name: "budget_status",
    description:
      "Current AI spend status: monthly budget, spend to date, throttle level, " +
      "projected burn rate. Quick snapshot of whether AI costs are on track.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => apiGet("/api/internal/budget/status", env),
  },
  {
    name: "budget_ledger_health",
    description:
      "Detailed AI spend diagnostic: per-agent-id breakdown of calls, tokens, and " +
      "cost over the last 24h. Flags any expected call site that hasn't landed a " +
      "ledger row (indicates a silent regression in AI call attribution).",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => apiGet("/api/internal/budget/ledger-health", env),
  },

  // ── CertStream ──────────────────────────────────────────────
  {
    name: "certstream_stats",
    description:
      "Live CertStream monitor statistics: connection status, certificates processed, " +
      "brand matches found, uptime. Shows if the real-time certificate transparency " +
      "monitor is working.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => apiGet("/api/certstream/stats", env),
  },

  // ── Triggers (write operations) ─────────────────────────────
  {
    name: "trigger_cartographer",
    description:
      "Start a Cartographer backfill workflow (durable, runs outside cron CPU ceiling). " +
      "Processes unenriched threats that have an IP but no geo data. Safe to call " +
      "anytime — runs as a Cloudflare Workflow with automatic retries.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => {
      return apiPost("/api/internal/agents/cartographer/backfill-workflow", env);
    },
  },
  {
    name: "trigger_nexus",
    description:
      "Start a NEXUS correlation workflow. Analyzes threat clusters to identify " +
      "infrastructure patterns and threat actor operations. Runs as a durable " +
      "Cloudflare Workflow. Typically scheduled every 4 hours — manual trigger " +
      "for on-demand correlation.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => {
      return apiPost("/api/internal/agents/nexus/workflow", env);
    },
  },
  {
    name: "trigger_enrichment",
    description:
      "Run all enrichment and social feeds immediately. Triggers SURBL, VirusTotal, " +
      "Safe Browsing, Spamhaus, AbuseIPDB, GreyNoise, SecLookup, and social discovery " +
      "feeds. Returns per-feed results. Use when feeds appear stale or after fixing " +
      "a feed failure.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => {
      return apiPost("/api/debug/run-enrichment", env);
    },
  },
  {
    name: "trigger_briefing",
    description:
      "Generate and send an executive briefing email. Produces an AI-written summary " +
      "of current threat landscape, recent activity, and key metrics. Sends to " +
      "configured recipients.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => {
      return apiPost("/api/internal/briefing/send", env);
    },
  },
  {
    name: "workflow_status",
    description:
      "Check the status of a running Cartographer or NEXUS workflow by instance ID. " +
      "Returns workflow state (running, complete, errored) and progress details.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          enum: ["cartographer", "nexus"],
          description: "Which workflow to check",
        },
        instance_id: {
          type: "string",
          description: "The workflow instance ID returned by the trigger tool",
        },
      },
      required: ["workflow", "instance_id"],
    },
    handler: async (args, env) => {
      const wf = args.workflow === "nexus" ? "nexus/workflow" : "cartographer/backfill-workflow";
      const id = String(args.instance_id).replace(/[^a-z0-9-]/gi, "");
      return apiGet("/api/internal/agents/" + wf + "/" + id, env);
    },
  },
];

// ─── API Helpers ────────────────────────────────────────────────

async function apiGet(path, env) {
  const res = await fetch(AVERROW_API + path, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + env.AVERROW_INTERNAL_SECRET,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Averrow API " + res.status + ": " + text);
  }
  return res.json();
}

async function apiPost(path, env, body) {
  const headers = {
    Authorization: "Bearer " + env.AVERROW_INTERNAL_SECRET,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const res = await fetch(AVERROW_API + path, {
    method: "POST",
    headers: headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Averrow API " + res.status + ": " + text);
  }
  return res.json();
}

// ─── MCP Protocol ───────────────────────────────────────────────

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id: id, result: result };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id, error: { code: code, message: message, data: data } };
}

async function handleMcpRequest(req, env) {
  const id = req.id !== undefined ? req.id : null;

  // Notifications (no id) — acknowledge silently
  if (req.id === undefined) {
    return null;
  }

  switch (req.method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "ping":
      return jsonRpcResult(id, {});

    case "tools/list":
      return jsonRpcResult(id, {
        tools: TOOLS.map(function (t) {
          return {
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          };
        }),
      });

    case "tools/call": {
      const params = req.params || {};
      const toolName = params.name;
      const toolArgs = params.arguments || {};

      const tool = TOOLS.find(function (t) { return t.name === toolName; });
      if (!tool) {
        return jsonRpcResult(id, {
          isError: true,
          content: [{ type: "text", text: "Unknown tool: " + toolName }],
        });
      }

      try {
        const result = await tool.handler(toolArgs, env);
        return jsonRpcResult(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonRpcResult(id, {
          isError: true,
          content: [{ type: "text", text: "Error: " + message }],
        });
      }
    }

    default:
      return jsonRpcError(id, -32601, "Method not found: " + req.method);
  }
}

// ─── Worker Entry Point ─────────────────────────────────────────

// L3 (SECURITY_AUDIT_2026-06-10): this is a machine-to-machine MCP
// endpoint — no browser clients exist, so we emit NO
// Access-Control-Allow-Origin header at all (previously this reflected
// the request Origin, granting any site cross-origin read access).
// OPTIONS is still answered (204 + Allow) for client compatibility.
function corsHeaders() {
  return {
    "Allow": "POST, GET, OPTIONS",
    "Content-Type": "application/json",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Health check (unauthenticated)
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
    }

    // MCP endpoint
    if (url.pathname === "/mcp" && request.method === "POST") {
      // Authenticate
      const authHeader = request.headers.get("Authorization");
      if (!timingSafeBearerEq(authHeader, env.MCP_AUTH_TOKEN)) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      }

      // Parse JSON-RPC
      var body;
      try {
        body = await request.json();
      } catch (e) {
        return Response.json(
          jsonRpcError(null, -32700, "Parse error"),
          { status: 400, headers: corsHeaders() }
        );
      }

      // Handle batch or single request
      if (Array.isArray(body)) {
        const results = await Promise.all(
          body.map(function (r) { return handleMcpRequest(r, env); })
        );
        const responses = results.filter(function (r) { return r !== null; });
        if (responses.length === 0) {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }
        return Response.json(responses, { headers: corsHeaders() });
      }

      const result = await handleMcpRequest(body, env);
      if (result === null) {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      return Response.json(result, { headers: corsHeaders() });
    }

    return new Response("Not Found", { status: 404 });
  },
};
