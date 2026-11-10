/**
 * nrd_hagezi — dedicated `29 *\/2 * * *` cron (owner decision 2026-11-10).
 *
 * Pins:
 *   1. handleScheduled dispatches nrd_hagezi (through
 *      dispatchDedicatedIngestFeed) on the EXACT cron string, and on no
 *      other dedicated cron.
 *   2. The branch sits above the hourly-mesh guard, the orchestrator names
 *      the feed nowhere else, and wrangler declares the trigger on a minute
 *      no other cron uses (cron-audit rule, CLAUDE.md §6: no minute gates in
 *      the dispatch path or the feed).
 *   (runAllFeeds skipping it, and the dispatcher's breaker/timeout
 *   semantics, are in test/feed-run-timeout.test.ts.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";

const dedicatedSpy = vi.fn(async () => undefined);
const enrichmentSpy = vi.fn(async () => undefined);
vi.mock("../src/lib/feedRunner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/feedRunner")>()),
  dispatchDedicatedIngestFeed: (...args: unknown[]) => dedicatedSpy(...(args as [])),
  dispatchEnrichmentFeed: (...args: unknown[]) => enrichmentSpy(...(args as [])),
}));

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const CRON = "29 */2 * * *";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const env = { DB: {}, CACHE: {} } as unknown as Env;

async function fire(cron: string): Promise<void> {
  const { handleScheduled } = await import("../src/cron/orchestrator");
  await handleScheduled(
    { cron, scheduledTime: Date.parse("2026-11-10T04:29:00Z"), type: "scheduled" } as unknown as ScheduledEvent,
    env,
    ctx,
  );
}

describe("nrd_hagezi dedicated cron — dispatch", () => {
  beforeEach(() => {
    dedicatedSpy.mockClear();
    enrichmentSpy.mockClear();
  });

  it("dispatches nrd_hagezi with its feed module on the exact cron string", async () => {
    const { feedModules } = await import("../src/feeds/index");
    await fire(CRON);
    expect(dedicatedSpy).toHaveBeenCalledTimes(1);
    expect(dedicatedSpy).toHaveBeenCalledWith(env, "nrd_hagezi", feedModules["nrd_hagezi"]);
    expect(enrichmentSpy).not.toHaveBeenCalled();
  });

  it("does not dispatch it on another dedicated cron", async () => {
    await fire("21 * * * *"); // seclookup
    expect(dedicatedSpy).not.toHaveBeenCalled();
    expect(enrichmentSpy).toHaveBeenCalledTimes(1);
  });
});

describe("nrd_hagezi dedicated cron — wiring", () => {
  it("exact match above the hourly-mesh guard; the hourly mesh never names the feed", () => {
    const orch = src("../src/cron/orchestrator.ts");
    const branch = orch.indexOf(`if (event.cron === '${CRON}') {`);
    const meshGuard = orch.indexOf("if (event.cron !== '7 * * * *') {");
    expect(branch).toBeGreaterThan(0);
    expect(meshGuard).toBeGreaterThan(branch);
    // Only the dedicated branch references the feed.
    expect(orch.match(/'nrd_hagezi'/g)).toHaveLength(2); // dispatcher arg + feedModules key
    expect(orch.indexOf("'nrd_hagezi'")).toBeGreaterThan(branch);
    expect(orch.lastIndexOf("'nrd_hagezi'")).toBeLessThan(meshGuard);
  });

  it("wrangler declares the trigger on a minute no other cron uses", () => {
    const toml = src("../wrangler.toml");
    const crons = /^crons\s*=\s*\[(.*)\]$/m.exec(toml)?.[1] ?? "";
    const list = [...crons.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(list).toContain(CRON);
    expect(list.filter((c) => c === CRON)).toHaveLength(1);
    const minute29 = list.filter((c) => c.split(" ")[0] === "29");
    expect(minute29).toEqual([CRON]);
    // Cloudflare: 250 cron triggers per account on Workers Paid.
    expect(list.length).toBeLessThanOrEqual(250);
  });

  it("no minute/hour gates in the feed module", () => {
    expect(src("../src/feeds/nrd_hagezi.ts")).not.toMatch(/getUTCMinutes|getMinutes|getUTCHours|minute\s*===|hour\s*===/);
  });
});
