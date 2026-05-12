/**
 * GeoIP Enrichment — IP-to-location resolution using ipinfo.io (HTTPS).
 *
 * Free tier: 50,000 requests/month, no API key required.
 * Budget: 5 lookups per cron cycle (every 5 min) = ~43K/month.
 * Returns ISO 3166-1 alpha-2 country codes (e.g., "US", "DE", "CN").
 */

export interface GeoIPResult {
  ip: string;
  countryCode: string | null;
  country: string | null;
  isp: string | null;
  org: string | null;
  as: string | null;
  lat: number | null;
  lng: number | null;
}

interface IpinfoResponse {
  ip: string;
  city?: string;
  region?: string;
  country?: string;   // 2-letter code
  loc?: string;        // "lat,lng"
  org?: string;        // "AS13335 Cloudflare, Inc."
  postal?: string;
  timezone?: string;
  bogon?: boolean;
}

// ─── Private/Bogon IP Filter ────────────────────────────────────────

/** Returns true if the IP is private, bogon, or otherwise non-routable. */
export function isPrivateIP(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return true;
  const [a, b] = parts as [number, number, number, number];

  return (
    a === 10 ||                              // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||     // 172.16.0.0/12
    (a === 192 && b === 168) ||              // 192.168.0.0/16
    a === 127 ||                              // 127.0.0.0/8
    (a === 0 && b === 0) ||                  // 0.0.0.0
    (a === 100 && b === 64) ||               // 100.64.0.0/10 (CGNAT)
    a === 169 && b === 254 ||                // 169.254.0.0/16 (link-local)
    a >= 224                                  // 224.0.0.0+ (multicast/reserved)
  );
}

// ─── Monthly Usage Tracking via KV ──────────────────────────────────

const GEO_MONTHLY_LIMIT = 45000;

function geoUsageKey(): string {
  const now = new Date();
  return `geo_usage_${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Get current monthly geo usage count from KV. */
export async function getGeoUsage(kv: KVNamespace): Promise<number> {
  const val = await kv.get(geoUsageKey());
  return val ? parseInt(val, 10) : 0;
}

/** Increment monthly geo usage counter. */
async function incrementGeoUsage(kv: KVNamespace, count: number): Promise<number> {
  const key = geoUsageKey();
  const current = await getGeoUsage(kv);
  const updated = current + count;
  // TTL: 35 days (auto-expire old months)
  await kv.put(key, String(updated), { expirationTtl: 35 * 86400 });
  return updated;
}

// ─── Single IP Lookup ───────────────────────────────────────────────

let _rawLogCount = 0;

interface LookupResult {
  geo: GeoIPResult | null;
  rateLimited: boolean;
}

async function lookupSingleIP(ip: string, token?: string): Promise<LookupResult> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`https://ipinfo.io/${ip}/json`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 429) {
      console.warn(`[geoip] Rate limited (429) on ${ip}`);
      return { geo: null, rateLimited: true };
    }

    if (!res.ok) {
      const bodyPreview = await res.text().catch(() => "");
      console.error(`[geoip] HTTP ${res.status} for ${ip}: ${bodyPreview.slice(0, 200)}`);
      return { geo: null, rateLimited: false };
    }

    const bodyText = await res.text();
    // Log raw response for first 3 IPs to diagnose API issues
    if (_rawLogCount < 3) {
      _rawLogCount++;
    }
    const data = JSON.parse(bodyText) as IpinfoResponse;
    if (data.bogon) {
      return { geo: null, rateLimited: false };
    }

    return { geo: parseIpinfoResponse(ip, data), rateLimited: false };
  } catch (err) {
    console.error(`[geoip] fetch error for ${ip}:`, err);
    return { geo: null, rateLimited: false };
  }
}

function parseIpinfoResponse(ip: string, data: IpinfoResponse): GeoIPResult | null {
  if (data.bogon) return null;

  // Parse "lat,lng" from loc field
  let lat: number | null = null;
  let lng: number | null = null;
  if (data.loc) {
    const parts = data.loc.split(",");
    const parsedLat = parseFloat(parts[0]!);
    const parsedLng = parseFloat(parts[1]!);
    lat = isNaN(parsedLat) ? null : parsedLat;
    lng = isNaN(parsedLng) ? null : parsedLng;
  }

  // Parse ASN and org from org field: "AS13335 Cloudflare, Inc."
  let asn: string | null = null;
  let org: string | null = null;
  if (data.org) {
    const asnMatch = data.org.match(/^(AS\d+)\s+(.+)$/);
    if (asnMatch) {
      asn = asnMatch[1]!;
      org = asnMatch[2]!;
    } else {
      org = data.org;
    }
  }

  return {
    ip: data.ip || ip,
    countryCode: data.country ?? null,
    country: null, // ipinfo.io free tier only returns 2-letter code
    isp: org,
    org,
    as: asn,
    lat,
    lng,
  };
}

// ─── Batch Lookup ───────────────────────────────────────────────────

/**
 * Batch-resolve IPs to geo data via ipinfo.io.
 * Returns { results, attempted } so callers know which IPs were actually looked up.
 */
export async function batchGeoLookup(
  ips: string[],
  kv?: KVNamespace,
  token?: string,
): Promise<{ results: Map<string, GeoIPResult>; attempted: Set<string> }> {
  const results = new Map<string, GeoIPResult>();
  const attempted = new Set<string>();
  if (ips.length === 0) return { results, attempted };

  // Filter out private/bogon IPs — they waste quota
  const publicIps = [...new Set(ips)].filter(ip => !isPrivateIP(ip));
  const skippedCount = new Set(ips).size - publicIps.length;
  if (skippedCount > 0) {
  }

  if (publicIps.length === 0) {
    return { results, attempted };
  }

  // Check monthly budget
  if (kv) {
    const usage = await getGeoUsage(kv);
    if (usage >= GEO_MONTHLY_LIMIT) {
      console.warn(`[geoip] Monthly budget exhausted: ${usage}/${GEO_MONTHLY_LIMIT} — skipping all lookups`);
      return { results, attempted };
    }
    const remaining = GEO_MONTHLY_LIMIT - usage;
  }

  // Cap per cycle: 5 without token, 50 with token
  const capPerCycle = token ? 50 : 5;
  const batch = publicIps.slice(0, capPerCycle);
  let successCount = 0;

  // Process sequentially — no concurrency needed at batch size 5
  for (let i = 0; i < batch.length; i++) {
    const ip = batch[i]!;
    attempted.add(ip);
    const { geo, rateLimited } = await lookupSingleIP(ip, token);

    if (rateLimited) {
      console.warn(`[geoip] HTTP 429 — stopping batch (${i} of ${batch.length} completed)`);
      break;
    }

    if (geo) {
      results.set(ip, geo);
      successCount++;
    }

    // Brief pause between requests
    if (i < batch.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Track usage in KV
  if (kv && successCount > 0) {
    const newTotal = await incrementGeoUsage(kv, successCount);
  }


  return { results, attempted };
}

/**
 * Enrich threats in D1 that have ip_address but no country_code.
 * Uses v2 schema: hosting_provider_id (FK) instead of hosting_provider (text).
 */
export interface GeoEnrichResult {
  enriched: number;
  total: number;
  skippedPrivate: number;
  skippedNoResult: number;
  errors: string[];
}

/** SQL WHERE clauses to exclude private/bogon IP ranges at the query level. */
// Post-0175: filter switched from 11 chained `NOT LIKE` predicates
// (which forced full-table scans on every cartographer / flight-control
// / diagnostics callsite) to a single boolean check against the
// materialized `is_private_ip` column. New rows are stamped by
// feedRunner.insertThreat via isPrivateIP(); existing rows were
// backfilled in migration 0175 using the exact same LIKE set so
// classifications are stable. Callsites consume this string unchanged
// — the public API is preserved.
export const PRIVATE_IP_SQL_FILTER = `
  AND is_private_ip = 0`;

export async function enrichThreatsGeo(db: D1Database, kv?: KVNamespace, token?: string): Promise<GeoEnrichResult> {
  const result: GeoEnrichResult = { enriched: 0, total: 0, skippedPrivate: 0, skippedNoResult: 0, errors: [] };

  // Predicate is `lat IS NULL`, not `country_code IS NULL`. The
  // earlier predicate created a dead zone: ip-api.com returns
  // status='success' with an empty lat/lng for ~93% of malicious
  // IPs (cartographer.ts §Phase 0 comment). Phase 0 sets
  // country_code from those partial responses but leaves lat NULL;
  // the old predicate then skipped them, so Phase 1 was
  // structurally locked out of helping.
  //
  // `lat IS NULL` covers both:
  //   1. Threats Phase 0 never resolved (country_code also NULL)
  //   2. Threats Phase 0 partial-resolved (country_code set, lat NULL)
  //
  // capPerCycle in batchGeoLookup() is the actual ipinfo budget
  // gate (5 without token, 50 with token); LIMIT 500 just widens
  // the candidate pool so we always have enough fresh rows for
  // ipinfo to pick from.
  const rows = await db.prepare(
    `SELECT id, ip_address FROM threats
     WHERE ip_address IS NOT NULL
       AND lat IS NULL
       ${PRIVATE_IP_SQL_FILTER}
     ORDER BY created_at DESC
     LIMIT 500`
  ).all<{ id: string; ip_address: string }>();

  result.total = rows.results.length;
  if (result.total === 0) return result;

  // Pre-filter: mark private/bogon IPs as 'PRIV' so they exit the queue
  const publicRows: typeof rows.results = [];
  for (const row of rows.results) {
    if (isPrivateIP(row.ip_address)) {
      try {
        await db.prepare(
          "UPDATE threats SET country_code = 'PRIV' WHERE id = ?"
        ).bind(row.id).run();
        result.skippedPrivate++;
      } catch (err) {
        result.errors.push(`mark-private ${row.id}: ${err}`);
      }
    } else {
      publicRows.push(row);
    }
  }

  if (publicRows.length === 0) {
    return result;
  }

  const ips = publicRows.map((r) => r.ip_address);
  const { results: geoMap, attempted } = await batchGeoLookup(ips, kv, token);

  for (const row of publicRows) {
    const geo = geoMap.get(row.ip_address);

    if (!geo) {
      // Only mark XX for IPs that were actually looked up and returned nothing.
      // IPs that weren't attempted (over the cap) should stay in queue for next cycle.
      if (attempted.has(row.ip_address)) {
        try {
          await db.prepare(
            "UPDATE threats SET country_code = 'XX' WHERE id = ? AND country_code IS NULL"
          ).bind(row.id).run();
          result.skippedNoResult++;
        } catch (err) {
          result.errors.push(`mark-xx ${row.id}: ${err}`);
        }
      } else {
      }
      continue;
    }

    try {
      const providerName = normalizeProvider(geo.isp, geo.org);
      let providerId: string | null = null;
      if (providerName) {
        providerId = await upsertHostingProvider(db, providerName, geo.as, geo.countryCode);
      }

      // Stamp enriched_at when ipinfo gave us actual coordinates.
      // Without this, Phase 0 (cartographer) re-picks the threat
      // next run because its predicate is `enriched_at IS NULL`,
      // ip-api returns the same partial response, attempts gets
      // bumped, and after 5 retries the threat exits as
      // cartographer_exhausted — even though Phase 1 had already
      // filled lat/lng. Match the same conditional shape as
      // Phase 0's UPDATE: stamp only when we have lat.
      await db.prepare(
        `UPDATE threats SET
          country_code = COALESCE(?, country_code),
          asn = COALESCE(?, asn),
          hosting_provider_id = COALESCE(?, hosting_provider_id),
          lat = COALESCE(?, lat),
          lng = COALESCE(?, lng),
          enriched_at = CASE WHEN ? IS NOT NULL AND enriched_at IS NULL
                              THEN datetime('now') ELSE enriched_at END
        WHERE id = ?`
      ).bind(
        geo.countryCode, geo.as, providerId, geo.lat, geo.lng, geo.lat, row.id,
      ).run();
      result.enriched++;
    } catch (err) {
      console.error(`[geoip] update failed for ${row.id}:`, err);
      result.errors.push(`update ${row.id}: ${err}`);
    }
  }

  return result;
}

/**
 * Upsert a hosting provider record. Returns the provider ID.
 *
 * Prefers the canonical hp_${asn} id form (matches PR #826's
 * cartographer convention: ASN is the unique identity for a provider
 * because UNIQUE(asn) enforces it at the schema level). Falls back to
 * the name-derived form only when asn is unknown — rare in modern
 * usage, but kept so this helper still works for callers that haven't
 * resolved ASN yet.
 */
export async function upsertHostingProvider(
  db: D1Database,
  name: string,
  asn: string | null,
  country: string | null,
): Promise<string> {
  // Strip optional "AS" prefix and any trailing whitespace/description
  // to match cartographer's canonicalization. ip-api returns asn as
  // "AS4837 China Unicom" — we want just "AS4837" for the id.
  const asnPrefix = asn?.split(' ')[0]?.trim() ?? null;
  const id = asnPrefix
    ? `hp_${asnPrefix}`
    : `hp_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

  // Existing rows may carry legacy ids; pre-resolve by asn so we update
  // them in place rather than creating a duplicate that would trip
  // UNIQUE(asn). Returns the existing id when found, otherwise we
  // INSERT with the canonical form above.
  if (asnPrefix) {
    const existing = await db.prepare(
      "SELECT id FROM hosting_providers WHERE asn = ?"
    ).bind(asnPrefix).first<{ id: string }>();
    if (existing) {
      await db.prepare(
        `UPDATE hosting_providers SET
           name = COALESCE(name, ?),
           country = COALESCE(country, ?)
         WHERE id = ?`
      ).bind(name, country, existing.id).run();
      return existing.id;
    }
  }

  await db.prepare(
    `INSERT INTO hosting_providers (id, name, asn, country)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       asn = COALESCE(hosting_providers.asn, excluded.asn),
       country = COALESCE(hosting_providers.country, excluded.country)`
  ).bind(id, name, asnPrefix, country).run();
  return id;
}

/**
 * Normalize ISP/Org names to canonical hosting provider names.
 * Maps common ISP variations to consistent provider names for trending.
 */
export function normalizeProvider(isp: string | null, org: string | null): string | null {
  const raw = (isp || org || "").toLowerCase();
  if (!raw) return null;

  const providerMap: Array<[string[], string]> = [
    [["cloudflare"], "Cloudflare"],
    [["amazon", "aws", "ec2"], "Amazon AWS"],
    [["google cloud", "google llc", "gcp"], "Google Cloud"],
    [["microsoft", "azure"], "Microsoft Azure"],
    [["digitalocean"], "DigitalOcean"],
    [["ovh", "ovhcloud"], "OVHcloud"],
    [["hetzner"], "Hetzner"],
    [["linode", "akamai connected"], "Linode/Akamai"],
    [["godaddy"], "GoDaddy"],
    [["1&1", "ionos", "1und1"], "1&1 IONOS"],
    [["hostinger"], "Hostinger"],
    [["namecheap"], "Namecheap"],
    [["bluehost"], "Bluehost"],
    [["vultr"], "Vultr"],
    [["contabo"], "Contabo"],
    [["hostgator"], "HostGator"],
    [["siteground"], "SiteGround"],
    [["alibaba", "aliyun"], "Alibaba Cloud"],
    [["tencent"], "Tencent Cloud"],
    [["oracle cloud"], "Oracle Cloud"],
    [["leaseweb"], "Leaseweb"],
    [["choopa", "gameservers"], "Choopa/Vultr"],
    [["hostwinds"], "Hostwinds"],
    [["dreamhost"], "DreamHost"],
    [["fastly"], "Fastly"],
    [["vercel"], "Vercel"],
    [["netlify"], "Netlify"],
  ];

  for (const [keywords, name] of providerMap) {
    if (keywords.some(k => raw.includes(k))) return name;
  }

  return org || isp;
}
