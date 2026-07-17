import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";
import { computeSanHash } from "../lib/ssl-cert-identity";
import { loadSafeDomainSet, isSafeDomain } from "../lib/safeDomains";
import { createNotification } from "../lib/notifications";
import { isKnownBrandDomain, calculateSuspicionScore } from "../lib/threatScoring";

/** Common homoglyph substitutions for brand matching */
const HOMOGLYPHS: Record<string, string[]> = {
  l: ["1", "i"],
  o: ["0"],
  i: ["1", "l"],
  a: ["4", "@"],
  e: ["3"],
  s: ["5", "$"],
};

/**
 * CertStream — Certificate Transparency log monitoring for suspicious domains.
 * Uses crt.sh REST API to search for recently-issued certs containing brand
 * impersonation keywords.
 *
 * Checks each domain against:
 * 1. Monitored brands from the DB (typosquatting detection with homoglyphs)
 * 2. Hardcoded suspicious patterns (fallback for generic phishing keywords)
 */
export const certstream: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    // ─── Load monitored brand keywords from DB ──────────────
    const brands = await ctx.env.DB.prepare(
      `SELECT b.id, b.name, b.canonical_domain
       FROM brands b
       INNER JOIN monitored_brands mb ON mb.brand_id = b.id
       WHERE mb.status = 'active'`
    ).all<{ id: string; name: string; canonical_domain: string }>();

    const brandKeywords = brands.results.map((b) => ({
      id: b.id,
      keyword: b.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      domain: b.canonical_domain.toLowerCase(),
    }));
    // Load safe domains to skip owned domains
    const safeSet = await loadSafeDomainSet(ctx.env.DB);

    // ─── Build search keyword list ──────────────────────────
    // Use monitored brand names + hardcoded fallback keywords for crt.sh query
    const hardcodedKeywords = ["paypal", "microsoft-login", "apple-id", "netflix-verify", "amazon-secure"];
    const allSearchKeywords = [
      ...brandKeywords.filter((b) => b.keyword.length >= 4).map((b) => b.keyword),
      ...hardcodedKeywords,
    ];
    // Rotate through keywords each 15-minute window
    const keyword = allSearchKeywords[Math.floor(Date.now() / 900_000) % allSearchKeywords.length]!;

    const url = `${ctx.feedUrl}?q=%25${keyword}%25&output=json&limit=100`;

    // crt.sh has had recurring upstream HTTP 502s (observed 2026-04-27,
    // tripped this feed's auto-pause threshold of 5 consecutive failures)
    // and is now intermittently returning 403/404 to Cloudflare egress IPs
    // (observed 2026-05-03/04, 23% failure rate over 24h with the same
    // rotating keyword set that succeeds on the next tick). Treat 5xx,
    // 429, 403, and 404 as skip-this-tick: log + return empty, don't
    // throw. The feed runner counts thrown errors toward auto-pause; a
    // transient crt.sh block shouldn't pause our entire CT monitoring
    // path.
    //
    // PR-BH (2026-05-19): extend the same skip-this-tick treatment to
    // network-layer failures — AbortError (30s timeout fired before
    // response arrived), DNS resolution failures, TLS handshake
    // failures, and ECONNRESET. Production audit 2026-05-19 showed 6
    // consecutive 30s timeouts in a 12h window tripping the same
    // auto-pause threshold the HTTP-error path was designed to avoid.
    // Same operational rationale: a transient upstream issue
    // shouldn't pause the whole CT monitoring path; the existing
    // certstream WebSocket feed continues regardless.
    //
    // Genuine request bugs (other 4xx like 400) still throw — those
    // indicate our query is malformed and should be surfaced.
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json" } });
    } catch (err) {
      const name = err instanceof Error ? err.name : "unknown";
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[ct_logs] fetch failed (${name}: ${message.slice(0, 200)}) — skipping tick`);
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const isTransient =
        res.status >= 500 ||
        res.status === 429 ||
        res.status === 403 ||
        res.status === 404;
      if (isTransient) {
        console.warn(`[ct_logs] transient upstream HTTP ${res.status} — skipping tick (body: ${body.slice(0, 200)})`);
        return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
      }
      console.error(`[ct_logs] error body: ${body.slice(0, 500)}`);
      throw new Error(`CertStream/crt.sh HTTP ${res.status}`);
    }

    const rawText = await res.text();

    let data: Array<{
      id?: number;
      common_name?: string;
      name_value?: string;
      issuer_name?: string;
      serial_number?: string;
    }>;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error(`[ct_logs] JSON parse failed: ${e}`);
      throw new Error(`CertStream JSON parse error: ${e}`);
    }

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = (Array.isArray(data) ? data : []).slice(0, 500);
    const suspiciousPatterns = /(?:paypal|apple|google|microsoft|amazon|netflix|bank|login|secure|verify|account|update|signin|support)/i;

    // Track brand threats for batched notifications
    const brandThreatCounts = new Map<string, { name: string; count: number; lastDomain: string }>();

    for (const cert of items) {
      try {
        const domain = cert.common_name ?? cert.name_value?.split("\n")[0];
        if (!domain) continue;

        // Cert identity retention (NEXUS Lane C). crt.sh returns the SAN
        // set as a newline-joined string in name_value; hash it with the
        // same shared helper the calidog source uses so a cert seen via
        // either path keys identically. serial + issuer stored as-is.
        const sanList = cert.name_value ? cert.name_value.split("\n") : [];
        const sslSanHash = await computeSanHash(sanList);
        const sslCertSerial = cert.serial_number ?? null;
        const sslCertIssuer = cert.issuer_name ?? null;

        // Skip domains in the safe/owned allowlist
        if (isSafeDomain(domain, safeSet)) continue;

        // ─── Skip domains owned by known brands ────────────────
        if (isKnownBrandDomain(domain.toLowerCase())) continue;

        // ─── Check against monitored brands (typosquatting) ───
        const matchedBrand = matchMonitoredBrand(domain.toLowerCase(), brandKeywords);
        if (matchedBrand) {
          // Calculate suspicion score — only flag if >= 30
          const suspicionScore = calculateSuspicionScore(
            domain.toLowerCase(),
            matchedBrand.keyword,
            matchedBrand.isHomoglyph,
          );
          if (suspicionScore < 30) continue;

          if (await isDuplicate(ctx.env, "domain", domain)) { itemsDuplicate++; continue; }

          // Map confidence from suspicion: 30-40 → 40, 41-60 → 55, 61+ → 70
          const confidence = suspicionScore >= 60 ? 70 : suspicionScore >= 40 ? 55 : 40;

          await insertThreat(ctx.env.DB, {
            id: threatId("ct_logs", "domain", domain),
            source_feed: "ct_logs",
            threat_type: "typosquatting",
            malicious_url: null,
            malicious_domain: domain,
            target_brand_id: matchedBrand.id,
            ioc_value: domain,
            severity: confidence >= 60 ? "high" : "medium",
            confidence_score: confidence,
            ssl_cert_serial: sslCertSerial,
            ssl_cert_issuer: sslCertIssuer,
            ssl_san_hash: sslSanHash,
          });
          await markSeen(ctx.env, "domain", domain);
          itemsNew++;
          // Track for batched notification
          const brandName = brands.results.find(b => b.id === matchedBrand.id)?.name ?? matchedBrand.keyword;
          const prev = brandThreatCounts.get(matchedBrand.id);
          brandThreatCounts.set(matchedBrand.id, {
            name: brandName,
            count: (prev?.count ?? 0) + 1,
            lastDomain: domain,
          });
          continue;
        }

        // ─── Fallback: hardcoded suspicious patterns ──────────
        if (!suspiciousPatterns.test(domain)) continue;
        if (/\.(paypal|apple|google|microsoft|amazon|netflix)\.com$/i.test(domain)) continue;

        if (await isDuplicate(ctx.env, "domain", domain)) { itemsDuplicate++; continue; }

        await insertThreat(ctx.env.DB, {
          id: threatId("ct_logs", "domain", domain),
          source_feed: "ct_logs",
          threat_type: "phishing",
          malicious_url: null,
          malicious_domain: domain,
          ioc_value: domain,
          severity: "medium",
          confidence_score: 65,
          ssl_cert_serial: sslCertSerial,
          ssl_cert_issuer: sslCertIssuer,
          ssl_san_hash: sslSanHash,
        });
        await markSeen(ctx.env, "domain", domain);
        itemsNew++;
      } catch (e) {
        itemsError++;
        if (itemsError <= 3) console.error(`[ct_logs] item error: ${e}`);
      }
    }

    // Send batched brand threat notifications (rate-limited: 1 per brand per hour)
    for (const [brandId, info] of brandThreatCounts) {
      try {
        const title = info.count === 1
          ? `New threat: ${info.lastDomain}`
          : `${info.count} new typosquats targeting ${info.name}`;
        const message = info.count === 1
          ? `${info.name} typosquat detected: ${info.lastDomain}`
          : `${info.count} new typosquats detected targeting ${info.name}`;
        await createNotification(ctx.env, {
          type: 'brand_threat',
          severity: 'high',
          title,
          message,
          link: `/brands/${brandId}`,
          metadata: { brand_id: brandId, count: info.count },
        });
      } catch (e) {
        console.error(`[ct_logs] notification error for brand ${brandId}:`, e);
      }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError };
  },
};

/** Check if a domain matches any monitored brand (substring + homoglyph variants) */
function matchMonitoredBrand(
  domain: string,
  brands: Array<{ id: string; keyword: string; domain: string }>,
): { id: string; keyword: string; isHomoglyph: boolean } | null {
  for (const brand of brands) {
    // Skip if this IS the brand's canonical domain
    if (domain === brand.domain) continue;
    // Skip subdomains of the brand's canonical domain
    if (domain.endsWith("." + brand.domain)) continue;
    if (brand.keyword.length < 3) continue;

    // Direct substring match
    if (domain.includes(brand.keyword)) return { ...brand, isHomoglyph: false };

    // Homoglyph variant matching
    for (let i = 0; i < brand.keyword.length; i++) {
      const char = brand.keyword[i]!;
      const subs = HOMOGLYPHS[char];
      if (subs) {
        for (const sub of subs) {
          const variant = brand.keyword.slice(0, i) + sub + brand.keyword.slice(i + 1);
          if (domain.includes(variant)) return { ...brand, isHomoglyph: true };
        }
      }
    }
  }
  return null;
}
