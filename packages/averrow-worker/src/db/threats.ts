/**
 * Data access layer — threats table.
 *
 * Replaces 20+ inline queries scattered across handlers and agents.
 * All threat queries go through these typed functions.
 */

import type { Threat, ThreatQueryOptions, Env } from "../types";

// Re-export for consumers that import from db/threats
export type { Threat, ThreatQueryOptions };

// ─── Brand-scoped queries ─────────────────────────────────────────

export async function getThreatsByBrand(
  env: Env,
  brandId: string,
  options: ThreatQueryOptions = {},
): Promise<{ results: Threat[]; total: number }> {
  const { limit = 50, offset = 0, status, type, days, severity } = options;

  const conditions = ["target_brand_id = ?"];
  const params: unknown[] = [brandId];

  if (status) { conditions.push("status = ?"); params.push(status); }
  if (type) { conditions.push("threat_type = ?"); params.push(type); }
  if (severity) { conditions.push("severity = ?"); params.push(severity); }
  if (days) {
    conditions.push("created_at > datetime('now', ? || ' days')");
    params.push(-days);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM threats ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all<Threat>(),
    env.DB.prepare(
      `SELECT COUNT(*) as c FROM threats ${where}`
    ).bind(...params).first<{ c: number }>(),
  ]);

  return { results: rows.results ?? [], total: count?.c ?? 0 };
}

/**
 * Count threats for a brand, optionally within a time window.
 * Single source of truth for threat counting across all consumers.
 */
export async function getThreatCount(
  env: Env,
  brandId: string,
  days?: number,
): Promise<number> {
  const timeClause = days
    ? `AND created_at > datetime('now', '${-days} days')`
    : '';
  const result = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM threats WHERE target_brand_id = ? ${timeClause}`
  ).bind(brandId).first<{ c: number }>();
  return result?.c ?? 0;
}

// ─── Global queries ───────────────────────────────────────────────

export async function getActiveThreatsByType(
  env: Env,
  threatType: string,
  limit = 100,
): Promise<Threat[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM threats WHERE threat_type = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?"
  ).bind(threatType, limit).all<Threat>();
  return rows.results ?? [];
}

export async function getThreatById(env: Env, id: string): Promise<Threat | null> {
  return env.DB.prepare("SELECT * FROM threats WHERE id = ?")
    .bind(id)
    .first<Threat>();
}
