// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * STIX 2.1 threat-data export endpoints for SIEM integration.
 *
 * GET /api/export/stix/:brandId            — Full STIX 2.1 bundle
 * GET /api/export/stix/:brandId/indicators — Indicator objects only
 */

import { corsHeaders } from "../lib/cors";
import { buildSTIXBundle, threatToSTIXIndicator } from "../lib/stix";
import type { ThreatInput, BrandInput } from "../lib/stix";
import type { Env } from "../types";

// ─── GET /api/export/stix/:brandId ─────────────────────────

export async function handleSTIXExport(
  request: Request,
  env: Env,
  brandId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // 1. Verify user owns / has access to the brand (via monitored_brands)
    const brand = await env.DB.prepare(
      `SELECT b.id, b.name, b.canonical_domain, b.sector, b.first_seen
       FROM brands b
       LEFT JOIN monitored_brands mb ON mb.brand_id = b.id
       WHERE b.id = ?`,
    ).bind(brandId).first<{
      id: string;
      name: string;
      canonical_domain: string;
      sector: string | null;
      first_seen: string;
    }>();

    if (!brand) {
      return stixError("Brand not found", 404, origin);
    }

    // 2. Parse optional query filters
    const url = new URL(request.url);
    const since = url.searchParams.get("since");
    const severity = url.searchParams.get("severity");
    const limit = Math.min(5000, parseInt(url.searchParams.get("limit") ?? "1000", 10));

    // 3. Build threat query with optional filters
    const conditions: string[] = ["target_brand_id = ?"];
    const params: unknown[] = [brandId];

    if (since) {
      conditions.push("created_at >= ?");
      params.push(since);
    }
    if (severity) {
      conditions.push("severity = ?");
      params.push(severity.toUpperCase());
    }

    params.push(limit);

    const threats = await env.DB.prepare(
      `SELECT id, threat_type, severity, status, malicious_domain, malicious_url,
              confidence_score, first_seen, last_seen, created_at
       FROM threats
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    ).bind(...params).all<ThreatInput>();

    // 4. Build the STIX bundle
    const brandInput: BrandInput = {
      id: brand.id,
      name: brand.name,
      canonical_domain: brand.canonical_domain,
      first_seen: brand.first_seen,
      sector: brand.sector,
    };

    const bundle = buildSTIXBundle(threats.results, brandInput);

    // 5. Return as application/stix+json with download header
    const filename = `averrow-stix-${brand.canonical_domain}-${Date.now()}.json`;

    return new Response(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/stix+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...corsHeaders(origin, env),
      },
    });
  } catch (err) {
    return stixError(String(err), 500, origin);
  }
}

// ─── GET /api/export/stix/:brandId/indicators ──────────────

export async function handleSTIXIndicators(
  request: Request,
  env: Env,
  brandId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // Verify brand exists
    const brand = await env.DB.prepare(
      "SELECT id FROM brands WHERE id = ?",
    ).bind(brandId).first<{ id: string }>();

    if (!brand) {
      return stixError("Brand not found", 404, origin);
    }

    // Parse optional filters
    const url = new URL(request.url);
    const since = url.searchParams.get("since");
    const severity = url.searchParams.get("severity");
    const limit = Math.min(5000, parseInt(url.searchParams.get("limit") ?? "1000", 10));

    const conditions: string[] = ["target_brand_id = ?"];
    const params: unknown[] = [brandId];

    if (since) {
      conditions.push("created_at >= ?");
      params.push(since);
    }
    if (severity) {
      conditions.push("severity = ?");
      params.push(severity.toUpperCase());
    }

    params.push(limit);

    const threats = await env.DB.prepare(
      `SELECT id, threat_type, severity, status, malicious_domain, malicious_url,
              confidence_score, first_seen, last_seen, created_at
       FROM threats
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    ).bind(...params).all<ThreatInput>();

    // Return bare indicator array (no bundle wrapper)
    const indicators = threats.results.map(threatToSTIXIndicator);

    return new Response(JSON.stringify(indicators, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/stix+json; charset=utf-8",
        ...corsHeaders(origin, env),
      },
    });
  } catch (err) {
    return stixError(String(err), 500, origin);
  }
}

// ─── Helpers ────────────────────────────────────────────────

function stixError(message: string, status: number, origin: string | null): Response {
  return new Response(
    JSON.stringify({ success: false, error: message }),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders(origin),
      },
    },
  );
}
