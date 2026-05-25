// Trademark monitoring — ops (/v2) surface.
//
//   GET /api/trademarks/overview
//     Cross-brand rollup for the staff Trademark page: per-brand asset +
//     finding counts, plus cross-brand totals. Mirrors the app-store /
//     dark-web overview handlers. Admins see every brand with trademark
//     data; org members see their org_brands subset.
//
// Data is produced by scanners/trademark-monitor.ts (Phase 1 correlation).

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import { cachedValue } from "../lib/cached-value";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

export interface TrademarkOverviewRow {
  id:                     string;
  brand_name:             string;
  domain:                 string | null;
  assets_active:          number;
  findings_total:         number;
  findings_confirmed:     number;
  findings_likely:        number;
  findings_unknown:       number;
  findings_high_critical: number;
}

interface OverviewTotals {
  brands:     number;
  assets:     number;
  findings:   number;
  confirmed:  number;
  likely:     number;
}

export async function handleTrademarkOverview(
  request: Request,
  env: Env,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const isAdmin = ctx.role === "admin" || ctx.role === "super_admin";

    // Scope: admins see all brands with trademark data; org members see
    // their org_brands subset. Non-admin without an org sees nothing.
    let orgFilter = "";
    const params: unknown[] = [];
    let scopeKey: string;
    if (isAdmin) {
      scopeKey = "admin";
    } else if (ctx.orgId) {
      orgFilter = "AND b.id IN (SELECT brand_id FROM org_brands WHERE org_id = ?)";
      params.push(ctx.orgId);
      scopeKey = `org:${ctx.orgId}`;
    } else {
      return json({
        success: true, data: [], total: 0,
        totals: { brands: 0, assets: 0, findings: 0, confirmed: 0, likely: 0 },
      }, 200, origin);
    }

    const dbCtx = getDbContext(request);
    const session = getReadSession(env, dbCtx);
    const isDefault = limit === 50 && offset === 0;

    const compute = async () => {
      const rows = await session.prepare(
        `SELECT b.id, b.name AS brand_name, b.canonical_domain AS domain,
                (SELECT COUNT(*) FROM trademark_assets ta WHERE ta.brand_id = b.id AND ta.status = 'active') AS assets_active,
                (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active') AS findings_total,
                (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active' AND tf.classification = 'confirmed') AS findings_confirmed,
                (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active' AND tf.classification = 'likely') AS findings_likely,
                (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active' AND tf.classification = 'unknown') AS findings_unknown,
                (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active' AND UPPER(tf.severity) IN ('HIGH','CRITICAL')) AS findings_high_critical
         FROM brands b
         WHERE (EXISTS (SELECT 1 FROM trademark_findings tf WHERE tf.brand_id = b.id)
             OR EXISTS (SELECT 1 FROM trademark_assets ta WHERE ta.brand_id = b.id))
           ${orgFilter}
         ORDER BY findings_high_critical DESC, findings_total DESC, b.name ASC
         LIMIT ? OFFSET ?`,
      ).bind(...params, limit, offset).all<TrademarkOverviewRow>();

      const data = rows.results ?? [];
      const totals = data.reduce<OverviewTotals>((acc, r) => ({
        brands:    acc.brands + 1,
        assets:    acc.assets + r.assets_active,
        findings:  acc.findings + r.findings_total,
        confirmed: acc.confirmed + r.findings_confirmed,
        likely:    acc.likely + r.findings_likely,
      }), { brands: 0, assets: 0, findings: 0, confirmed: 0, likely: 0 });

      return { data, total: data.length, totals };
    };

    const result = isDefault
      ? await cachedValue(env, `trademark_overview:${scopeKey}`, 120, compute)
      : await compute();

    return attachBookmark(json({ success: true, ...result }, 200, origin), session);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
