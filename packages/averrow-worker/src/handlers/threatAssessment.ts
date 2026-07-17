// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Brand Threat Assessment API handlers.
 *
 * GET /api/brand/:brandId/threat-assessment — latest assessment
 * GET /api/brand/:brandId/threat-assessment/history — last 30 snapshots
 */

import { json } from "../lib/cors";
import type { Env } from "../types";
import { getLatestAssessment, getAssessmentHistory } from "../brand-threat-correlator";
import { getThreatFeedStats } from "../threat-feeds";

export async function handleGetThreatAssessment(
  request: Request,
  env: Env,
  brandId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const assessment = await getLatestAssessment(env, brandId);
    if (!assessment) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }
    return json({ success: true, data: assessment }, 200, origin);
  } catch (err) {
    console.error("[threat-assessment] error:", err);
    return json({ success: false, error: "Assessment failed" }, 500, origin);
  }
}

export async function handleGetThreatAssessmentHistory(
  request: Request,
  env: Env,
  brandId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const history = await getAssessmentHistory(env.DB, brandId);
    return json({ success: true, data: history }, 200, origin);
  } catch (err) {
    console.error("[threat-assessment-history] error:", err);
    return json({ success: false, error: "Failed to load history" }, 500, origin);
  }
}

export async function handleThreatFeedStats(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const stats = await getThreatFeedStats(env.DB);
    return json({ success: true, data: stats }, 200, origin);
  } catch (err) {
    console.error("[threat-feed-stats] error:", err);
    return json({ success: true, data: { totalSignals: 0, signalsWithBrandMatch: 0, signalsBySource: [], lastSyncBySource: [] } }, 200, origin);
  }
}
