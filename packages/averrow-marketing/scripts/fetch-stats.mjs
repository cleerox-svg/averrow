#!/usr/bin/env node
/**
 * Fetch real platform stats at build time and write them to
 * src/data/stats.json, which the homepage imports as a static module.
 *
 * Runs BEFORE astro build (see the `build` script in package.json).
 *
 * Source: GET https://averrow.com/api/v1/public/stats, envelope
 *   { success: true, data: { total_threats, threats_detected, providers_mapped,
 *     threat_campaigns, countries, active_feeds, proof?: {...}, ... } }
 *
 * Output (all values are display strings, rounded DOWN so we never overstate):
 *   threats_detected   "1.1M+"
 *   campaigns          "6,000+"
 *   providers_mapped   "12,000+"
 *   countries          "215"
 *   active_feeds       46            (number — the page says "40+ sources")
 *   proof?             { lookalikes_found_30d, operations_tracked, monitored_brands }
 *   live               raw numbers (total_threats, threats_today, threat_types[],
 *                      operations_tracked, lookalikes_found_30d, ...) for the
 *                      "By the numbers" section; null per field when missing
 *   fallbacks          static labels for fields the backend may not measure yet
 *   generated_at       ISO timestamp of THIS fetch
 *   source             the URL, or "snapshot-YYYY-MM-DD" when the committed
 *                      snapshot is being reused
 *
 * Failure policy: a failed fetch NEVER fails the build (we'd rather ship a
 * dated snapshot than block a deploy), but it is loud: a console error
 * block, and under CI a GitHub `::warning::` annotation. The page shows
 * "updated <date>" from generated_at, so a stale snapshot is visibly dated
 * rather than passed off as fresh.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const STATS_PATH = resolve(ROOT, "src/data/stats.json");
const SOURCE_URL = "https://averrow.com/api/v1/public/stats";

/** Round DOWN to 2 significant digits and add "+": 6097 -> "6,000+", 12147 -> "12,000+". Below 1,000 stays exact. */
export function roundLabel(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return String(Math.floor(n));
  const digits = Math.floor(Math.log10(n)) + 1;
  const step = 10 ** (digits - 2);
  const floored = Math.floor(n / step) * step;
  return `${floored.toLocaleString("en-US")}+`;
}

/** Compact label for the big threat counter: 1,175,112 -> "1.1M+", 210,400 -> "210K+". */
export function compactLabel(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1_000_000) return `${(Math.floor(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M+`;
  if (n >= 1_000) return `${Math.floor(n / 1000)}K+`;
  return String(Math.floor(n));
}

/** Parse "1.3M+" / "210K+" / "9,600+" back into a number (null if unparseable). */
function parseLabel(label) {
  const m = /^\s*([\d.,]+)\s*([KkMm])?\+?\s*$/.exec(String(label ?? ""));
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const mult = { k: 1e3, m: 1e6 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return base * mult;
}

/** Static labels used when the live value is missing or not yet measured. */
export const DEFAULT_FALLBACKS = { lookalikes_found_30d: "2,300+" };

const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @typedef {object} SiteStats
 * @property {string} threats_detected
 * @property {string | null} campaigns
 * @property {string | null} providers_mapped
 * @property {string} countries
 * @property {number | null} active_feeds
 * @property {string} generated_at
 * @property {string} source
 * @property {{ lookalikes_found_30d?: string | null, operations_tracked?: string | null, monitored_brands?: string | null }} [proof]
 * @property {Record<string, any>} [live] raw numbers for the By-the-numbers section
 * @property {{ lookalikes_found_30d: string }} [fallbacks]
 */

/**
 * Build the committed-shape stats object from the live `data` payload, or throw.
 * @param {any} live
 * @param {string} generatedAt
 * @param {string} source
 * @returns {SiteStats}
 */
export function buildStats(live, generatedAt, source) {
  if (!live || typeof live !== "object") throw new Error("payload has no data object");
  if (!isCount(live.providers_mapped) || !isCount(live.threat_campaigns) || !isCount(live.countries)) {
    throw new Error(
      "payload is missing providers_mapped / threat_campaigns / countries (shape changed?)",
    );
  }

  // Threat total: prefer the API's own label, but never print a figure larger
  // than the raw total we were also given.
  let threats = typeof live.threats_detected === "string" ? live.threats_detected : null;
  if (isCount(live.total_threats)) {
    const claimed = parseLabel(threats);
    if (threats === null || claimed === null || claimed > live.total_threats) {
      if (threats !== null) {
        console.warn(
          `[fetch-stats] API label threats_detected="${threats}" exceeds total_threats=${live.total_threats}; using "${compactLabel(live.total_threats)}".`,
        );
      }
      threats = compactLabel(live.total_threats);
    }
  }
  if (!threats) throw new Error("payload has neither threats_detected nor total_threats");

  /** @type {SiteStats} */
  const stats = {
    threats_detected: threats,
    campaigns: roundLabel(live.threat_campaigns),
    providers_mapped: roundLabel(live.providers_mapped),
    countries: String(Math.floor(live.countries)),
    active_feeds: isCount(live.active_feeds) ? Math.floor(live.active_feeds) : null,
    generated_at: generatedAt,
    source,
  };

  // Optional proof block (backend adds it; tolerate absence or partial data).
  const p = live.proof;
  if (p && typeof p === "object") {
    /** @type {NonNullable<SiteStats['proof']>} */
    const proof = {};
    // 0 = "not measured under the current definition" (the backend narrowed it);
    // never publish it as a real zero. The static fallback below covers the gap.
    if (isCount(p.lookalikes_found_30d) && p.lookalikes_found_30d > 0) proof.lookalikes_found_30d = roundLabel(p.lookalikes_found_30d);
    if (isCount(p.operations_tracked)) proof.operations_tracked = roundLabel(p.operations_tracked);
    if (isCount(p.monitored_brands)) proof.monitored_brands = roundLabel(p.monitored_brands);
    if (Object.keys(proof).length > 0) stats.proof = proof;
  }

  // Raw numbers for the "By the numbers" section (rendered at build, then
  // refreshed in the browser from the same endpoint). Any field may be null:
  // the page keeps its fallback for that field.
  const num = (v) => (isCount(v) ? v : null);
  const pr = p && typeof p === "object" ? p : {};
  const types = Array.isArray(live.threat_types)
    ? live.threat_types
        .filter((r) => r && typeof r.threat_type === "string" && isCount(r.count))
        .map((r) => ({ threat_type: r.threat_type, count: r.count }))
    : [];
  stats.live = {
    total_threats: num(live.total_threats),
    threats_today: num(live.threats_today),
    threat_types: types,
    operations_tracked: num(pr.operations_tracked),
    lookalikes_found_30d: isCount(pr.lookalikes_found_30d) && pr.lookalikes_found_30d > 0 ? pr.lookalikes_found_30d : null,
    monitored_brands: num(pr.monitored_brands),
    providers_mapped: num(live.providers_mapped),
    countries: num(live.countries),
    active_feeds: num(live.active_feeds),
    proof_generated_at: typeof pr.generated_at === "string" ? pr.generated_at : null,
  };
  stats.fallbacks = { ...DEFAULT_FALLBACKS };
  return stats;
}

function loudWarning(message, existing) {
  const lines = [
    "",
    "[fetch-stats] ============================================================",
    `[fetch-stats] WARNING: live stats NOT refreshed — ${message}`,
    `[fetch-stats] Shipping the committed snapshot instead (source=${existing?.source ?? "unknown"}, generated_at=${existing?.generated_at ?? "unknown"}).`,
    "[fetch-stats] The homepage will show that date. Fix the endpoint or the parser.",
    "[fetch-stats] ============================================================",
    "",
  ];
  console.error(lines.join("\n"));
  if (process.env.CI) {
    // GitHub Actions annotation — surfaces on the run summary.
    console.log(`::warning title=Marketing stats not refreshed::${message}. Homepage is using the committed snapshot (${existing?.source ?? "unknown"}).`);
  }
}

async function main() {
  await mkdir(dirname(STATS_PATH), { recursive: true });

  let existing = null;
  try {
    existing = JSON.parse(await readFile(STATS_PATH, "utf8"));
  } catch {
    // First run — file doesn't exist yet.
  }

  try {
    const res = await fetchWithTimeout(SOURCE_URL, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${SOURCE_URL}`);
    const payload = await res.json();
    if (payload?.success === false) throw new Error(`API reported failure: ${payload.error ?? "unknown"}`);
    const stats = buildStats(payload?.data ?? payload, new Date().toISOString(), SOURCE_URL);
    await writeFile(STATS_PATH, JSON.stringify(stats, null, 2) + "\n", "utf8");
    console.log(
      `[fetch-stats] Wrote live stats from ${SOURCE_URL}: threats=${stats.threats_detected} campaigns=${stats.campaigns} providers=${stats.providers_mapped} countries=${stats.countries} feeds=${stats.active_feeds}${stats.proof ? " proof=yes" : " proof=absent"}`,
    );
  } catch (err) {
    loudWarning(err?.message ?? String(err), existing);
  }
}

// Only run when executed directly, so the helpers can be imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // Defensive: even an unexpected throw shouldn't fail the build.
    loudWarning(`unexpected error: ${err?.message ?? err}`, null);
  });
}
