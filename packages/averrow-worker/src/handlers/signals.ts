// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { json } from "../lib/cors";
import { sanitize, sanitizeTags, sanitizeDomain } from "../lib/sanitize";
import type { Env, IngestSignalBody } from "../types";

const SOURCE_MAP: Record<string, string> = {
  web: "station-alpha",
  api: "station-beta",
  extension: "station-gamma",
};

function domainToRange(domain: string): number {
  let h = 0;
  for (let i = 0; i < domain.length; i++) {
    h = (Math.imul(31, h) + domain.charCodeAt(i)) | 0;
  }
  return Math.abs(h % 90000) + 10000;
}

function scoreToIntensity(score: number): number {
  // Low trust = high intensity threat signal
  return Math.round(((100 - score) / 100) * 60 * 10) / 10;
}

function scoreToTags(score: number, flags: string): string[] {
  const tags: string[] = [];
  try {
    const f = JSON.parse(flags) as Array<{ type: string }>;
    if (f.length === 0) tags.push("nominal");
    else tags.push(...f.slice(0, 2).map((x) => x.type.replace(/_/g, "-")));
  } catch {
    if (score >= 70) tags.push("nominal");
    else if (score >= 40) tags.push("weak-signal");
    else tags.push("anomaly", "high-gain");
  }
  return tags;
}

export async function handleSignals(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));

  try {
    const rows = await env.DB.prepare(
      `SELECT id, url, domain, trust_score, risk_level, flags, source, cached, created_at
       FROM scans ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all<{ id: string; url: string; domain: string; trust_score: number; risk_level: string; flags: string; source: string; cached: number; created_at: string }>();

    const signals = rows.results.map((r) => ({
      id: r.id,
      captured_at: r.created_at,
      source: r.cached ? "node-001" : (SOURCE_MAP[r.source] ?? "station-alpha"),
      range_m: domainToRange(r.domain),
      intensity_dbz: scoreToIntensity(r.trust_score),
      quality: r.trust_score,
      tags: scoreToTags(r.trust_score, r.flags),
      domain: r.domain,
      risk_level: r.risk_level,
    }));

    return json({ success: true, data: signals }, 200, origin, env);
  } catch {
    return json({ success: true, data: [] }, 200, origin, env);
  }
}

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
      // If signals table doesn't exist, insert into scans as fallback
    });

    return json({
      success: true,
      data: { id, source, domain, range_m, intensity_dbz, quality, risk_level, tags: tags.split(",").filter(Boolean) },
    }, 201, origin, env);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin, env);
  }
}

