/**
 * Data access layer — brands table.
 *
 * Typed query functions for the most-queried entity in the platform.
 * The brands table is referenced in 82+ inline queries across handlers.
 * Use these functions instead of writing raw SQL in handlers/agents.
 */

import type { Brand, BrandListOptions, Env } from "../types";

// Re-export for consumers that import from db/brands
export type { Brand, BrandListOptions };

// ─── Single-row lookups ───────────────────────────────────────────

export async function getBrandById(env: Env, id: string): Promise<Brand | null> {
  return env.DB.prepare("SELECT * FROM brands WHERE id = ?")
    .bind(id)
    .first<Brand>();
}

export async function getBrandByDomain(env: Env, domain: string): Promise<Brand | null> {
  return env.DB.prepare("SELECT * FROM brands WHERE canonical_domain = ?")
    .bind(domain)
    .first<Brand>();
}

// ─── List queries ─────────────────────────────────────────────────

const ALLOWED_ORDER_COLUMNS = new Set([
  'threat_count', 'name', 'created_at', 'last_threat_seen', 'sector',
  'monitoring_status', 'canonical_domain', 'id',
]);
const ALLOWED_DIRECTIONS = new Set(['ASC', 'DESC']);

export async function listBrands(
  env: Env,
  options: BrandListOptions = {},
): Promise<{ results: Brand[]; total: number }> {
  const { limit = 50, offset = 0, sector, monitoringStatus } = options;
  const orderBy = ALLOWED_ORDER_COLUMNS.has(options.orderBy ?? '') ? options.orderBy! : 'threat_count';
  const direction = ALLOWED_DIRECTIONS.has((options.direction ?? '').toUpperCase()) ? options.direction!.toUpperCase() : 'DESC';

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (sector) { conditions.push("sector = ?"); params.push(sector); }
  if (monitoringStatus) { conditions.push("monitoring_status = ?"); params.push(monitoringStatus); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM brands ${where} ORDER BY ${orderBy} ${direction} LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all<Brand>(),
    env.DB.prepare(
      `SELECT COUNT(*) as c FROM brands ${where}`
    ).bind(...params).first<{ c: number }>(),
  ]);

  return { results: rows.results ?? [], total: count?.c ?? 0 };
}

// ─── Aggregates ───────────────────────────────────────────────────

export async function getBrandThreatCount(
  env: Env,
  brandId: string,
  days: number = 30,
): Promise<number> {
  const result = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM threats WHERE target_brand_id = ? AND created_at > datetime('now', ? || ' days')"
  ).bind(brandId, -days).first<{ c: number }>();
  return result?.c ?? 0;
}

// ─── Mutations ────────────────────────────────────────────────────

const ALLOWED_UPDATE_FIELDS = new Set([
  'name', 'canonical_domain', 'sector', 'monitoring_status', 'threat_count',
  'last_threat_seen', 'risk_score', 'logo_url', 'description', 'aliases',
  'brand_score', 'brand_score_updated_at', 'social_config',
]);

/**
 * Update a single column on a brand row.
 * Field name is validated against an allowlist to prevent SQL injection.
 */
export async function updateBrandField(
  env: Env,
  brandId: string,
  field: string,
  value: unknown,
): Promise<void> {
  if (!ALLOWED_UPDATE_FIELDS.has(field)) {
    throw new Error(`updateBrandField: disallowed field "${field}"`);
  }
  await env.DB.prepare(`UPDATE brands SET ${field} = ? WHERE id = ?`)
    .bind(value, brandId)
    .run();
}

export async function incrementBrandThreatCount(env: Env, brandId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE brands SET threat_count = threat_count + 1, last_threat_seen = datetime('now') WHERE id = ?"
  ).bind(brandId).run();
}

/**
 * Prepared statement bumping a brand's counter by N newly linked threats.
 * Batch these alongside the threats UPDATEs that set target_brand_id so
 * the counter moves with the link (the analyst keyword pre-match linked
 * threats for months without bumping — see lib/brand-count-reconciler.ts).
 */
export function bumpBrandThreatCountStmt(env: Env, brandId: string, n: number): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE brands SET threat_count = threat_count + ?, last_threat_seen = datetime('now') WHERE id = ?"
  ).bind(n, brandId);
}
