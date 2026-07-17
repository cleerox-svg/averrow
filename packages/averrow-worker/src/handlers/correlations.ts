// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { json } from "../lib/cors";
import type { Env } from "../types";

// Cache TTL: 1 hour
const CACHE_TTL = 3600;

type CorrelationView = "type" | "source" | "country";
type CorrelationWindow = "7d" | "30d" | "90d";

interface CorrelationResult {
  view: CorrelationView;
  window: CorrelationWindow;
  labels: string[];
  matrix: number[][];
  cached: boolean;
}

function windowToDays(w: CorrelationWindow): number {
  return w === "7d" ? 7 : w === "30d" ? 30 : 90;
}

// Jaccard similarity: |A ∩ B| / |A ∪ B|
// Here approximated via co-occurrence count / (count_a + count_b - co_occurrence)
function buildMatrix(
  items: string[],
  coOccurrence: Map<string, number>,
  counts: Map<string, number>
): number[][] {
  return items.map((a) =>
    items.map((b) => {
      if (a === b) return 1.0;
      const key = [a, b].sort().join("|||");
      const co = coOccurrence.get(key) ?? 0;
      const ca = counts.get(a) ?? 0;
      const cb = counts.get(b) ?? 0;
      const union = ca + cb - co;
      return union > 0 ? parseFloat((co / union).toFixed(3)) : 0;
    })
  );
}

// ── Type × Type correlation ─────────────────────────────────────────
async function computeTypeCorrelation(
  env: Env,
  days: number
): Promise<{ labels: string[]; matrix: number[][] }> {
  // Get all threat types active in window
  const typeRows = await env.DB.prepare(
    `SELECT DISTINCT threat_type AS type FROM threats
     WHERE created_at >= datetime('now', ? || ' days') AND threat_type IS NOT NULL
     ORDER BY threat_type`
  )
    .bind(-days)
    .all<{ type: string }>();

  const labels = typeRows.results.map((r) => r.type);
  if (labels.length < 2) return { labels, matrix: labels.map(() => labels.map(() => 0)) };

  // Count each type
  const countRows = await env.DB.prepare(
    `SELECT threat_type AS type, COUNT(*) as cnt
     FROM threats
     WHERE created_at >= datetime('now', ? || ' days') AND threat_type IS NOT NULL
     GROUP BY threat_type`
  )
    .bind(-days)
    .all<{ type: string; cnt: number }>();

  const counts = new Map<string, number>(countRows.results.map((r) => [r.type, r.cnt]));

  // Co-occurrence: two threat types from same source within same day
  const coRows = await env.DB.prepare(
    `SELECT a.threat_type as t1, b.threat_type as t2, COUNT(*) as co
     FROM threats a
     JOIN threats b ON a.source = b.source
       AND date(a.created_at) = date(b.created_at)
       AND a.threat_type < b.threat_type
     WHERE a.created_at >= datetime('now', ? || ' days')
       AND b.created_at >= datetime('now', ? || ' days')
     GROUP BY a.threat_type, b.threat_type`
  )
    .bind(-days, -days)
    .all<{ t1: string; t2: string; co: number }>();

  const coOccurrence = new Map<string, number>(
    coRows.results.map((r) => [`${r.t1}|||${r.t2}`, r.co])
  );

  return { labels, matrix: buildMatrix(labels, coOccurrence, counts) };
}

// ── Source × Source correlation ──────────────────────────────────────
async function computeSourceCorrelation(
  env: Env,
  days: number
): Promise<{ labels: string[]; matrix: number[][] }> {
  const sourceRows = await env.DB.prepare(
    `SELECT DISTINCT source FROM threats
     WHERE created_at >= datetime('now', ? || ' days') AND source IS NOT NULL
     ORDER BY source
     LIMIT 12`
  )
    .bind(-days)
    .all<{ source: string }>();

  const labels = sourceRows.results.map((r) => r.source);
  if (labels.length < 2) return { labels, matrix: labels.map(() => labels.map(() => 0)) };

  const countRows = await env.DB.prepare(
    `SELECT source, COUNT(*) as cnt
     FROM threats
     WHERE created_at >= datetime('now', ? || ' days') AND source IS NOT NULL
     GROUP BY source`
  )
    .bind(-days)
    .all<{ source: string; cnt: number }>();

  const counts = new Map<string, number>(countRows.results.map((r) => [r.source, r.cnt]));

  // Co-occurrence: two sources flagging same domain within same day
  const coRows = await env.DB.prepare(
    `SELECT a.source as s1, b.source as s2, COUNT(*) as co
     FROM threats a
     JOIN threats b ON a.domain = b.domain
       AND date(a.created_at) = date(b.created_at)
       AND a.source < b.source
     WHERE a.created_at >= datetime('now', ? || ' days')
       AND b.created_at >= datetime('now', ? || ' days')
       AND a.domain IS NOT NULL
     GROUP BY a.source, b.source`
  )
    .bind(-days, -days)
    .all<{ s1: string; s2: string; co: number }>();

  const coOccurrence = new Map<string, number>(
    coRows.results.map((r) => [`${r.s1}|||${r.s2}`, r.co])
  );

  return { labels, matrix: buildMatrix(labels, coOccurrence, counts) };
}

// ── Country × Type correlation ───────────────────────────────────────
// Returns a non-square matrix: rows = countries, cols = threat types
// For display we normalise each cell as fraction of country's total threats
async function computeCountryCorrelation(
  env: Env,
  days: number
): Promise<{ labels: string[]; rowLabels: string[]; matrix: number[][] }> {
  // Top countries
  const countryRows = await env.DB.prepare(
    `SELECT country_code, COUNT(*) as cnt
     FROM threats
     WHERE created_at >= datetime('now', ? || ' days')
       AND country_code IS NOT NULL AND country_code != ''
     GROUP BY country_code
     ORDER BY cnt DESC
     LIMIT 10`
  )
    .bind(-days)
    .all<{ country_code: string; cnt: number }>();

  // Threat types
  const typeRows = await env.DB.prepare(
    `SELECT DISTINCT threat_type AS type FROM threats
     WHERE created_at >= datetime('now', ? || ' days') AND threat_type IS NOT NULL
     ORDER BY threat_type`
  )
    .bind(-days)
    .all<{ type: string }>();

  const countries = countryRows.results.map((r) => r.country_code);
  const types = typeRows.results.map((r) => r.type);

  if (countries.length === 0 || types.length === 0) {
    return { labels: types, rowLabels: countries, matrix: [] };
  }

  const countryCounts = new Map<string, number>(countryRows.results.map((r) => [r.country_code, r.cnt]));

  // Count each country × type combination
  const cellRows = await env.DB.prepare(
    `SELECT country_code, threat_type AS type, COUNT(*) as cnt
     FROM threats
     WHERE created_at >= datetime('now', ? || ' days')
       AND country_code IS NOT NULL AND threat_type IS NOT NULL
     GROUP BY country_code, threat_type`
  )
    .bind(-days)
    .all<{ country_code: string; type: string; cnt: number }>();

  const cellMap = new Map<string, number>();
  for (const r of cellRows.results) {
    cellMap.set(`${r.country_code}|||${r.type}`, r.cnt);
  }

  const matrix = countries.map((c) => {
    const total = countryCounts.get(c) ?? 1;
    return types.map((t) => {
      const cnt = cellMap.get(`${c}|||${t}`) ?? 0;
      return parseFloat((cnt / total).toFixed(3));
    });
  });

  return { labels: types, rowLabels: countries, matrix };
}

// ─── Main handler ────────────────────────────────────────────────────
export async function handleCorrelations(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const view = (url.searchParams.get("view") ?? "type") as CorrelationView;
    const window = (url.searchParams.get("window") ?? "30d") as CorrelationWindow;

    if (!["type", "source", "country"].includes(view)) {
      return json({ success: false, error: "Invalid view. Use type|source|country" }, 400, origin);
    }
    if (!["7d", "30d", "90d"].includes(window)) {
      return json({ success: false, error: "Invalid window. Use 7d|30d|90d" }, 400, origin);
    }

    const cacheKey = `correlations:${view}:${window}`;

    // Try KV cache
    const cached = await env.CACHE.get(cacheKey, "json") as CorrelationResult | null;
    if (cached) {
      return json({ success: true, data: { ...cached, cached: true } }, 200, origin);
    }

    const days = windowToDays(window);
    let result: Partial<CorrelationResult>;

    if (view === "type") {
      const { labels, matrix } = await computeTypeCorrelation(env, days);
      result = { view, window, labels, matrix };
    } else if (view === "source") {
      const { labels, matrix } = await computeSourceCorrelation(env, days);
      result = { view, window, labels, matrix };
    } else {
      // country view returns asymmetric matrix with rowLabels
      const { labels, rowLabels, matrix } = await computeCountryCorrelation(env, days);
      result = { view, window, labels, matrix, ...({ rowLabels } as object) };
    }

    // Cache for 1 hour
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL });

    return json({ success: true, data: { ...result, cached: false } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
