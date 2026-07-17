// Averrow — Threat Inflow Handler
//
// Powers the stacked-area inflow chart on the Threats page. Reads
// from threat_cube_status (migration 0124) — every threat row is
// represented exactly once per hour bucket, so this query stays cheap
// even at 113K+ threats.
//
// Two windows:
//   24h — 24 hourly buckets, fine grain for "what's happening now"
//   7d  — 168 hourly buckets, broader trend
//
// Chart rendering layers stack by threat_type. The handler keeps the
// payload compact — it returns parallel arrays per type rather than a
// row-per-(bucket,type) shape so the client doesn't pivot in JS.

import { json } from "../lib/cors";
import type { Env } from "../types";

type Window = "24h" | "7d";

interface InflowResponse {
  window: Window;
  /** Hour bucket ISO strings, oldest first. */
  buckets: string[];
  /** threat_type → count[]; counts align with `buckets`. Sorted by total desc. */
  series: Array<{ threat_type: string; counts: number[]; total: number }>;
  /** Sum across all types, for the headline number. */
  total: number;
  generated_at: string;
}

const CACHE_TTL_SECONDS = 300; // 5 min — cube refreshes every 5 min anyway.

export async function handleThreatInflow(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const windowParam = url.searchParams.get("window") === "7d" ? "7d" : "24h";

  // v2 cache prefix — invalidates stale empty payloads cached under
  // v1 while the SQLite modifier bug below was returning 0 rows.
  const cacheKey = `threat_inflow:v2:${windowParam}`;
  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);
  } catch {
    // KV transient error — fall through to live compute.
  }

  // Bucket math:
  //   24h →  24 buckets, anchored to the current hour.
  //   7d  → 168 buckets.
  const bucketCount = windowParam === "7d" ? 168 : 24;

  // SQLite truncates timestamps to the hour with strftime. We anchor
  // to the current hour so the rightmost bucket is always "now" — the
  // chart's leading-edge pulse falls on a real cube row.
  //
  // The outer strftime('%Y-%m-%d %H:00:00', ...) already truncates to
  // the hour, so no additional modifier is needed. The previous
  // version passed the string 'start of hour' || '+0 hours' which
  // SQLite concatenates into the invalid modifier 'start of hour+0 hours'
  // (only `start of day|month|year` are valid), causing datetime() to
  // return NULL → WHERE matched 0 rows → empty chart.
  const earliest = `datetime('now', '-${bucketCount - 1} hours')`;
  // strftime to the same shape stored in threat_cube_status.hour_bucket
  // ('YYYY-MM-DD HH:00:00')

  try {
    const rows = await env.DB.prepare(`
      SELECT hour_bucket, threat_type, SUM(threat_count) AS count
        FROM threat_cube_status
       WHERE hour_bucket >= strftime('%Y-%m-%d %H:00:00', ${earliest})
       GROUP BY hour_bucket, threat_type
       ORDER BY hour_bucket ASC
    `).all<{ hour_bucket: string; threat_type: string; count: number }>();

    // Build the bucket axis client-side: every hour from (now - N) to
    // now, padded with zeros for any (bucket, type) combination missing
    // from the cube. This keeps the chart visually continuous even
    // during low-activity windows.
    const buckets: string[] = [];
    const cursor = new Date();
    cursor.setUTCMinutes(0, 0, 0);
    cursor.setUTCHours(cursor.getUTCHours() - (bucketCount - 1));
    for (let i = 0; i < bucketCount; i++) {
      const yyyy = cursor.getUTCFullYear();
      const mm = String(cursor.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(cursor.getUTCDate()).padStart(2, "0");
      const hh = String(cursor.getUTCHours()).padStart(2, "0");
      buckets.push(`${yyyy}-${mm}-${dd} ${hh}:00:00`);
      cursor.setUTCHours(cursor.getUTCHours() + 1);
    }
    const bucketIdx = new Map(buckets.map((b, i) => [b, i]));

    // Pivot rows into per-threat-type count arrays.
    const byType = new Map<string, number[]>();
    for (const r of rows.results) {
      const idx = bucketIdx.get(r.hour_bucket);
      if (idx === undefined) continue; // older than window, ignore
      let counts = byType.get(r.threat_type);
      if (!counts) {
        counts = new Array<number>(bucketCount).fill(0);
        byType.set(r.threat_type, counts);
      }
      counts[idx] = (counts[idx] ?? 0) + r.count;
    }

    // Sort series by total desc — the chart layers from largest to
    // smallest so the dominant type sits flat on the baseline. Stable
    // ordering also keeps the legend consistent across pages.
    const series = Array.from(byType.entries())
      .map(([threat_type, counts]) => {
        const total = counts.reduce((s, n) => s + n, 0);
        return { threat_type, counts, total };
      })
      .sort((a, b) => b.total - a.total);

    const total = series.reduce((s, t) => s + t.total, 0);

    const body: InflowResponse = {
      window: windowParam,
      buckets,
      series,
      total,
      generated_at: new Date().toISOString(),
    };

    try {
      await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: CACHE_TTL_SECONDS });
    } catch { /* non-fatal */ }

    return json(body, 200, origin);
  } catch (err) {
    console.error('[threat_inflow]', windowParam, err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
