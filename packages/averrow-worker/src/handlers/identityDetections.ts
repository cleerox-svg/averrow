// Averrow — Identity Provider Impersonation drill-down
// GET /api/intel/identity-threats/detections            (requireStaff)
// GET /api/intel/identity-threats/detections/:threatId  (requireStaff)
//
// Contract: the IdP drill-down API contract (list + detail), mirrored by the
// ops identity-threats feature. Window math, family techniques, labels and
// idp resolution are shared with the summary (handlers/identityThreats.ts) —
// a row the summary counts is a row this list returns, with the same idp.
//
// Cost:
//   * List — `technique IN (family ∩ vectors) AND created_at >= since` is an
//     indexed range on idx_threats_technique_created (migration 0288); idp /
//     brand / keyset-cursor predicates are residual. Ordering across several
//     techniques needs a temp B-tree over the window's family rows only (the
//     same shape the summary's `recent` query already runs). The page itself
//     is NOT cached: every cursor + filter combination is its own key, so a
//     staff drill-down would almost never hit, and the miss path is already
//     an index range over a small family. `total` (same filters, no cursor)
//     IS cached — cachedCount 120s, key encodes window day + every filter —
//     so paging through a result set re-counts at most once per 2 minutes.
//   * Detail — one primary-key read with LEFT JOINs (brands, hosting_providers,
//     infrastructure_clusters) plus one takedown lookup on the partial index
//     idx_takedown_requests_threat_source (migration 0289), in parallel.

import { json } from "../lib/cors";
import { getDbContext, getReadSession } from "../lib/db";
import { cachedCount } from "../lib/cached-count";
import {
  IDP_FAMILY_TECHNIQUES,
  IDP_MITRE,
  IDP_PROVIDER_LABEL,
  IDP_VECTOR_LABEL,
  classifyIdpImpersonation,
  techniqueToVector,
  type IdpProvider,
  type IdpVector,
} from "../lib/idp-impersonation";
import { brandTokensFrom } from "../lib/idp-tagging";
import {
  VECTORS,
  d1Time,
  hostOfUrl,
  identityWindowSinceMs,
  isProvider,
  parseIdentityWindow,
  resolveIdp,
  toIso,
  type IdentityWindow,
} from "./identityThreats";
import type { Env } from "../types";

export const DETECTIONS_DEFAULT_LIMIT = 25;
export const DETECTIONS_MAX_LIMIT = 100;
export const DETECTIONS_TOTAL_TTL_SECONDS = 120;
const MAX_BRAND_ID_LENGTH = 128;
/** Brand and threat ids are opaque tokens — no whitespace or quoting. */
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

// ─── Contract types ──────────────────────────────────────────────────

export interface IdentityDetectionListItem {
  threat_id: string;
  domain: string;
  url: string | null;
  brand_id: string | null;
  brand_name: string | null;
  idp: string | null;
  idp_label: string | null;
  vector: IdpVector;
  vector_label: string;
  status: string;
  severity: string | null;
  source_feed: string | null;
  created_at: string;
}

export interface IdentityDetectionList {
  items: IdentityDetectionListItem[];
  next_cursor: string | null;
  total: number;
}

export interface IdentityDetectionDetail extends IdentityDetectionListItem {
  technique: string;
  matched_lure: string | null;
  ttps: Array<{ id: string; name: string; tactic: string; url: string }>;
  infrastructure: {
    ip_address: string | null;
    country_code: string | null;
    asn: string | null;
    hosting_provider: { id: string; name: string } | null;
    ssl_cert_issuer: string | null;
  };
  registration: {
    domain_created_at: string | null;
    domain_age_days: number | null;
    weaponization_hours: number | null;
    weaponization_flag: string | null;
  };
  reputation: {
    vt_checked: boolean; vt_malicious: number | null;
    gsb_checked: boolean; gsb_flagged: boolean | null; gsb_threat_type: string | null;
    greynoise_checked: boolean; greynoise_classification: string | null;
    seclookup_checked: boolean; seclookup_risk_score: number | null;
    surbl_listed: boolean | null; dbl_listed: boolean | null;
  };
  timeline: { first_seen: string | null; last_seen: string | null; created_at: string; enriched_at: string | null };
  takedown: { id: string; status: string; updated_at: string | null } | null;
  cluster: { id: string; name: string | null } | null;
}

// ─── Query parsing ───────────────────────────────────────────────────

interface DetectionCursor { created_at: string; id: string }

export interface DetectionQuery {
  window: IdentityWindow;
  idp: IdpProvider | null;
  /** Vectors left after `vector` ∩ `mitre` — canonical order; may be empty. */
  vectors: IdpVector[];
  brandId: string | null;
  limit: number;
  cursor: DetectionCursor | null;
}

function isVector(v: string): v is IdpVector {
  return (VECTORS as readonly string[]).includes(v);
}

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Opaque keyset cursor: base64url of the raw `[created_at, id]` pair. The
 *  raw D1 text is kept (not ISO) so it compares against the column as-is. */
export function encodeDetectionCursor(c: DetectionCursor): string {
  return base64UrlEncode(JSON.stringify([c.created_at, c.id]));
}

export function decodeDetectionCursor(raw: string): DetectionCursor | null {
  const text = base64UrlDecode(raw);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string"
        && v[0] !== "" && v[1] !== "") {
      return { created_at: v[0], id: v[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

export function parseDetectionQuery(
  params: URLSearchParams,
): { ok: true; query: DetectionQuery } | { ok: false; error: string } {
  const window = parseIdentityWindow(params.get("window"));
  if (!window) return { ok: false, error: "window must be 7d or 30d" };

  const idpRaw = params.get("idp") || null;
  if (idpRaw !== null && !isProvider(idpRaw)) {
    return { ok: false, error: `idp must be one of ${Object.keys(IDP_PROVIDER_LABEL).join(", ")}` };
  }

  const vectorRaw = params.get("vector") || null;
  if (vectorRaw !== null && !isVector(vectorRaw)) {
    return { ok: false, error: `vector must be one of ${VECTORS.join(", ")}` };
  }

  const mitreRaw = params.get("mitre") || null;
  const mitre = mitreRaw === null ? null : IDP_MITRE.find((m) => m.id === mitreRaw) ?? null;
  if (mitreRaw !== null && !mitre) {
    return { ok: false, error: `mitre must be one of ${IDP_MITRE.map((m) => m.id).join(", ")}` };
  }

  const brandId = params.get("brand_id") || null;
  if (brandId !== null && brandId.length > MAX_BRAND_ID_LENGTH) {
    return { ok: false, error: "brand_id is too long" };
  }
  if (brandId !== null && !ID_PATTERN.test(brandId)) {
    return { ok: false, error: "brand_id is malformed" };
  }

  let limit = DETECTIONS_DEFAULT_LIMIT;
  const limitRaw = params.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^\d+$/.test(limitRaw)) return { ok: false, error: `limit must be an integer 1..${DETECTIONS_MAX_LIMIT}` };
    limit = Number(limitRaw);
    if (limit < 1 || limit > DETECTIONS_MAX_LIMIT) {
      return { ok: false, error: `limit must be an integer 1..${DETECTIONS_MAX_LIMIT}` };
    }
  }

  const cursorRaw = params.get("cursor") || null;
  const cursor = cursorRaw === null ? null : decodeDetectionCursor(cursorRaw);
  if (cursorRaw !== null && !cursor) return { ok: false, error: "invalid cursor" };

  const vectors = VECTORS.filter((v) =>
    (vectorRaw === null || v === vectorRaw) && (mitre === null || mitre.vectors.includes(v)));

  return { ok: true, query: { window, idp: idpRaw, vectors, brandId, limit, cursor } };
}

// ─── SQL ─────────────────────────────────────────────────────────────

const PROVIDER_IDS = Object.keys(IDP_PROVIDER_LABEL);
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/**
 * Shared WHERE for list + total. Only `?` placeholders are interpolated;
 * every value is bound. The leading `technique IN (...) AND created_at >= ?`
 * pair is the idx_threats_technique_created range; the rest is residual.
 */
export function buildDetectionWhere(
  q: DetectionQuery,
  since: string,
): { sql: string; binds: unknown[] } {
  const techniques = IDP_FAMILY_TECHNIQUES.filter((t) => {
    const v = techniqueToVector(t);
    return v !== null && q.vectors.includes(v);
  });
  const parts = [`t.technique IN (${placeholders(techniques.length)})`, "t.created_at >= ?"];
  const binds: unknown[] = [...techniques, since];

  if (q.idp) {
    // Mirror resolveIdp(): a device-code row whose stored idp is missing or
    // unrecognised displays as entra, so it must also FILTER as entra.
    const deviceTechniques = techniques.filter((t) => techniqueToVector(t) === "device_code");
    if (q.idp === "entra" && deviceTechniques.length > 0) {
      parts.push(
        `(t.impersonated_idp = ? OR (t.technique IN (${placeholders(deviceTechniques.length)})
           AND (t.impersonated_idp IS NULL OR t.impersonated_idp NOT IN (${placeholders(PROVIDER_IDS.length)}))))`,
      );
      binds.push(q.idp, ...deviceTechniques, ...PROVIDER_IDS);
    } else {
      parts.push("t.impersonated_idp = ?");
      binds.push(q.idp);
    }
  }
  if (q.brandId) {
    // Unary `+` keeps this residual: without it the planner (no ANALYZE
    // stats) prefers idx_threats_brand_created's single-value equality over
    // the 4-value technique IN — a full window scan of a large brand's
    // threats instead of the small IdP family range.
    parts.push("+t.target_brand_id = ?");
    binds.push(q.brandId);
  }
  return { sql: parts.join(" AND "), binds };
}

function totalCacheKey(q: DetectionQuery, sinceDay: string): string {
  return [
    "count.idp.detections",
    q.window,
    sinceDay,
    q.idp ?? "all",
    q.vectors.join("+"),
    q.brandId ? encodeURIComponent(q.brandId) : "all",
  ].join(".");
}

interface ListRow {
  id: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  target_brand_id: string | null;
  brand_name: string | null;
  impersonated_idp: string | null;
  technique: string;
  status: string;
  severity: string | null;
  source_feed: string | null;
  created_at: string;
}

function toListItem(r: ListRow, vector: IdpVector): IdentityDetectionListItem {
  const idp = resolveIdp(r.impersonated_idp, vector);
  return {
    threat_id: r.id,
    domain: r.malicious_domain || hostOfUrl(r.malicious_url) || r.malicious_url || "",
    url: r.malicious_url,
    brand_id: r.target_brand_id,
    brand_name: r.brand_name,
    idp,
    idp_label: idp ? IDP_PROVIDER_LABEL[idp] : null,
    vector,
    vector_label: IDP_VECTOR_LABEL[vector],
    status: r.status,
    severity: r.severity,
    source_feed: r.source_feed,
    created_at: toIso(r.created_at),
  };
}

export async function listIdentityDetections(
  env: Env,
  request: Request,
  q: DetectionQuery,
  now: Date = new Date(),
): Promise<IdentityDetectionList> {
  if (q.vectors.length === 0) return { items: [], next_cursor: null, total: 0 };

  const since = d1Time(new Date(identityWindowSinceMs(q.window, now)));
  const where = buildDetectionWhere(q, since);
  const db = getReadSession(env, getDbContext(request));

  let pageSql = where.sql;
  const pageBinds = [...where.binds];
  if (q.cursor) {
    // (created_at, id) < cursor, written so `created_at <= ?` stays an
    // index-usable upper bound on the (technique, created_at) range.
    pageSql += " AND t.created_at <= ? AND (t.created_at < ? OR t.id < ?)";
    pageBinds.push(q.cursor.created_at, q.cursor.created_at, q.cursor.id);
  }
  pageBinds.push(q.limit + 1);

  const [pageRes, total] = await Promise.all([
    db.prepare(
      `SELECT t.id, t.malicious_domain, t.malicious_url, t.target_brand_id, b.name AS brand_name,
              t.impersonated_idp, t.technique, t.status, t.severity, t.source_feed, t.created_at
         FROM threats t
         LEFT JOIN brands b ON b.id = t.target_brand_id
        WHERE ${pageSql}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`,
    ).bind(...pageBinds).all<ListRow>(),
    cachedCount(env, totalCacheKey(q, since.slice(0, 10)), DETECTIONS_TOTAL_TTL_SECONDS, async () => {
      const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM threats t WHERE ${where.sql}`,
      ).bind(...where.binds).first<{ n: number }>();
      return row?.n ?? 0;
    }),
  ]);

  const rows = pageRes.results ?? [];
  const hasMore = rows.length > q.limit;
  const pageRows = hasMore ? rows.slice(0, q.limit) : rows;
  const items: IdentityDetectionListItem[] = [];
  for (const r of pageRows) {
    const vector = techniqueToVector(r.technique);
    if (vector) items.push(toListItem(r, vector));
  }
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    next_cursor: hasMore && last ? encodeDetectionCursor({ created_at: last.created_at, id: last.id }) : null,
    total,
  };
}

// ─── Detail ──────────────────────────────────────────────────────────

interface DetailRow extends ListRow {
  brand_canonical_domain: string | null;
  ip_address: string | null;
  country_code: string | null;
  asn: string | null;
  hosting_provider_id: string | null;
  hosting_provider_name: string | null;
  ssl_cert_issuer: string | null;
  domain_created_at: string | null;
  domain_age_days: number | null;
  weaponization_hours: number | null;
  weaponization_flag: string | null;
  vt_checked: number | null;
  vt_malicious: number | null;
  gsb_checked: number | null;
  gsb_flagged: number | null;
  gsb_threat_type: string | null;
  greynoise_checked: number | null;
  greynoise_classification: string | null;
  seclookup_checked: number | null;
  seclookup_risk_score: number | null;
  surbl_checked: number | null;
  surbl_listed: number | null;
  dbl_checked: number | null;
  dbl_listed: number | null;
  first_seen: string | null;
  last_seen: string | null;
  enriched_at: string | null;
  cluster_id: string | null;
  cluster_name: string | null;
}

/** https://attack.mitre.org/techniques/T1557/ ; sub-technique T1566.002 → T1566/002/. */
export function mitreUrl(id: string): string {
  return `https://attack.mitre.org/techniques/${id.replace(".", "/")}/`;
}

const isoOrNull = (v: string | null): string | null => (v ? toIso(v) : null);
const flag = (v: number | null): boolean | null => (v === null ? null : v !== 0);

export async function getIdentityDetection(
  env: Env,
  request: Request,
  threatId: string,
): Promise<IdentityDetectionDetail | null> {
  const db = getReadSession(env, getDbContext(request));
  const [row, takedown] = await Promise.all([
    db.prepare(
      `SELECT t.id, t.malicious_domain, t.malicious_url, t.target_brand_id,
              b.name AS brand_name, b.canonical_domain AS brand_canonical_domain,
              t.impersonated_idp, t.technique, t.status, t.severity, t.source_feed, t.created_at,
              t.ip_address, t.country_code, t.asn, t.hosting_provider_id, hp.name AS hosting_provider_name,
              t.ssl_cert_issuer, t.domain_created_at, t.domain_age_days,
              t.weaponization_hours, t.weaponization_flag,
              t.vt_checked, t.vt_malicious, t.gsb_checked, t.gsb_flagged, t.gsb_threat_type,
              t.greynoise_checked, t.greynoise_classification,
              t.seclookup_checked, t.seclookup_risk_score,
              t.surbl_checked, t.surbl_listed, t.dbl_checked, t.dbl_listed,
              t.first_seen, t.last_seen, t.enriched_at,
              t.cluster_id, ic.cluster_name
         FROM threats t
         LEFT JOIN brands b ON b.id = t.target_brand_id
         LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
         LEFT JOIN infrastructure_clusters ic ON ic.id = t.cluster_id
        WHERE t.id = ?`,
    ).bind(threatId).first<DetailRow>(),
    db.prepare(
      `SELECT id, status, updated_at FROM takedown_requests
        WHERE source_type = 'threat' AND source_id = ?
        ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
        LIMIT 1`,
    ).bind(threatId).first<{ id: string; status: string; updated_at: string | null }>(),
  ]);

  const vector = row ? techniqueToVector(row.technique) : null;
  if (!row || !vector) return null;

  const base = toListItem(row, vector);
  // Recomputed from the host/URL alone (no existingTechnique), so a row with
  // no observable lure — e.g. a device-code page on a neutral host — reads
  // null instead of echoing its own hostname back as "evidence".
  const classified = classifyIdpImpersonation({
    host: base.domain,
    url: row.malicious_url,
    brandTokens: brandTokensFrom(row.brand_name, row.brand_canonical_domain),
  });

  return {
    ...base,
    technique: row.technique,
    matched_lure: classified?.matched ?? null,
    ttps: IDP_MITRE.filter((m) => m.vectors.includes(vector)).map((m) => ({
      id: m.id, name: m.name, tactic: m.tactic, url: mitreUrl(m.id),
    })),
    infrastructure: {
      ip_address: row.ip_address,
      country_code: row.country_code,
      asn: row.asn,
      hosting_provider: row.hosting_provider_id && row.hosting_provider_name
        ? { id: row.hosting_provider_id, name: row.hosting_provider_name }
        : null,
      ssl_cert_issuer: row.ssl_cert_issuer,
    },
    registration: {
      domain_created_at: isoOrNull(row.domain_created_at),
      domain_age_days: row.domain_age_days,
      weaponization_hours: row.weaponization_hours,
      weaponization_flag: row.weaponization_flag,
    },
    reputation: {
      vt_checked: row.vt_checked === 1,
      vt_malicious: row.vt_checked === 1 ? row.vt_malicious : null,
      gsb_checked: row.gsb_checked === 1,
      gsb_flagged: row.gsb_checked === 1 ? flag(row.gsb_flagged) : null,
      gsb_threat_type: row.gsb_threat_type,
      greynoise_checked: row.greynoise_checked === 1,
      greynoise_classification: row.greynoise_classification,
      seclookup_checked: row.seclookup_checked === 1,
      seclookup_risk_score: row.seclookup_risk_score,
      // Listed flags default to 0 before the check runs — null until checked.
      surbl_listed: row.surbl_checked === 1 ? flag(row.surbl_listed) : null,
      dbl_listed: row.dbl_checked === 1 ? flag(row.dbl_listed) : null,
    },
    timeline: {
      first_seen: isoOrNull(row.first_seen),
      last_seen: isoOrNull(row.last_seen),
      created_at: toIso(row.created_at),
      enriched_at: isoOrNull(row.enriched_at),
    },
    takedown: takedown
      ? { id: takedown.id, status: takedown.status, updated_at: isoOrNull(takedown.updated_at) }
      : null,
    cluster: row.cluster_id ? { id: row.cluster_id, name: row.cluster_name } : null,
  };
}

// ─── Handlers ────────────────────────────────────────────────────────

export async function handleIdentityDetections(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const parsed = parseDetectionQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return json({ success: false, error: parsed.error }, 400, origin);
  try {
    const data = await listIdentityDetections(env, request, parsed.query);
    return json({ success: true, data }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleIdentityDetectionDetail(
  request: Request,
  env: Env,
  threatId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!threatId || threatId.length > MAX_BRAND_ID_LENGTH || !ID_PATTERN.test(threatId)) {
    return json({ success: false, error: "Detection not found" }, 404, origin);
  }
  try {
    const data = await getIdentityDetection(env, request, threatId);
    if (!data) return json({ success: false, error: "Detection not found" }, 404, origin);
    return json({ success: true, data }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
