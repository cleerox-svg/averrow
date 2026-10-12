/**
 * Phishing page capture — dedicated `*\/10 * * * *` cron dispatch
 * (docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md), in the style of
 * orchestrator-hour-gate.test.ts / cron-scanner-dispatch.test.ts.
 *
 * The cron-audit hazard specific to this trigger: `*\/10` fires on minutes
 * :00/:10/…/:50, every one of which is ALSO a `*\/5` (Navigator) minute.
 * Cloudflare delivers one scheduled event per matching cron expression, each
 * carrying its own `event.cron` string, so correctness rests on both
 * branches matching by EXACT string — never by minute arithmetic. This
 * suite pins:
 *
 *   1. '*\/10 * * * *' dispatches page_capture ONLY (via executeAgent, with
 *      scheduledTime threaded) — not navigator, not the hourly mesh.
 *   2. '*\/5 * * * *' dispatches navigator ONLY — never page_capture — even
 *      at a minute both crons share.
 *   3. The page_capture branch sits above the `7 * * * *` mesh guard (which
 *      would otherwise swallow it), and wrangler.toml declares the trigger.
 *   4. No minute gate exists in the capture code path.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";

const calls: Array<{ agent: string; input: Record<string, unknown> }> = [];
vi.mock("../src/lib/agentRunner", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/agentRunner")>("../src/lib/agentRunner");
  return {
    ...actual,
    executeAgent: vi.fn(async (_env: unknown, mod: { name: string }, input: Record<string, unknown> = {}) => {
      calls.push({ agent: mod.name, input });
      return { runId: "r", status: "success" as const, result: null };
    }),
  };
});

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
// A DB that throws on use: neither branch may touch D1 directly.
const env = {
  DB: { prepare: () => { throw new Error("unexpected direct D1 access in dispatch"); } },
} as unknown as Env;

function ev(cron: string, iso: string): ScheduledEvent {
  return { cron, scheduledTime: Date.parse(iso), type: "scheduled" } as unknown as ScheduledEvent;
}

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("page_capture dedicated cron dispatch", () => {
  beforeAll(async () => {
    const mod = await import("../src/cron/orchestrator");
    expect(typeof mod.handleScheduled).toBe("function");
  }, 120_000);

  beforeEach(() => {
    calls.length = 0;
  });

  it("'*/10 * * * *' dispatches page_capture only, with scheduledTime", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    await handleScheduled(ev("*/10 * * * *", "2026-10-12T00:10:00Z"), env, ctx);
    expect(calls.map((c) => c.agent)).toEqual(["page_capture"]);
    expect(calls[0]!.input).toEqual({ scheduledTime: "2026-10-12T00:10:00.000Z" });
  });

  it("'*/5 * * * *' at a shared minute dispatches navigator only — never page_capture", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    for (const iso of ["2026-10-12T00:10:00Z", "2026-10-12T00:15:00Z", "2026-10-12T13:00:00Z"]) {
      calls.length = 0;
      await handleScheduled(ev("*/5 * * * *", iso), env, ctx);
      expect(calls.map((c) => c.agent)).toEqual(["navigator"]);
    }
  });

  it("both events at the same minute → each agent exactly once", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    await handleScheduled(ev("*/5 * * * *", "2026-10-12T00:20:00Z"), env, ctx);
    await handleScheduled(ev("*/10 * * * *", "2026-10-12T00:20:00Z"), env, ctx);
    expect(calls.map((c) => c.agent).sort()).toEqual(["navigator", "page_capture"]);
  });

  it("the branch is an exact match above the hourly-mesh guard, and wrangler declares the trigger", () => {
    const orch = src("../src/cron/orchestrator.ts");
    const branch = orch.indexOf("if (event.cron === '*/10 * * * *') {");
    const meshGuard = orch.indexOf("if (event.cron !== '7 * * * *') {");
    expect(branch).toBeGreaterThan(0);
    expect(meshGuard).toBeGreaterThan(branch);
    expect(orch).toContain("event.cron === '*/5 * * * *'");

    const toml = src("../wrangler.toml");
    const crons = /^crons\s*=\s*\[(.*)\]$/m.exec(toml)?.[1] ?? "";
    expect(crons).toContain('"*/10 * * * *"');
    expect(crons).toContain('"*/5 * * * *"');
    expect(toml).toMatch(/^\[browser\]\nbinding = "BROWSER"$/m);
    expect(toml).toMatch(/binding = "PHISH_CAPTURES"\nbucket_name = "averrow-phish-captures"/);
  });

  it("no minute gate anywhere in the capture code path (cron-audit rule)", () => {
    for (const f of ["../src/lib/page-capture.ts", "../src/agents/pageCapture.ts", "../src/lib/page-capture-browser.ts"]) {
      const s = src(f);
      expect(s).not.toMatch(/getUTCMinutes|getMinutes|minute\s*===/);
    }
  });
});
