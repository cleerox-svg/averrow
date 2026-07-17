/**
 * Threat Feed Adapters — Phase 1
 *
 * External threat intelligence feed integrations:
 *   1. Have I Been Pwned (Pwned Passwords — free, no key)
 *   2. PhishTank via CIRCL public API (free, no key)
 *   3. URLhaus on-demand query (free, no key)
 *   4. AbuseIPDB (free tier, optional API key)
 *   5. EmailRep.io (free tier, no key for basic)
 *
 * All adapters normalize signals to ThreatSignal format and store in D1.
 */

import type { Env } from "./types";
import { fuzzyMatchBrand, type BrandRow } from "./lib/brandDetect";
import { extractDomain } from "./lib/domain-utils";

// ─── Common Types ──────────────────────────────────────────────────

export interface ThreatSignal {
  source: string;
  signal_type: string;
  indicator: string;
  indicator_type: string;
  severity: string;
  details_json: string;
  brand_match_id?: string;
  first_seen_at: string;
  fetched_at: string;
}

interface PhishtankEntry {
  url: string;
  phish_id?: number;
  phish_detail_page?: string;
  submission_time?: string;
  verified?: string;
  verification_time?: string;
  online?: string;
  target?: string;
  ip_address?: string;
}

interface UrlhausHostResult {
  urlhaus_reference?: string;
  host: string;
  url_count?: number;
  urls?: Array<{
    id: string;
    url: string;
    url_status: string;
    date_added: string;
    threat: string;
    tags: string[] | null;
  }>;
}

interface AbuseIPDBResult {
  data?: {
    ipAddress: string;
    isPublic: boolean;
    abuseConfidenceScore: number;
    countryCode: string;
    isp: string;
    totalReports: number;
    lastReportedAt: string | null;
  };
}

interface EmailRepResult {
  email?: string;
  reputation?: string;
  suspicious?: boolean;
  references?: number;
  details?: {
    malicious_activity?: boolean;
    credentials_leaked?: boolean;
    data_breach?: boolean;
    spam?: boolean;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

async function loadBrands(db: D1Database): Promise<BrandRow[]> {
  const rows = await db.prepare("SELECT id, name, canonical_domain FROM brands").all<BrandRow>();
  return rows.results;
}

async function insertSignal(db: D1Database, signal: ThreatSignal): Promise<void> {
  await db.prepare(
    `INSERT INTO threat_signals
       (source, signal_type, indicator, indicator_type, severity,
        details_json, brand_match_id, first_seen_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    signal.source,
    signal.signal_type,
    signal.indicator,
    signal.indicator_type,
    signal.severity,
    signal.details_json,
    signal.brand_match_id ?? null,
    signal.first_seen_at,
    signal.fetched_at,
  ).run();
}


/** KV-based rate limit tracker for daily-capped APIs */
async function checkDailyLimit(cache: KVNamespace, key: string, limit: number): Promise<boolean> {
  try {
    const count = parseInt(await cache.get(key) || "0", 10);
    return count < limit;
  } catch {
    return true;
  }
}

async function incrementDailyCount(cache: KVNamespace, key: string): Promise<void> {
  try {
    const count = parseInt(await cache.get(key) || "0", 10);
    // TTL to midnight UTC — rough: max 86400s
    await cache.put(key, String(count + 1), { expirationTtl: 86400 });
  } catch { /* non-fatal */ }
}

/** Fetch with 5-second timeout and graceful failure */
async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(5000),
  });
}

// ═══════════════════════════════════════════════════════════════════
// 1. Have I Been Pwned — Pwned Passwords API (free, no key)
// ═══════════════════════════════════════════════════════════════════

/**
 * Check password exposure count using k-anonymity API.
 * On-demand enrichment — NOT a cron feed.
 */
export async function checkPasswordExposure(password: string): Promise<number> {
  // SHA-1 hash the password
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

  const prefix = hashHex.slice(0, 5);
  const suffix = hashHex.slice(5);

  const res = await safeFetch(`https://api.pwnedpasswords.com/range/${prefix}`);
  if (!res.ok) return 0;

  const text = await res.text();
  for (const line of text.split("\r\n")) {
    const [hash, count] = line.split(":");
    if (hash === suffix) return parseInt(count ?? "0", 10);
  }
  return 0;
}

/**
 * Stub for email breach check — requires HIBP_API_KEY (paid tier).
 */
export async function checkEmailBreaches(
  _email: string,
  _apiKey?: string,
): Promise<Array<{ name: string; domain: string; breachDate: string }>> {
  // Requires HIBP_API_KEY — implement when paid tier is configured
  return [];
}

// ═══════════════════════════════════════════════════════════════════
// 2. PhishTank via CIRCL Public API (free, no key)
// ═══════════════════════════════════════════════════════════════════

const CIRCL_BASE = "https://phishtankapi.circl.lu";

/** Check a specific URL against PhishTank via CIRCL */
export async function checkPhishtankUrl(url: string): Promise<PhishtankEntry | null> {
  try {
    const res = await safeFetch(`${CIRCL_BASE}/api/v1/url/${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = await res.json() as PhishtankEntry | Record<string, never>;
    return data && "url" in data ? data as PhishtankEntry : null;
  } catch {
    return null;
  }
}

/** Check phishing URLs hosted on a given IP */
export async function checkPhishtankIp(ip: string): Promise<PhishtankEntry[]> {
  try {
    const res = await safeFetch(`${CIRCL_BASE}/api/v1/urls_by_ip/${encodeURIComponent(ip)}`);
    if (!res.ok) return [];
    const data = await res.json() as PhishtankEntry[] | Record<string, never>;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Cron: Fetch PhishTank data via CIRCL and match against monitored brands.
 * Throttled to once per hour via KV timestamp.
 */
export async function syncPhishtankFeed(env: Env): Promise<{ fetched: number; matched: number }> {
  const THROTTLE_KEY = "feed:phishtank:last_fetch";
  const now = Date.now();

  // Check throttle — 1 hour minimum between fetches
  const lastFetch = await env.CACHE.get(THROTTLE_KEY);
  if (lastFetch && now - parseInt(lastFetch, 10) < 3600_000) {
    return { fetched: 0, matched: 0 };
  }

  // Check if dump has been refreshed
  try {
    const infoRes = await safeFetch(`${CIRCL_BASE}/api/v1/info`);
    if (!infoRes.ok) {
      return { fetched: 0, matched: 0 };
    }
  } catch {
    return { fetched: 0, matched: 0 };
  }

  // Fetch bulk URLs — limit processing to avoid timeout
  let entries: PhishtankEntry[] = [];
  try {
    const res = await safeFetch(`${CIRCL_BASE}/api/v1/urls/`);
    if (!res.ok) {
      return { fetched: 0, matched: 0 };
    }
    const data = await res.json();
    entries = Array.isArray(data) ? (data as PhishtankEntry[]).slice(0, 500) : [];
  } catch (err) {
    console.error("[phishtank-circl] bulk fetch error:", err);
    return { fetched: 0, matched: 0 };
  }

  // Update throttle timestamp
  await env.CACHE.put(THROTTLE_KEY, String(now), { expirationTtl: 7200 });

  if (entries.length === 0) return { fetched: 0, matched: 0 };

  // Load brands for matching
  const brands = await loadBrands(env.DB);
  const fetchedAt = new Date().toISOString();
  let matched = 0;

  for (const entry of entries) {
    if (!entry.url) continue;
    const domain = extractDomain(entry.url);
    if (!domain) continue;

    // Check for brand match via domain OR target field
    const haystacks = [domain];
    if (entry.target) haystacks.push(entry.target.toLowerCase());
    const brandId = fuzzyMatchBrand(haystacks, brands);

    if (brandId) {
      // Check duplicate before insert
      const existing = await env.DB.prepare(
        "SELECT id FROM threat_signals WHERE source = 'phishtank' AND indicator = ? LIMIT 1"
      ).bind(entry.url).first();
      if (existing) continue;

      await insertSignal(env.DB, {
        source: "phishtank",
        signal_type: "phishing_url",
        indicator: entry.url,
        indicator_type: "url",
        severity: entry.verified === "yes" ? "high" : "medium",
        details_json: JSON.stringify({
          phish_id: entry.phish_id,
          target: entry.target,
          verified: entry.verified,
          ip_address: entry.ip_address,
          submission_time: entry.submission_time,
        }),
        brand_match_id: brandId,
        first_seen_at: entry.submission_time ?? fetchedAt,
        fetched_at: fetchedAt,
      });
      matched++;
    }
  }

  return { fetched: entries.length, matched };
}

// ═══════════════════════════════════════════════════════════════════
// 3. URLhaus — On-demand domain check (free, no key for read)
// ═══════════════════════════════════════════════════════════════════

/** On-demand: check if a domain is distributing malware via URLhaus */
export async function checkUrlhausDomain(domain: string): Promise<UrlhausHostResult | null> {
  try {
    const res = await safeFetch("https://urlhaus-api.abuse.ch/v1/host/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `host=${encodeURIComponent(domain)}`,
    });
    if (!res.ok) return null;
    const data = await res.json() as UrlhausHostResult;
    return data.urls ? data : null;
  } catch {
    return null;
  }
}

/**
 * Cron: Fetch recent URLhaus URLs and match against monitored brands.
 * Throttled to once per 30 minutes via KV timestamp.
 */
export async function syncUrlhausFeed(env: Env): Promise<{ fetched: number; matched: number }> {
  const THROTTLE_KEY = "feed:urlhaus:last_fetch";
  const now = Date.now();

  const lastFetch = await env.CACHE.get(THROTTLE_KEY);
  if (lastFetch && now - parseInt(lastFetch, 10) < 1800_000) {
    return { fetched: 0, matched: 0 };
  }

  let urls: Array<{ url: string; url_status: string; host: string; date_added: string; threat: string }> = [];
  try {
    const res = await safeFetch("https://urlhaus-api.abuse.ch/v1/urls/recent/");
    if (!res.ok) {
      return { fetched: 0, matched: 0 };
    }
    const body = await res.json() as { urls?: typeof urls };
    urls = (body.urls ?? []).slice(0, 500);
  } catch (err) {
    console.error("[urlhaus-signals] fetch error:", err);
    return { fetched: 0, matched: 0 };
  }

  await env.CACHE.put(THROTTLE_KEY, String(now), { expirationTtl: 3600 });

  if (urls.length === 0) return { fetched: 0, matched: 0 };

  const brands = await loadBrands(env.DB);
  const fetchedAt = new Date().toISOString();
  let matched = 0;

  for (const entry of urls) {
    if (!entry.url) continue;
    const domain = extractDomain(entry.url);
    if (!domain) continue;

    const brandId = fuzzyMatchBrand([domain], brands);
    if (brandId) {
      const existing = await env.DB.prepare(
        "SELECT id FROM threat_signals WHERE source = 'urlhaus' AND indicator = ? LIMIT 1"
      ).bind(entry.url).first();
      if (existing) continue;

      await insertSignal(env.DB, {
        source: "urlhaus",
        signal_type: "malware_url",
        indicator: entry.url,
        indicator_type: "url",
        severity: entry.url_status === "online" ? "high" : "medium",
        details_json: JSON.stringify({
          host: entry.host,
          url_status: entry.url_status,
          threat: entry.threat,
        }),
        brand_match_id: brandId,
        first_seen_at: entry.date_added ?? fetchedAt,
        fetched_at: fetchedAt,
      });
      matched++;
    }
  }

  return { fetched: urls.length, matched };
}

// ═══════════════════════════════════════════════════════════════════
// 4. AbuseIPDB (free tier: 1000 checks/day, optional API key)
// ═══════════════════════════════════════════════════════════════════

/** On-demand: check IP reputation via AbuseIPDB */
export async function checkIpReputation(
  env: Env,
  ip: string,
): Promise<AbuseIPDBResult["data"] | null> {
  const apiKey = (env as Env & { ABUSEIPDB_API_KEY?: string }).ABUSEIPDB_API_KEY;
  if (!apiKey) return null; // Skip silently if no key configured

  // Check cache
  const cacheKey = `abuseipdb:${ip}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* re-fetch */ }
  }

  // Check daily rate limit
  const limitKey = "abuseipdb:daily_count";
  if (!(await checkDailyLimit(env.CACHE, limitKey, 1000))) {
    return null;
  }

  try {
    const res = await safeFetch(
      `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
      { headers: { Key: apiKey, Accept: "application/json" } },
    );
    if (!res.ok) return null;

    const body = await res.json() as AbuseIPDBResult;
    await incrementDailyCount(env.CACHE, limitKey);

    if (body.data) {
      await env.CACHE.put(cacheKey, JSON.stringify(body.data), { expirationTtl: 86400 });
    }
    return body.data ?? null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5. EmailRep.io (free tier: 200 lookups/day, no key for basic)
// ═══════════════════════════════════════════════════════════════════

/** On-demand: check email reputation via EmailRep.io */
export async function checkEmailReputation(
  env: Env,
  email: string,
): Promise<EmailRepResult | null> {
  // Check cache (hash-based key for privacy)
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(email));
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  const cacheKey = `emailrep:${hashHex.slice(0, 16)}`;

  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* re-fetch */ }
  }

  // Check daily rate limit
  const limitKey = "emailrep:daily_count";
  if (!(await checkDailyLimit(env.CACHE, limitKey, 200))) {
    return null;
  }

  try {
    const res = await safeFetch(`https://emailrep.io/${encodeURIComponent(email)}`, {
      headers: { Accept: "application/json", "User-Agent": "Averrow-ThreatIntel/1.0" },
    });
    if (!res.ok) return null;

    const body = await res.json() as EmailRepResult;
    await incrementDailyCount(env.CACHE, limitKey);

    await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 43200 }); // 12h TTL
    return body;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Cron Orchestrator — runs all feed syncs with throttling
// ═══════════════════════════════════════════════════════════════════

export interface ThreatFeedSyncResult {
  phishtank: { fetched: number; matched: number };
  urlhaus: { fetched: number; matched: number };
  totalSignals: number;
  totalMatches: number;
}

/**
 * Run the threat feed sync step. Called from the cron handler.
 * Throttled to once per 30 minutes via KV.
 */
export async function runThreatFeedSync(env: Env): Promise<ThreatFeedSyncResult> {
  const THROTTLE_KEY = "pipeline:feed_sync:last_run";
  const now = Date.now();

  const lastRun = await env.CACHE.get(THROTTLE_KEY);
  if (lastRun && now - parseInt(lastRun, 10) < 1800_000) {
    return {
      phishtank: { fetched: 0, matched: 0 },
      urlhaus: { fetched: 0, matched: 0 },
      totalSignals: 0,
      totalMatches: 0,
    };
  }

  await env.CACHE.put(THROTTLE_KEY, String(now), { expirationTtl: 3600 });

  // Run feeds concurrently with graceful failure
  const [phishtank, urlhaus] = await Promise.all([
    syncPhishtankFeed(env).catch(err => {
      console.error("[threat-feeds] phishtank sync error:", err);
      return { fetched: 0, matched: 0 };
    }),
    syncUrlhausFeed(env).catch(err => {
      console.error("[threat-feeds] urlhaus sync error:", err);
      return { fetched: 0, matched: 0 };
    }),
  ]);

  return {
    phishtank,
    urlhaus,
    totalSignals: phishtank.fetched + urlhaus.fetched,
    totalMatches: phishtank.matched + urlhaus.matched,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Admin Stats — threat feed stats for dashboard
// ═══════════════════════════════════════════════════════════════════

export interface ThreatFeedStats {
  totalSignals: number;
  signalsWithBrandMatch: number;
  signalsBySource: Array<{ source: string; count: number }>;
  lastSyncBySource: Array<{ source: string; last_fetched: string | null }>;
}

export async function getThreatFeedStats(db: D1Database): Promise<ThreatFeedStats> {
  const [total, withBrand, bySource, lastSync] = await Promise.all([
    db.prepare("SELECT COUNT(*) as n FROM threat_signals").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) as n FROM threat_signals WHERE brand_match_id IS NOT NULL").first<{ n: number }>(),
    db.prepare("SELECT source, COUNT(*) as count FROM threat_signals GROUP BY source ORDER BY count DESC")
      .all<{ source: string; count: number }>(),
    db.prepare("SELECT source, MAX(fetched_at) as last_fetched FROM threat_signals GROUP BY source")
      .all<{ source: string; last_fetched: string | null }>(),
  ]);

  return {
    totalSignals: total?.n ?? 0,
    signalsWithBrandMatch: withBrand?.n ?? 0,
    signalsBySource: bySource.results,
    lastSyncBySource: lastSync.results,
  };
}
