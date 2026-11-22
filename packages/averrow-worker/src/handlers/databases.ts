// Averrow — Databases page handler
//
// GET /api/databases            (requireStaff — routes/databases.ts)
// GET /api/internal/databases   (AVERROW_INTERNAL_SECRET — src/index.ts)
//
// Query: ?window=1h|24h|cycle (default 24h; only `edges` and per-store
// `top_jobs` depend on it). Response: { success: true, data: DatabasesPayload }
// built by lib/db-health.ts — KV-cached 10 min, single-flight, fail-soft per
// section (`<section>_error` keys).

import { json } from "../lib/cors";
import { getDatabasesPayload, parseDbWindow } from "../lib/db-health";
import type { Env } from "../types";

export async function handleDatabases(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const window = parseDbWindow(new URL(request.url).searchParams.get("window"));
  if (!window) {
    return json({ success: false, error: "window must be one of 1h, 24h, cycle" }, 400, origin);
  }
  try {
    const data = await getDatabasesPayload(env, window);
    return json({ success: true, data }, 200, origin);
  } catch (err) {
    // Never echo internals to the (all-staff) caller; the full text is logged.
    console.warn(`[databases] payload build failed: ${err instanceof Error ? err.message : String(err)}`);
    return json({ success: false, error: "databases payload unavailable" }, 500, origin);
  }
}
