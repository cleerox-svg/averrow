// Averrow — Identity Provider Impersonation summary
// GET /api/intel/identity-threats?window=7d|30d   (requireStaff)
// (docs/IDP_IMPERSONATION_PLAN_2026-10.md, task T4)
//
// Contract mirrors packages/averrow-ops/src/features/identity-threats/types.ts.
//
// Cost: every threats read is an indexed range on
// idx_threats_technique_created (technique, created_at) over the IdP family
// techniques only — never a full threats scan. One GROUP BY
// (technique, idp, brand, day, status) for the current window is rolled up
// in JS into KPIs / trend / by_vector / by_idp / top_brands; one GROUP BY
// (technique, idp) for the previous window gives the deltas. lookalikes_flagged
// reads the partial index idx_lookalike_idp_lure_created. cachedValue 300s.

import { json } from "../lib/cors";
import { getDbContext, getReadSession, type DbContext } from "../lib/db";
import { cachedValue } from "../lib/cached-value";
import {
  IDP_FAMILY_TECHNIQUES,
  IDP_MITRE,
  IDP_PROVIDER_LABEL,
  IDP_VECTOR_LABEL,
  techniqueToVector,
  type IdpProvider,
  type IdpVector,
} from "../lib/idp-impersonation";
import type { Env } from "../types";

export type IdentityWindow = "7d" | "30d";
export const IDENTITY_WINDOW_DAYS: Record<IdentityWindow, number> = { "7d": 7, "30d": 30 };
export const IDENTITY_THREATS_TTL_SECONDS = 300;
const TOP_BRANDS_LIMIT = 10;
const RECENT_LIMIT = 25;

export interface IdentityThreatsData {
  window: IdentityWindow;
  generated_at: string;
  kpis: {
    detections: number;
    detections_prev: number;
    brands_targeted: number;
    idps_impersonated: number;
    live: number;
    taken_down: number;
    lookalikes_flagged: number;
  };
  trend: Array<{ day: string; count: number }>;
  by_vector: Array<{ vector: IdpVector; label: string; count: number; prev: number }>;
  by_idp: Array<{ idp: IdpProvider; label: string; count: number; brands: number; prev: number }>;
  top_brands: Array<{ brand_id: string; brand_name: string; count: number; idps: string[] }>;
  recent: Array<{
    threat_id: string;
    domain: string;
    brand_id: string | null;
    brand_name: string | null;
    idp: string | null;
    vector: string;
    status: string;
    created_at: string;
  }>;
  mitre: Array<{ id: string; name: string; tactic: string; vectors: string[]; count: number }>;
}

export function parseIdentityWindow(raw: string | null): IdentityWindow | null {
  if (raw === null || raw === "") return "7d";
  return raw === "7d" || raw === "30d" ? raw : null;
}

/** threats.status values that mean the site is no longer live
 *  (schema CHECK: active | down | remediated). Same "addressed" definition
 *  as lib/threat-aggregates.ts. */
const TAKEN_DOWN_STATUSES = new Set(["down", "remediated"]);
const VECTORS: readonly IdpVector[] = ["idp_tenant", "idp_lookalike", "device_code"];

function isProvider(v: string | null): v is IdpProvider {
  return v !== null && Object.hasOwn(IDP_PROVIDER_LABEL, v);
}

/** Stored idp, or the classifier's device-code default (entra) when a
 *  device-code row predates tagging. Unknown / null → null. */
function resolveIdp(stored: string | null, vector: IdpVector): IdpProvider | null {
  if (isProvider(stored)) return stored;
  return vector === "device_code" ? "entra" : null;
}

/** D1 `datetime('now')` text for a Date. */
function d1Time(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** D1 "YYYY-MM-DD HH:MM:SS" → ISO-8601 UTC; other shapes pass through. */
function toIso(v: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
}

function hostOfUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`).hostname || null;
  } catch {
    return null;
  }
}

interface CurrentRow {
  technique: string;
  idp: string | null;
  brand_id: string | null;
  day: string;
  status: string;
  n: number;
}
interface PrevRow { technique: string; idp: string | null; n: number }
interface RecentRow {
  id: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  target_brand_id: string | null;
  brand_name: string | null;
  impersonated_idp: string | null;
  technique: string;
  status: string;
  created_at: string;
}

export async function computeIdentityThreats(
  env: Env,
  dbCtx: DbContext,
  window: IdentityWindow,
  now: Date = new Date(),
): Promise<IdentityThreatsData> {
  const days = IDENTITY_WINDOW_DAYS[window];
  // Window = the last `days` UTC calendar days including today, so the
  // trend has exactly `days` points; the previous window is the same length.
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMs = todayStart - (days - 1) * 86_400_000;
  const prevSinceMs = sinceMs - days * 86_400_000;
  const since = d1Time(new Date(sinceMs));
  const prevSince = d1Time(new Date(prevSinceMs));

  const fam = IDP_FAMILY_TECHNIQUES;
  const ph = fam.map(() => "?").join(", ");
  const db = getReadSession(env, dbCtx);

  const [curRes, prevRes, recentRes, lureRow] = await Promise.all([
    db.prepare(
      `SELECT technique, impersonated_idp AS idp, target_brand_id AS brand_id,
              substr(created_at, 1, 10) AS day, status, COUNT(*) AS n
         FROM threats
        WHERE technique IN (${ph}) AND created_at >= ?
        GROUP BY technique, impersonated_idp, target_brand_id, day, status`,
    ).bind(...fam, since).all<CurrentRow>(),
    db.prepare(
      `SELECT technique, impersonated_idp AS idp, COUNT(*) AS n
         FROM threats
        WHERE technique IN (${ph}) AND created_at >= ? AND created_at < ?
        GROUP BY technique, impersonated_idp`,
    ).bind(...fam, prevSince, since).all<PrevRow>(),
    db.prepare(
      `SELECT t.id, t.malicious_domain, t.malicious_url, t.target_brand_id, b.name AS brand_name,
              t.impersonated_idp, t.technique, t.status, t.created_at
         FROM threats t
         LEFT JOIN brands b ON b.id = t.target_brand_id
        WHERE t.technique IN (${ph}) AND t.created_at >= ?
        ORDER BY t.created_at DESC
        LIMIT ?`,
    ).bind(...fam, since, RECENT_LIMIT).all<RecentRow>(),
    db.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains WHERE idp_lure IS NOT NULL AND created_at >= ?`,
    ).bind(since).first<{ n: number }>(),
  ]);

  const cur = curRes.results ?? [];
  const prev = prevRes.results ?? [];

  // ── Roll-ups ──
  let detections = 0;
  let live = 0;
  let takenDown = 0;
  const brands = new Set<string>();
  const idpsSeen = new Set<IdpProvider>();
  const trendMap = new Map<string, number>();
  const vecCount = new Map<IdpVector, number>();
  const idpCount = new Map<IdpProvider, number>();
  const idpBrands = new Map<IdpProvider, Set<string>>();
  const brandCount = new Map<string, number>();
  const brandIdps = new Map<string, Map<IdpProvider, number>>();

  for (const r of cur) {
    const vector = techniqueToVector(r.technique);
    if (!vector) continue;
    const n = r.n;
    detections += n;
    if (r.status === "active") live += n;
    else if (TAKEN_DOWN_STATUSES.has(r.status)) takenDown += n;
    trendMap.set(r.day, (trendMap.get(r.day) ?? 0) + n);
    vecCount.set(vector, (vecCount.get(vector) ?? 0) + n);
    const idp = resolveIdp(r.idp, vector);
    if (idp) {
      idpsSeen.add(idp);
      idpCount.set(idp, (idpCount.get(idp) ?? 0) + n);
      if (r.brand_id) {
        const s = idpBrands.get(idp) ?? new Set<string>();
        s.add(r.brand_id);
        idpBrands.set(idp, s);
      }
    }
    if (r.brand_id) {
      brands.add(r.brand_id);
      brandCount.set(r.brand_id, (brandCount.get(r.brand_id) ?? 0) + n);
      if (idp) {
        const m = brandIdps.get(r.brand_id) ?? new Map<IdpProvider, number>();
        m.set(idp, (m.get(idp) ?? 0) + n);
        brandIdps.set(r.brand_id, m);
      }
    }
  }

  let detectionsPrev = 0;
  const vecPrev = new Map<IdpVector, number>();
  const idpPrev = new Map<IdpProvider, number>();
  for (const r of prev) {
    const vector = techniqueToVector(r.technique);
    if (!vector) continue;
    detectionsPrev += r.n;
    vecPrev.set(vector, (vecPrev.get(vector) ?? 0) + r.n);
    const idp = resolveIdp(r.idp, vector);
    if (idp) idpPrev.set(idp, (idpPrev.get(idp) ?? 0) + r.n);
  }

  const trend: IdentityThreatsData["trend"] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(sinceMs + i * 86_400_000).toISOString().slice(0, 10);
    trend.push({ day, count: trendMap.get(day) ?? 0 });
  }

  const by_vector = VECTORS.map((vector) => ({
    vector,
    label: IDP_VECTOR_LABEL[vector],
    count: vecCount.get(vector) ?? 0,
    prev: vecPrev.get(vector) ?? 0,
  })).sort((a, b) => b.count - a.count);

  const idpKeys = new Set<IdpProvider>([...idpCount.keys(), ...idpPrev.keys()]);
  const by_idp = [...idpKeys].map((idp) => ({
    idp,
    label: IDP_PROVIDER_LABEL[idp],
    count: idpCount.get(idp) ?? 0,
    brands: idpBrands.get(idp)?.size ?? 0,
    prev: idpPrev.get(idp) ?? 0,
  })).sort((a, b) => b.count - a.count || b.prev - a.prev);

  const topBrandIds = [...brandCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_BRANDS_LIMIT)
    .map(([id]) => id);
  const brandNames = new Map<string, string>();
  if (topBrandIds.length > 0) {
    const nameRes = await db.prepare(
      `SELECT id, name FROM brands WHERE id IN (${topBrandIds.map(() => "?").join(", ")})`,
    ).bind(...topBrandIds).all<{ id: string; name: string | null }>();
    for (const r of nameRes.results ?? []) if (r.name) brandNames.set(r.id, r.name);
  }
  const top_brands = topBrandIds.map((brand_id) => ({
    brand_id,
    brand_name: brandNames.get(brand_id) ?? brand_id,
    count: brandCount.get(brand_id) ?? 0,
    idps: [...(brandIdps.get(brand_id) ?? new Map<IdpProvider, number>()).entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([idp]) => IDP_PROVIDER_LABEL[idp]),
  }));

  const recent: IdentityThreatsData["recent"] = [];
  for (const r of recentRes.results ?? []) {
    const vector = techniqueToVector(r.technique);
    if (!vector) continue;
    const idp = resolveIdp(r.impersonated_idp, vector);
    recent.push({
      threat_id: r.id,
      domain: r.malicious_domain || hostOfUrl(r.malicious_url) || r.malicious_url || "",
      brand_id: r.target_brand_id,
      brand_name: r.brand_name,
      idp: idp ? IDP_PROVIDER_LABEL[idp] : null,
      vector,
      status: r.status,
      created_at: toIso(r.created_at),
    });
  }

  const mitre = IDP_MITRE.map((m) => ({
    id: m.id,
    name: m.name,
    tactic: m.tactic,
    vectors: [...m.vectors],
    count: m.vectors.reduce((sum, v) => sum + (vecCount.get(v) ?? 0), 0),
  }));

  return {
    window,
    generated_at: now.toISOString(),
    kpis: {
      detections,
      detections_prev: detectionsPrev,
      brands_targeted: brands.size,
      idps_impersonated: idpsSeen.size,
      live,
      taken_down: takenDown,
      lookalikes_flagged: lureRow?.n ?? 0,
    },
    trend,
    by_vector,
    by_idp,
    top_brands,
    recent,
    mitre,
  };
}

export async function handleIdentityThreats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const window = parseIdentityWindow(new URL(request.url).searchParams.get("window"));
  if (!window) {
    return json({ success: false, error: "window must be 7d or 30d" }, 400, origin);
  }
  try {
    const data = await cachedValue<IdentityThreatsData>(
      env,
      `idp.summary.${window}`,
      IDENTITY_THREATS_TTL_SECONDS,
      () => computeIdentityThreats(env, getDbContext(request), window),
    );
    return json({ success: true, data }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
