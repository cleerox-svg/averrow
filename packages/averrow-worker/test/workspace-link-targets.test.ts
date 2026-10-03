// Pins the worker-side deep links into the ops SPA's workspace `?tab=` URLs
// (ops UI consolidation PR4).
//
//  1. registerPublicRoutes' LEGACY_REDIRECTS: old standalone paths must 302 to
//     the canonical /v2 workspace URL (driven through the REAL router).
//  2. Platform notification templates must deep-link only to URLs the SPA
//     actually serves. Before PR4 they pointed at /admin/agents and
//     /admin/feeds, which 404 inside the SPA.
//  3. Source pins on the agent/feed runner notification links, which are inline
//     string literals inside large side-effecting functions.
//
// The SPA and worker can't import each other, so CANONICAL_* below are an
// explicit allowlist. Each entry was checked against
// packages/averrow-ops/src/lib/workspaceRoutes.ts (WORKSPACE_TABS) and the
// <Route> table in packages/averrow-ops/src/App.tsx. If the SPA moves a
// workspace, update both sides together.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerPublicRoutes } from "../src/routes/public";
import type { Env } from "../src/types";
import * as T from "../src/lib/platform-templates";

// In-app (basename-relative, no /v2) canonical URLs.
const AGENTS = "/admin/operations?tab=agents"; // WORKSPACE_TABS.agents
const FEEDS = "/admin/operations?tab=feeds"; // WORKSPACE_TABS.feeds
const ADMIN = "/admin"; // <Route path="admin"> AdminDashboard
const CANONICAL_PLATFORM_LINKS: readonly string[] = [AGENTS, FEEDS, ADMIN];

function makeRouter(): RouterType<IRequest> {
  const router = Router();
  registerPublicRoutes(router);
  return router;
}

async function get(path: string): Promise<Response> {
  const req = new Request(`https://averrow.com${path}`, { method: "GET" });
  const res = (await makeRouter().fetch(req, {} as Env)) as Response | undefined;
  if (!res) throw new Error(`route did not match: ${path}`);
  return res;
}

describe("legacy standalone paths redirect to workspace tab URLs", () => {
  const CASES: Array<[string, string]> = [
    ["/admin/organizations", "https://averrow.com/v2/admin/customers"],
    ["/admin/feeds", "https://averrow.com/v2/admin/operations?tab=feeds"],
    ["/admin/agent-config", "https://averrow.com/v2/admin/operations?tab=agents"],
    ["/admin/audit", "https://averrow.com/v2/admin/governance?tab=audit"],
    ["/admin/takedowns", "https://averrow.com/v2/console?tab=takedowns"],
    ["/brands", "https://averrow.com/v2/explore?tab=brands"],
    // Unchanged entries guard against collateral damage to the table.
    ["/admin", "https://averrow.com/v2/admin"],
    ["/admin/dashboard", "https://averrow.com/v2/admin"],
    ["/admin/users", "https://averrow.com/v2/admin/users"],
    ["/admin/spam-trap", "https://averrow.com/v2/admin/spam-trap"],
    ["/observatory", "https://averrow.com/v2"],
  ];
  for (const [from, location] of CASES) {
    it(`${from} -> 302 ${location}`, async () => {
      const res = await get(from);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(location);
    });
  }

  it("preserves the request origin (staging/preview hosts)", async () => {
    const req = new Request("https://staging.averrow.com/admin/feeds");
    const res = (await makeRouter().fetch(req, {} as Env)) as Response;
    expect(res.headers.get("Location")).toBe(
      "https://staging.averrow.com/v2/admin/operations?tab=feeds",
    );
  });
});

describe("platform notification templates deep-link to canonical SPA URLs", () => {
  const agentRun = { agent_id: "nexus", run_id: "run_1", minutes_running: 30 };
  const budget = { pct_used: 90, reads_today: 9, daily_limit: 10 };

  const CASES: Array<[string, () => { link: string }, string]> = [
    ["feedAtRisk", () => T.renderPlatformFeedAtRisk({ feed_id: "f", feed_name: "F", pct_to_auto_pause: 70, consecutive_failures: 7, threshold: 10 }), FEEDS],
    ["feedAutoPaused", () => T.renderPlatformFeedAutoPaused({ feed_id: "f", feed_name: "F", consecutive_failures: 10, last_error: null }), FEEDS],
    ["feedSilent", () => T.renderPlatformFeedSilent({ feed_ids: "a,b", feed_count: 2, worst_ratio: 8, worst_feed: "a", worst_hours_since_pull: 10, cause_hint: null }), FEEDS],
    ["agentStalled", () => T.renderPlatformAgentStalled(agentRun), AGENTS],
    ["workerCpuBurst", () => T.renderPlatformWorkerCpuBurst({ ...agentRun, cpu_ms: 40000, ceiling_ms: 30000 }), AGENTS],
    ["geoipStuck", () => T.renderPlatformGeoipRefreshStalled({ refresh_log_id: "g1", minutes_running: 90, source_version: null }), AGENTS],
    ["geoipStale", () => T.renderPlatformGeoipRefreshStalled({ refresh_log_id: "g1", minutes_running: 0, source_version: "v1", kind: "stale", stale_days: 9 }), AGENTS],
    ["workflowDispatchSilent", () => T.renderPlatformWorkflowDispatchSilent({ workflow: "nexus-run", hours_since_last_dispatch: 20, expected_interval_hours: 4, cooldown_active: false }), AGENTS],
    ["cronMissed", () => T.renderPlatformCronMissed({ cron: "orchestrator", expected_interval_minutes: 60, minutes_since_last: 200 }), AGENTS],
    ["enrichmentStuck", () => T.renderPlatformEnrichmentStuck({ stuck_count: 5, threshold: 1 }), AGENTS],
    ["dnsQueueDrift", () => T.renderPlatformDnsQueueDrift({ drift: 9, threshold: 5, queue_size: 10, drainable_in_threats: 1 }), AGENTS],
    ["dnsQueueStalled", () => T.renderPlatformDnsQueueStalled({ minutes_idle: 90, threshold_minutes: 60, queue_size: 10, drainable_in_threats: 5 }), AGENTS],
    ["dnsQueueReaperStalled", () => T.renderPlatformDnsQueueReaperStalled({ hours_since_last_run: 48, threshold_hours: 36, last_stale_removed: null, queue_size: 3 }), AGENTS],
    ["abuseClassifierSilent", () => T.renderPlatformAbuseClassifierSilent({ hours_silent: 5, threshold_hours: 2, pending_count: 3, oldest_pending_hours: 4 }), AGENTS],
    ["aiCallsFailing", () => T.renderPlatformAiCallsFailing({ hours_since_last_call: 5, threshold_hours: 2, min_attempts: 3, failing_agents: [{ agent_id: "analyst", attempted: 4, first_failure_kind: "api_error", first_error: "boom" }] }), AGENTS],
    ["spamTrapSeedingStalled", () => T.renderPlatformSpamTrapSeedingStalled({ days_since_seed: 9, threshold_days: 7 }), AGENTS],
    ["spamTrapCaptureStale", () => T.renderPlatformSpamTrapCaptureStale({ days_since_capture: 9, threshold_days: 7 }), ADMIN],
    ["d1BudgetWarn", () => T.renderPlatformD1BudgetWarn(budget), ADMIN],
    ["d1BudgetBreach", () => T.renderPlatformD1BudgetBreach(budget), ADMIN],
    ["kvBudgetWarn", () => T.renderPlatformKvBudgetWarn(budget), ADMIN],
  ];

  for (const [name, render, expected] of CASES) {
    it(`${name} links to ${expected}`, () => {
      const { link } = render();
      expect(CANONICAL_PLATFORM_LINKS).toContain(link);
      expect(link).toBe(expected);
    });
  }

  it("no template emits the dead /admin/agents or /admin/feeds paths", () => {
    for (const [, render] of CASES) {
      const { link } = render();
      expect(link).not.toMatch(/^\/admin\/(agents|feeds)\b/);
      expect(link).not.toMatch(/^\/(agents|feeds)\b/);
    }
  });
});

describe("runner notification links (source pin)", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf-8");
  const linksIn = (src: string) =>
    [...src.matchAll(/\blink:\s*(["'`])([^"'`]+)\1/g)].map((m) => m[2]);

  it("agentRunner circuit-breaker link is the agents tab", () => {
    const links = linksIn(read("../src/lib/agentRunner.ts"));
    expect(links).toContain(AGENTS);
    expect(links).not.toContain("/admin/agents");
  });

  it("feedRunner feed notifications link to the feeds tab", () => {
    const links = linksIn(read("../src/lib/feedRunner.ts"));
    expect(links.filter((l) => l === FEEDS)).toHaveLength(2);
    expect(links).not.toContain("/admin/feeds");
  });
});
