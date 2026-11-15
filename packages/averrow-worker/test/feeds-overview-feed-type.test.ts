// /api/feeds/overview carries feed_configs.feed_type (migration 0051) so the
// ops Agents Network view can place each feed by role; cache key v2.

import { describe, it, expect } from "vitest";
import { handleFeedsOverview } from "../src/handlers/feeds";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

describe.skipIf(!hasSqlite())("handleFeedsOverview — feed_type", () => {
  it("returns feed_type on every row and caches under feeds_overview:v2", async () => {
    const raw = openMigratedDb();
    raw.prepare(
      "INSERT OR REPLACE INTO feed_configs (feed_name, display_name, enabled, schedule_cron, feed_type) VALUES (?, ?, 1, ?, ?)",
    ).run("zz_social_test", "Social test", "0 * * * *", "social");
    const kv = fakeKv();
    const env = { DB: d1FromSqlite(raw), CACHE: kv } as unknown as Env;

    const res = await handleFeedsOverview(new Request("https://x/api/feeds/overview"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: Array<{ feed_name: string; feed_type: string }> };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) expect(["ingest", "enrichment", "social"]).toContain(row.feed_type);
    expect(body.data.find((r) => r.feed_name === "zz_social_test")!.feed_type).toBe("social");
    expect(kv.store.has("feeds_overview:v2")).toBe(true);
    expect(kv.store.has("feeds_overview:v1")).toBe(false);
  });
});
