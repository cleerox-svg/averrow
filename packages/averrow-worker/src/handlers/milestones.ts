// Public milestones handler.
//
// GET /api/v1/public/milestones/latest
// Returns the most recently fired platform milestone, used by the Home
// celebration banner. Public because the data is marketing-grade (a
// total threat-ingestion count).
//
// Caches at the edge for 60s — milestones fire at most every few hours,
// so polling clients can hit cache freely.

import { json } from "../lib/cors";
import { getLatestMilestone } from "../lib/platform-milestones";
import type { Env } from "../types";

export async function handleLatestMilestone(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const milestone = await getLatestMilestone(env.DB);
    return json(
      { success: true, data: milestone },
      200,
      origin,
    );
  } catch (err) {
    console.error("[milestones] handler error:", err);
    return json({ success: false, error: "Failed to fetch milestone" }, 500, origin);
  }
}
