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
//   AVERROW_INTERNAL_SECRET  — authenticates diagnostics/agent-trigger calls
//                              against averrow.com /api/internal/* routes
//   AVERROW_PREVIEW_SECRET   — authenticates the service-JWT mint call
//                              (/api/internal/auth/mint-service-jwt). Separated
//                              from the internal secret in Phase 1 PR-A: the
//                              mint endpoints now require this grant with NO
//                              fallback to AVERROW_INTERNAL_SECRET. Provision
//                              the SAME value on the averrow worker and here.
//   MCP_AUTH_TOKEN            — authenticates Claude Code with this MCP server
//
// The UI verification tools auto-mint a 90-day service-account JWT via
// /api/internal/auth/mint-service-jwt (authenticated with AVERROW_PREVIEW_SECRET)
// and cache it in MCP_TOKEN_CACHE KV. First-call latency is ~50ms extra;
// subsequent calls hit the cache. JWT is re-minted automatically when fewer
// than 7 days remain.

interface Env {
  AVERROW_INTERNAL_SECRET: string;
  AVERROW_PREVIEW_SECRET: string;
  MCP_AUTH_TOKEN: string;
  MCP_TOKEN_CACHE: KVNamespace;
}

// Minimal KVNamespace typing — avoids pulling in @cloudflare/workers-types
// just for these two methods.
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

const AVERROW_API = "https://averrow.com";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "averrow-mcp";
const SERVER_VERSION = "1.0.0";

// ─── Auth helpers ───────────────────────────────────────────────
// Constant-time secret comparison (M3, SECURITY_AUDIT_2026-06-10).
// Ported from packages/averrow-worker/src/lib/internal-secret.ts — copied
// here because averrow-mcp is a standalone, dependency-free Worker.
// `!==` short-circuits at the first mismatching byte, leaking the
// matching-prefix length via timing; the XOR loop runs all bytes
// regardless of where the first mismatch sits.

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Constant-time check of an `Authorization: Bearer <secret>` header.
 * Fails closed: returns `false` for an unset secret, a missing header,
 * or any byte mismatch.
 */
function timingSafeBearerEq(
  authHeader: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  if (!authHeader) return false;
  return timingSafeEqual(authHeader, `Bearer ${secret}`);
}

// ─── Tool Definitions ──────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, env: Env) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
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
      return apiGet(`/api/internal/platform-diagnostics?hours=${hours}`, env);
    },
  },
  {
    name: "d1_health",
    description:
      "Database-level D1 health: size (page_count × page_size), per-table " +
      "row counts (top N), index counts (incl. partial), schema version, " +
      "FK enforcement state, applied migrations, sample query latency. " +
      "Optional check_fk runs PRAGMA foreign_key_check for orphan-row " +
      "detection (slow). Use when investigating storage growth, query " +
      "slowness, or schema drift.",
    inputSchema: {
      type: "object",
      properties: {
        check_fk: {
          type: "boolean",
          description:
            "Run PRAGMA foreign_key_check (slow — O(rows × FKs)). Default false.",
          default: false,
        },
        top_n: {
          type: "number",
          description: "Number of largest tables to return (default 20, max 50)",
          default: 20,
        },
      },
    },
    handler: async (args, env) => {
      const params = new URLSearchParams();
      if (args.check_fk) params.set("check_fk", "true");
      if (args.top_n != null) params.set("top_n", String(args.top_n));
      const qs = params.toString();
      return apiGet(`/api/internal/d1-health${qs ? `?${qs}` : ""}`, env);
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
      return apiGet(`/api/internal/agents/${name}/health`, env);
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
    name: "geoip_status",
    description:
      "Status of the dedicated GEOIP_DB (MaxMind GeoLite2-City reference data). " +
      "Returns row_count, shadow_row_count (in-progress import), has_shadow_table, " +
      "any_running_refresh, oldest_running_refresh_age_min (>60 = likely stuck), " +
      "and recent_attempts[] (last 5 refresh log rows for pattern-spotting). " +
      "Use this to answer 'is the GeoIP refresh actually doing anything?' without " +
      "poking at SQL by hand.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => {
      return apiGet("/api/internal/geoip-status", env);
    },
  },
  {
    name: "trigger_geoip_refresh",
    description:
      "Trigger the geoip_refresh agent. Polls MaxMind for a new GeoLite2-City " +
      "release; the workflow's skip-if-current step bails fast when live data " +
      "matches the .sha256 fingerprint, so most calls are no-ops (~70 bytes of " +
      "network). Pass forceReload=true to bypass the version guard — needed for " +
      "the initial bootstrap (no source_version yet) or after schema changes. " +
      "Auto-runs Sundays at 02:00 UTC; this tool is for manual triage.",
    inputSchema: {
      type: "object",
      properties: {
        forceReload: {
          type: "boolean",
          description:
            "Bypass the skip-if-current guard. Default false (poll-only). " +
            "Set true for the initial load or to re-import the same release.",
        },
      },
    },
    handler: async (args, env) => {
      const forceReload = (args as { forceReload?: boolean })?.forceReload === true;
      return apiPost("/api/internal/geoip-refresh", env, { forceReload });
    },
  },
  // ── UI Verification (authenticated via MCP_TEST_JWT) ────────
  {
    name: "verify_ui_smoke",
    description:
      "Authenticated platform smoke test. Hits the critical user-context " +
      "endpoints — /api/auth/me, /api/v1/public/stats, /api/dashboard/overview, " +
      "/api/observatory/stats, /api/v1/operations/stats — and runs a baseline " +
      "assertion on each (auth still works, threat counts are non-zero, " +
      "response shape intact). Catches regressions like the cube-empty / " +
      "headline-shows-0 class. Auto-mints + caches a 90-day service-account " +
      "JWT — no manual token setup required. Returns " +
      "{ passed, failed, total, probes[] } with per-probe pass/fail and " +
      "the failure reason.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => {
      // Each probe runs a single GET + a single assertion. Probes
      // run in parallel — no probe blocks any other.
      type Probe = {
        name: string;
        path: string;
        check: (body: unknown) => string | null; // null = pass, string = failure reason
      };
      const probes: Probe[] = [
        {
          name: "auth_check",
          path: "/api/auth/me",
          check: (b) => {
            const email = pluck(b, "data.email") ?? pluck(b, "email");
            return email ? null : "no email returned — JWT invalid/expired";
          },
        },
        {
          name: "public_stats",
          path: "/api/v1/public/stats",
          check: (b) => {
            const total = Number(pluck(b, "data.total_threats"));
            if (!Number.isFinite(total)) return "data.total_threats missing";
            if (total <= 0) return `total_threats=${total} (cube may be empty)`;
            return null;
          },
        },
        {
          name: "dashboard_overview",
          path: "/api/dashboard/overview",
          check: (b) => {
            const success = pluck(b, "success");
            return success === true ? null : `success!=true (body: ${JSON.stringify(b).slice(0, 200)})`;
          },
        },
        {
          name: "observatory_stats",
          path: "/api/observatory/stats?period=7d",
          check: (b) => {
            const mapped = Number(pluck(b, "data.threats_mapped"));
            if (!Number.isFinite(mapped)) return "data.threats_mapped missing";
            if (mapped <= 0) return `threats_mapped=${mapped} (geo cube may be empty)`;
            return null;
          },
        },
        {
          name: "operations_stats",
          path: "/api/v1/operations/stats",
          check: (b) => {
            const success = pluck(b, "success");
            const brands = Number(pluck(b, "data.brands_targeted"));
            if (success !== true) return `success!=true`;
            if (!Number.isFinite(brands) || brands <= 0)
              return `brands_targeted=${brands} (brand cube may be empty)`;
            return null;
          },
        },
      ];

      const results = await Promise.all(
        probes.map(async (p) => {
          const r = await apiUserGet(p.path, env);
          if (!r.ok) {
            return {
              name: p.name,
              path: p.path,
              passed: false,
              status: r.status,
              reason: r.error ?? "request failed",
              body_preview: typeof r.body === "string"
                ? r.body.slice(0, 200)
                : JSON.stringify(r.body).slice(0, 200),
            };
          }
          const failure = p.check(r.body);
          return {
            name: p.name,
            path: p.path,
            passed: failure === null,
            status: r.status,
            reason: failure,
          };
        }),
      );

      const passed = results.filter((r) => r.passed).length;
      return {
        passed,
        failed: results.length - passed,
        total: results.length,
        probes: results,
      };
    },
  },
  {
    name: "assert_endpoint",
    description:
      "Hit any /api/* endpoint with the auto-managed service-account JWT " +
      "and run JSON-path assertions against the response. Each assertion " +
      "is { path, op, value } where path is dot-notation ('data.total_threats'), " +
      "op is one of 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | " +
      "'truthy' | 'is_array' | 'len_gt'. Returns the response body + " +
      "per-assertion pass/fail. Use for ad-hoc UI verification beyond the " +
      "smoke test bundle. Path is restricted to /api/* prefixes for safety.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Endpoint path, must start with /api/ (e.g. '/api/v1/operations/stats'). " +
            "Query strings allowed.",
        },
        assertions: {
          type: "array",
          description:
            "List of assertions. Each: { path: 'data.total_threats', op: 'gt', value: 0 }. " +
            "For 'exists' / 'truthy' / 'is_array', omit value. For 'len_gt', value is the " +
            "minimum array length.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              op: {
                type: "string",
                enum: ["eq", "neq", "gt", "gte", "lt", "lte", "exists", "truthy", "is_array", "len_gt"],
              },
              value: {},
            },
            required: ["path", "op"],
          },
        },
      },
      required: ["path", "assertions"],
    },
    handler: async (args, env) => {
      const path = String(args.path ?? "");
      if (!path.startsWith("/api/")) {
        throw new Error(`path must start with /api/ — got '${path}'`);
      }
      const assertions = (args.assertions ?? []) as Array<{
        path: string;
        op: string;
        value?: unknown;
      }>;

      const r = await apiUserGet(path, env);

      const checks = assertions.map((a) => {
        const actual = pluck(r.body, a.path);
        let passed = false;
        let detail = "";
        switch (a.op) {
          case "eq":
            passed = actual === a.value;
            detail = `actual=${JSON.stringify(actual)}`;
            break;
          case "neq":
            passed = actual !== a.value;
            detail = `actual=${JSON.stringify(actual)}`;
            break;
          case "gt":
            passed = typeof actual === "number" && typeof a.value === "number" && actual > a.value;
            detail = `actual=${actual}`;
            break;
          case "gte":
            passed = typeof actual === "number" && typeof a.value === "number" && actual >= a.value;
            detail = `actual=${actual}`;
            break;
          case "lt":
            passed = typeof actual === "number" && typeof a.value === "number" && actual < a.value;
            detail = `actual=${actual}`;
            break;
          case "lte":
            passed = typeof actual === "number" && typeof a.value === "number" && actual <= a.value;
            detail = `actual=${actual}`;
            break;
          case "exists":
            passed = actual !== undefined && actual !== null;
            detail = `actual=${JSON.stringify(actual)?.slice(0, 60)}`;
            break;
          case "truthy":
            passed = !!actual;
            detail = `actual=${JSON.stringify(actual)?.slice(0, 60)}`;
            break;
          case "is_array":
            passed = Array.isArray(actual);
            detail = `actual_type=${Array.isArray(actual) ? "array" : typeof actual}`;
            break;
          case "len_gt":
            passed =
              Array.isArray(actual) && typeof a.value === "number" && actual.length > a.value;
            detail = `actual_len=${Array.isArray(actual) ? actual.length : "n/a"}`;
            break;
          default:
            passed = false;
            detail = `unknown op '${a.op}'`;
        }
        return { ...a, passed, detail };
      });

      const passed = checks.filter((c) => c.passed).length;
      return {
        endpoint: { path, status: r.status, ok: r.ok, error: r.error },
        body: r.body,
        assertions_passed: passed,
        assertions_failed: checks.length - passed,
        checks,
      };
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
      return apiGet(`/api/internal/agents/${wf}/${id}`, env);
    },
  },
];

// ─── API Helpers ────────────────────────────────────────────────

// ─── Service-account JWT cache ──────────────────────────────────
//
// Pulls a fresh JWT from /api/internal/auth/mint-service-jwt the first
// time a user-context tool runs, then caches the (jwt, expires_at)
// pair in MCP_TOKEN_CACHE KV. Subsequent calls reuse the cache until
// fewer than 7 days remain on the JWT — at which point we proactively
// re-mint to avoid mid-session expiry.
//
// Cache key is fixed because there's only one service account.
// In-memory module cache short-circuits the KV read for repeated calls
// in the same isolate.

const SERVICE_JWT_CACHE_KEY = "service_jwt:v1";
/** Re-mint when fewer than this many seconds remain on the cached JWT. */
const REMINT_THRESHOLD_SECONDS = 60 * 60 * 24 * 7; // 7 days

let inMemoryJwt: { jwt: string; expiresAtMs: number } | null = null;

async function getServiceJwt(env: Env): Promise<string> {
  const nowMs = Date.now();

  // 1. In-memory cache (per isolate, lost on cold start)
  if (inMemoryJwt && inMemoryJwt.expiresAtMs - nowMs > REMINT_THRESHOLD_SECONDS * 1000) {
    return inMemoryJwt.jwt;
  }

  // 2. KV cache (durable across isolates)
  if (env.MCP_TOKEN_CACHE) {
    const raw = await env.MCP_TOKEN_CACHE.get(SERVICE_JWT_CACHE_KEY);
    if (raw) {
      try {
        const cached = JSON.parse(raw) as { jwt: string; expires_at: string };
        const expiresAtMs = new Date(cached.expires_at).getTime();
        if (
          Number.isFinite(expiresAtMs) &&
          expiresAtMs - nowMs > REMINT_THRESHOLD_SECONDS * 1000
        ) {
          inMemoryJwt = { jwt: cached.jwt, expiresAtMs };
          return cached.jwt;
        }
      } catch {
        // Malformed cache entry — fall through to remint.
      }
    }
  }

  // 3. Mint a fresh JWT. Don't cache failures — propagate the error so
  // callers see something meaningful instead of a stale-cache mystery.
  const res = await fetch(`${AVERROW_API}/api/internal/auth/mint-service-jwt`, {
    method: "POST",
    headers: {
      // Mint endpoints require AVERROW_PREVIEW_SECRET (Phase 1 PR-A) — the
      // internal secret is rejected here with no fallback.
      Authorization: `Bearer ${env.AVERROW_PREVIEW_SECRET}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mint-service-jwt failed: HTTP ${res.status}: ${text}`);
  }
  const body = (await res.json()) as {
    success: boolean;
    data?: { jwt: string; expires_at: string };
    error?: string;
  };
  if (!body.success || !body.data) {
    throw new Error(`mint-service-jwt: ${body.error ?? "unexpected response shape"}`);
  }
  const minted = body.data;

  // Persist to KV with TTL slightly shorter than the JWT itself so
  // the entry self-evicts before the JWT expires.
  if (env.MCP_TOKEN_CACHE) {
    const remainingS = Math.floor(
      (new Date(minted.expires_at).getTime() - nowMs) / 1000,
    );
    if (remainingS > 60) {
      await env.MCP_TOKEN_CACHE.put(
        SERVICE_JWT_CACHE_KEY,
        JSON.stringify({ jwt: minted.jwt, expires_at: minted.expires_at }),
        { expirationTtl: Math.max(60, remainingS - 60) },
      );
    }
  }
  inMemoryJwt = { jwt: minted.jwt, expiresAtMs: new Date(minted.expires_at).getTime() };
  return minted.jwt;
}

/**
 * GET an authenticated user-context endpoint with the auto-managed
 * service-account JWT. Distinct from apiGet (which uses
 * AVERROW_INTERNAL_SECRET against /api/internal/* routes) — this hits
 * user-facing /api/* routes the way a browser would.
 *
 * Returns { ok, status, body, error } so callers can branch on
 * status without try/catching every probe in the smoke check.
 */
async function apiUserGet(
  path: string,
  env: Env,
): Promise<{ ok: boolean; status: number; body: unknown; error: string | null }> {
  let jwt: string;
  try {
    jwt = await getServiceJwt(env);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const res = await fetch(`${AVERROW_API}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    });
    let body: unknown = null;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return {
      ok: res.ok,
      status: res.status,
      body,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pluck a value from a nested object using a dot-notation path.
 *   pluck({ data: { total: 5 } }, "data.total") → 5
 *   pluck({ a: [{ x: 1 }] }, "a.0.x") → 1
 * Returns undefined if any segment is missing.
 */
function pluck(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      cur = Number.isFinite(idx) ? cur[idx] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

async function apiGet(path: string, env: Env): Promise<unknown> {
  const res = await fetch(`${AVERROW_API}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.AVERROW_INTERNAL_SECRET}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Averrow API ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPost(path: string, env: Env, body?: unknown): Promise<unknown> {
  const res = await fetch(`${AVERROW_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.AVERROW_INTERNAL_SECRET}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Averrow API ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── MCP Protocol ───────────────────────────────────────────────

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

async function handleMcpRequest(
  req: JsonRpcRequest,
  env: Env
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  // Notifications (no id) — acknowledge silently
  if (req.id === undefined) {
    // notifications/initialized is a common notification from clients
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
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};

      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        return jsonRpcResult(id, {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
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
          content: [{ type: "text", text: `Error: ${message}` }],
        });
      }
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${req.method}`);
  }
}

// ─── Rate limiting ──────────────────────────────────────────────
// Fixed-window, KV-backed limiter on the /mcp entrypoint (SECURITY_AUDIT
// O1). Keyed on CF-Connecting-IP (falls back to a fixed key when absent).
// The bearer gate is the PRIMARY control; this only caps abuse volume, so
// it fails OPEN on any KV error — a KV blip must never break diagnostics.
// KV has no atomic increment; a small over-count under concurrency is
// acceptable for a coarse ceiling this far above legitimate tool use.
const MCP_RATE_LIMIT_PER_MIN = 120;

async function isRateLimited(request: Request, env: Env): Promise<boolean> {
  try {
    if (!env.MCP_TOKEN_CACHE) return false;
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const windowMinute = Math.floor(Date.now() / 60000);
    const key = `ratelimit:mcp:${ip}:${windowMinute}`;
    const raw = await env.MCP_TOKEN_CACHE.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (Number.isFinite(count) && count >= MCP_RATE_LIMIT_PER_MIN) {
      return true;
    }
    // Bump the counter. TTL of 120s covers the 60s window plus clock skew;
    // stale windows self-evict.
    await env.MCP_TOKEN_CACHE.put(key, String(count + 1), { expirationTtl: 120 });
    return false;
  } catch {
    // Fail open — the bearer check already rejected unauthenticated callers.
    return false;
  }
}

// ─── Worker Entry Point ─────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

      // Rate-limit AFTER the bearer check (unauthenticated noise is rejected
      // first) but before dispatching the tool. SECURITY_AUDIT O1.
      if (await isRateLimited(request, env)) {
        return Response.json(
          jsonRpcError(null, -32000, "Rate limit exceeded"),
          { status: 429, headers: corsHeaders() },
        );
      }

      // Parse JSON-RPC
      let body: JsonRpcRequest | JsonRpcRequest[];
      try {
        body = await request.json() as JsonRpcRequest | JsonRpcRequest[];
      } catch {
        return Response.json(
          jsonRpcError(null, -32700, "Parse error"),
          { status: 400, headers: corsHeaders() }
        );
      }

      // Handle batch or single request
      if (Array.isArray(body)) {
        const results = await Promise.all(
          body.map((req) => handleMcpRequest(req, env))
        );
        const responses = results.filter((r): r is JsonRpcResponse => r !== null);
        if (responses.length === 0) {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }
        return Response.json(responses, { headers: corsHeaders() });
      }

      const result = await handleMcpRequest(body, env);
      if (result === null) {
        // Notification — no response needed
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      return Response.json(result, { headers: corsHeaders() });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// L3 (SECURITY_AUDIT_2026-06-10): this is a machine-to-machine MCP
// endpoint — no browser clients exist, so we emit NO
// Access-Control-Allow-Origin header at all (previously this reflected
// the request Origin, granting any site cross-origin read access).
// OPTIONS is still answered (204 + Allow) for client compatibility.
function corsHeaders(): Record<string, string> {
  return {
    "Allow": "POST, GET, OPTIONS",
    "Content-Type": "application/json",
  };
}
