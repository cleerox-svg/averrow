// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { z } from "zod";
import { json } from "../lib/cors";
import type { Env, ScanResult, ScanFlag, ScanMetadata, RiskLevel } from "../types";
import type { UrlScanOutput } from "../agents/url-scan";
import { extractDomain } from "../lib/domain-utils";

const ScanSchema = z.object({
  url: z.string().url().max(2048),
});

function scoreToRisk(score: number): RiskLevel {
  if (score >= 80) return "safe";
  if (score >= 60) return "low";
  if (score >= 40) return "medium";
  if (score >= 20) return "high";
  return "critical";
}

// VirusTotal free tier: 500 calls/day. We cap at 450 to leave a buffer.
const VT_DAILY_LIMIT = 450;
const VT_CACHE_TTL_SEC = 24 * 60 * 60; // 24 hours — aligns with VT's daily quota window

function vtQuotaKey(): string {
  // Key resets naturally at UTC midnight via TTL
  const today = new Date().toISOString().slice(0, 10);
  return `vt:quota:${today}`;
}

async function getVtCallsToday(env: Env): Promise<number> {
  try {
    const val = await env.CACHE.get(vtQuotaKey());
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

async function incrementVtCalls(env: Env): Promise<void> {
  try {
    const key = vtQuotaKey();
    const val = await env.CACHE.get(key);
    const next = (val ? parseInt(val, 10) : 0) + 1;
    await env.CACHE.put(key, String(next), { expirationTtl: 25 * 60 * 60 }); // 25h TTL covers full UTC day
  } catch { /* non-fatal */ }
}

async function checkVirusTotal(
  url: string,
  apiKey: string
): Promise<ScanMetadata["virustotal"] | null> {
  try {
    const encoded = btoa(url).replace(/=/g, "");
    const resp = await fetch(`https://www.virustotal.com/api/v3/urls/${encoded}`, {
      headers: { "x-apikey": apiKey },
    });

    if (resp.status === 429) {
      // Quota exhausted — signal upstream to stop making VT calls
      throw new VTQuotaError();
    }
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      data: { attributes: { last_analysis_stats: Record<string, number> } };
    };
    const stats = data.data.attributes.last_analysis_stats;

    return {
      malicious: stats["malicious"] ?? 0,
      suspicious: stats["suspicious"] ?? 0,
      harmless: stats["harmless"] ?? 0,
      undetected: stats["undetected"] ?? 0,
    };
  } catch (err) {
    if (err instanceof VTQuotaError) throw err;
    return null;
  }
}

class VTQuotaError extends Error {
  constructor() { super("VTQuotaError"); }
}

// ─── IP Geolocation (ipapi.co — HTTPS, free 1000/day, no key) ────────────

interface GeoResult {
  lat: number;
  lng: number;
  city: string;
  country: string;
  countryCode: string;
}

async function resolveGeo(ip: string, env: Env): Promise<GeoResult | null> {
  if (!ip || ip === "127.0.0.1" || ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("::")) {
    return null;
  }

  // Check D1 cache — reuse geo for IPs we've already looked up
  try {
    const cached = await env.DB.prepare(
      "SELECT lat, lng, geo_city, geo_country, geo_country_code FROM scans WHERE ip_address = ? AND lat IS NOT NULL LIMIT 1"
    ).bind(ip).first<{ lat: number; lng: number; geo_city: string; geo_country: string; geo_country_code: string }>();
    if (cached) {
      return { lat: cached.lat, lng: cached.lng, city: cached.geo_city, country: cached.geo_country, countryCode: cached.geo_country_code };
    }
  } catch { /* non-fatal */ }

  try {
    const res = await fetch(
      `https://ipapi.co/${ip}/json/`,
      { headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json() as { error?: boolean; country_code?: string; country_name?: string; city?: string; latitude?: number; longitude?: number };
    if (data.error || !data.latitude || !data.longitude) return null;
    return { lat: data.latitude, lng: data.longitude, city: data.city ?? "", country: data.country_name ?? "", countryCode: data.country_code ?? "" };
  } catch {
    return null;
  }
}

async function runScan(url: string, env: Env): Promise<Omit<ScanResult, "id" | "created_at">> {
  const domain = extractDomain(url) ?? url;
  const flags: ScanFlag[] = [];
  const metadata: ScanMetadata = {};
  let score = 100;

  // SSL check
  const isHttps = url.startsWith("https://");
  if (!isHttps) {
    score -= 25;
    flags.push({ type: "no_ssl", severity: "high", detail: "Site does not use HTTPS" });
  }
  metadata.ssl_valid = isHttps;

  // VirusTotal check — only if API key is set and daily quota is not exhausted
  if (env.VIRUSTOTAL_API_KEY && env.CACHE) {
    const callsToday = await getVtCallsToday(env);
    if (callsToday < VT_DAILY_LIMIT) {
      try {
        const vt = await checkVirusTotal(url, env.VIRUSTOTAL_API_KEY);
        await incrementVtCalls(env);
        if (vt) {
          metadata.virustotal = vt;
          if (vt.malicious > 0) {
            score -= Math.min(50, vt.malicious * 10);
            flags.push({
              type: "malicious_url",
              severity: "critical",
              detail: `Flagged as malicious by ${vt.malicious} security vendors`,
            });
          }
          if (vt.suspicious > 0) {
            score -= Math.min(20, vt.suspicious * 5);
            flags.push({
              type: "suspicious_url",
              severity: "medium",
              detail: `Flagged as suspicious by ${vt.suspicious} security vendors`,
            });
          }
        }
      } catch (err) {
        if (err instanceof VTQuotaError) {
          // Mark quota as exhausted so subsequent requests skip VT immediately
          try {
            await env.CACHE.put(vtQuotaKey(), String(VT_DAILY_LIMIT), { expirationTtl: 25 * 60 * 60 });
          } catch { /* non-fatal */ }
        }
        // Any other VT error: proceed without VT data (non-fatal)
      }
    }
  }

  // IP-only domain check
  if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
    score -= 15;
    flags.push({ type: "ip_domain", severity: "medium", detail: "URL uses an IP address instead of a domain name" });
  }

  // Typosquatting check (common brand names with subtle variations)
  const suspiciousPatterns = [
    /paypa[l1]|p4ypal/i,
    /g[o0]{2}gle|googl[e3]/i,
    /amaz[o0]n|am4zon/i,
    /micr[o0]s[o0]ft/i,
    /app1e|appl[e3]/i,
  ];
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(domain)) {
      score -= 30;
      flags.push({
        type: "typosquatting",
        severity: "high",
        detail: "Domain resembles a well-known brand (possible phishing)",
      });
      break;
    }
  }

  score = Math.max(0, Math.min(100, score));
  const risk_level = scoreToRisk(score);

  return {
    url,
    domain,
    trust_score: score,
    risk_level,
    flags,
    metadata,
    cached: false,
  };
}

export async function handleScan(
  request: Request,
  env: Env,
  userId?: string
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const body = await request.json().catch(() => null);
  const parsed = ScanSchema.safeParse(body);

  if (!parsed.success) {
    return json({ success: false, error: "Invalid URL" }, 400, origin);
  }

  const { url } = parsed.data;
  const domain = extractDomain(url) ?? url;

  // Check cache
  const cached = await env.DB.prepare(
    "SELECT * FROM domain_cache WHERE domain = ? AND expires_at > datetime('now')"
  )
    .bind(domain)
    .first<{
      domain: string;
      trust_score: number;
      risk_level: string;
      flags: string;
      metadata: string;
    }>();

  if (cached) {
    const result: ScanResult = {
      id: crypto.randomUUID(),
      url,
      domain: cached.domain,
      trust_score: cached.trust_score,
      risk_level: cached.risk_level as RiskLevel,
      flags: JSON.parse(cached.flags),
      metadata: JSON.parse(cached.metadata),
      cached: true,
      created_at: new Date().toISOString(),
    };

    // Always store — share link (/scan/:id) must work for all scans
    const clientIpCached = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "";
    const geoCached = await resolveGeo(clientIpCached, env);
    await env.DB.prepare(
      "INSERT INTO scans (id, user_id, url, domain, trust_score, risk_level, flags, metadata, cached, ip_address, lat, lng, geo_city, geo_country, geo_country_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)"
    )
      .bind(result.id, userId ?? null, url, domain, result.trust_score, result.risk_level, cached.flags, cached.metadata,
            clientIpCached || null, geoCached?.lat ?? null, geoCached?.lng ?? null, geoCached?.city ?? null, geoCached?.country ?? null, geoCached?.countryCode ?? null)
      .run();

    return json({ success: true, data: result }, 200, origin);
  }

  // Run fresh scan
  const scanData = await runScan(url, env);

  // AI scan insight via the url_scan synchronous agent (best-effort).
  // The agent enforces input/output schema, applies a 10s AI timeout
  // internally, and falls through to no-insight on any failure path.
  if (env.ANTHROPIC_API_KEY) {
    try {
      const { runSyncAgent } = await import("../lib/agentRunner");
      const { urlScanAgent } = await import("../agents/url-scan");
      const { data } = await runSyncAgent<UrlScanOutput>(env, urlScanAgent, {
        url,
        trustScore: scanData.trust_score,
        riskLevel: scanData.risk_level,
        flags: scanData.flags.map((f) => `${f.type}: ${f.detail}`).slice(0, 40),
      });
      if (data?.aiSucceeded && data.insight) {
        scanData.metadata.ai_insight = {
          summary: data.insight.summary,
          explanation: data.insight.explanation,
          recommendations: data.insight.recommendations,
        };
      }
    } catch { /* non-fatal */ }
  }

  const id = crypto.randomUUID();
  const flagsJson = JSON.stringify(scanData.flags);
  const metaJson = JSON.stringify(scanData.metadata);
  const now = new Date().toISOString();

  // Resolve geo for the requesting client IP
  const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "";
  const geo = await resolveGeo(clientIp, env);

  // Always store — share link (/scan/:id) must work for all scans;
  // geo columns populate when available and feed the heatmap
  await env.DB.prepare(
    "INSERT INTO scans (id, user_id, url, domain, trust_score, risk_level, flags, metadata, ip_address, lat, lng, geo_city, geo_country, geo_country_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, userId ?? null, url, domain, scanData.trust_score, scanData.risk_level, flagsJson, metaJson,
          clientIp || null, geo?.lat ?? null, geo?.lng ?? null, geo?.city ?? null, geo?.country ?? null, geo?.countryCode ?? null)
    .run();

  // Cache the result for 24 hours — aligns with VT's daily quota window to avoid redundant calls
  const expiresAt = new Date(Date.now() + VT_CACHE_TTL_SEC * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO domain_cache (domain, trust_score, risk_level, flags, metadata, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       trust_score = excluded.trust_score,
       risk_level = excluded.risk_level,
       flags = excluded.flags,
       metadata = excluded.metadata,
       expires_at = excluded.expires_at`
  )
    .bind(domain, scanData.trust_score, scanData.risk_level, flagsJson, metaJson, expiresAt)
    .run();

  const result: ScanResult = { ...scanData, id, created_at: now };
  return json({ success: true, data: result }, 200, origin);
}

export async function handleScanHistory(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "20", 10));
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const rows = await env.DB.prepare(
    `SELECT id, url, domain, trust_score, risk_level, flags, metadata, cached, created_at
     FROM scans WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(userId, limit, offset)
    .all();

  const scans = rows.results.map((r) => ({
    ...r,
    flags: JSON.parse(r["flags"] as string),
    metadata: JSON.parse(r["metadata"] as string),
  }));

  return json({ success: true, data: scans }, 200, origin);
}
