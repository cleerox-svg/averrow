#!/usr/bin/env node
/**
 * Fetch live platform stats at build time and write them to
 * src/data/stats.json so the homepage Astro page can import
 * them as a static module.
 *
 * Runs BEFORE astro build (prebuild hook in package.json).
 *
 * Failure modes:
 *  - Network is offline (local dev, CI without internet):
 *    fall back to the existing src/data/stats.json contents.
 *    Don't fail the build — we'd rather ship slightly stale
 *    numbers than block deploys.
 *  - API returns malformed JSON: same, fall back to existing.
 *
 * The static fallback values match what the inline-template
 * homepage used as its own fallback before R6, so the
 * homepage will always render with credible numbers.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const STATS_PATH = resolve(ROOT, "src/data/stats.json");
const SOURCE_URL = "https://averrow.com/api/v1/public/stats";

const STATIC_FALLBACK = {
  agents_deployed: "18",
  feeds_protecting: "33+",
  threats_detected: "210K+",
  brands_monitored: "9.6K+",
  uptime_label: "24/7",
  detection_time_label: "<5min",
  generated_at: new Date().toISOString(),
  source: "static-fallback",
};

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function isPlausibleStats(obj) {
  // The Worker's /api/v1/public/stats may wrap the payload — accept
  // either { data: {...} } or a flat shape. We only proceed if the
  // expected string fields are present.
  const candidate = obj?.data ?? obj;
  return (
    candidate &&
    typeof candidate === "object" &&
    typeof candidate.agents_deployed === "string" &&
    typeof candidate.threats_detected === "string"
  );
}

async function main() {
  await mkdir(dirname(STATS_PATH), { recursive: true });

  // Read existing on-disk stats so we have something to fall back to
  // even if the very first build runs offline.
  let existing = STATIC_FALLBACK;
  try {
    existing = JSON.parse(await readFile(STATS_PATH, "utf8"));
  } catch {
    // First run — file doesn't exist yet. Existing stays as fallback.
  }

  try {
    const res = await fetchWithTimeout(SOURCE_URL, 5000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (!isPlausibleStats(payload)) throw new Error("malformed payload");
    const live = payload.data ?? payload;
    const merged = {
      agents_deployed: live.agents_deployed,
      feeds_protecting: live.feeds_protecting,
      threats_detected: live.threats_detected,
      brands_monitored: live.brands_monitored,
      uptime_label: live.uptime_label,
      detection_time_label: live.detection_time_label,
      generated_at: new Date().toISOString(),
      source: SOURCE_URL,
    };
    await writeFile(STATS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
    console.log(`[fetch-stats] Wrote live stats from ${SOURCE_URL}`);
  } catch (err) {
    // Network/parse failure — keep the existing file untouched so the
    // build still produces a deterministic homepage. Don't bubble up.
    console.warn(
      `[fetch-stats] Live fetch failed (${err.message ?? err}); using existing src/data/stats.json (source=${existing.source ?? "unknown"}).`,
    );
  }
}

main().catch(err => {
  // Defensive: even an unexpected throw shouldn't fail the build.
  console.warn("[fetch-stats] Unexpected error, continuing:", err);
});
