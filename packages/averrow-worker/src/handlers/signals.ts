// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { json } from "../lib/cors";
import { sanitize, sanitizeTags, sanitizeDomain } from "../lib/sanitize";
import type { Env, IngestSignalBody } from "../types";

// GET /api/signals (handleSignals, a list of `scans` rows) was retired with
// the URL-scan feature (2026-10-04); `scans` never existed in prod.

// ─── Manual Signal Ingestion ──────────────────────────────────

export async function handleIngestSignal(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as IngestSignalBody;
    const source = sanitize(body.source ?? "manual", 50);
    const domain = body.domain ? sanitizeDomain(body.domain) : null;
    const range_m = body.range_m ?? 5000;
    const intensity_dbz = body.intensity_dbz ?? 0;
    const quality = Math.max(0, Math.min(100, body.quality ?? 50));
    const rawTags = body.tags?.filter((t): t is string => typeof t === "string") ?? [];
    const tags = sanitizeTags(rawTags).join(",");
    const risk_level = quality >= 80 ? "safe" : quality >= 60 ? "low" : quality >= 40 ? "medium" : quality >= 20 ? "high" : "critical";

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO signals (id, source, domain, range_m, intensity_dbz, quality, risk_level, tags, user_id, captured_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(id, source, domain, range_m, intensity_dbz, quality, risk_level, tags, userId).run().catch(() => {
      // Best-effort: a missing `signals` table must not fail the request.
    });

    return json({
      success: true,
      data: { id, source, domain, range_m, intensity_dbz, quality, risk_level, tags: tags.split(",").filter(Boolean) },
    }, 201, origin, env);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin, env);
  }
}

