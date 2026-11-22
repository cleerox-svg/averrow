// Averrow — measured D1 database sizes for every registry store
//
// Replaces the literal sizes the system-health payload used to ship
// (`sizeMb: 79.5` while prod was ~5.4 GB). Two sources, best first:
//
//   1. Cloudflare D1 REST list (`GET /accounts/{id}/d1/database`) — the
//      `file_size` / `num_tables` Cloudflare itself reports, matched to the
//      registry by database uuid. Needs CF_ACCOUNT_ID + a token with
//      Account › D1 › Read: CF_OPS_API_TOKEN first, then CF_API_TOKEN. A
//      401/403 (token lacks the scope), any other HTTP error, a network
//      error or a timeout tries the next token, then drops to (2) — never
//      fails the caller. The outcome is reported as `cf_api_status`.
//   2. PRAGMA page_count × page_size + a sqlite_master table count on the
//      bound database. See `source: 'pragma'` caveats on DbSizeRow.
//
// Anything neither source can measure is null. The block is KV-cached 1h
// (cachedValue `infra.db_sizes.v2`, single-flight refill); a result with any
// unmeasured bound store is cached 5 min so a transient failure heals quickly.

import type { Env } from "../types";
import { cachedValue } from "./cached-value";
import {
  boundKvNamespaces,
  DB_REGISTRY,
  D1_DB_CAP_BYTES,
  deployEnvOf,
  hasStore,
  storeBinding,
  type DbSpec,
  type StoreId,
} from "./db-registry";

export interface DbSizeRow {
  store: StoreId;
  /** Database name for this environment (registry config); null if unknown. */
  name: string | null;
  /** Measured size in bytes; null when not measurable / not bound. */
  sizeBytes: number | null;
  /** User tables (CF `num_tables`, or sqlite_master minus sqlite_ / _cf_ tables). */
  tables: number | null;
  /**
   * `cf_api` = Cloudflare's own figure. `pragma` = page_count × page_size on
   * a (possibly lagging) read: includes free-list pages, excludes nothing D1
   * keeps outside the main file. null = unmeasured.
   */
  source: "cf_api" | "pragma" | null;
  capBytes: number;
}

/**
 * Outcome of the CF D1 list lookup — status text only, never a token or a
 * response body. With two tokens configured, `ok` if either worked, else the
 * LAST attempt's failure.
 */
export type CfApiStatus =
  | "ok"
  | "no_credentials"
  | "timeout"
  | "network"
  | "api_error"
  | `http_${number}`;

export interface DbSizesBlock {
  databases: DbSizeRow[];
  cf_api_status: CfApiStatus;
}

export const DB_SIZES_CACHE_KEY = "infra.db_sizes.v2";
export const DB_SIZES_TTL_S = 3600;
const DB_SIZES_DEGRADED_TTL_S = 300;
const CF_API_TIMEOUT_MS = 5000;
/** One page covers the account (CF allows up to 10000 per page). */
const CF_LIST_PER_PAGE = 1000;

interface CfD1ListEntry {
  uuid?: unknown;
  file_size?: unknown;
  num_tables?: unknown;
}

/** uuid (lowercased) → { file_size, num_tables } from the CF D1 list. */
type CfSizes = Map<string, { sizeBytes: number | null; tables: number | null }>;

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** CF D1 list with the ops token, else the general token. */
async function fetchCfD1List(env: Env): Promise<{ list: CfSizes | null; status: CfApiStatus }> {
  const accountId = env.CF_ACCOUNT_ID;
  const tokens = [env.CF_OPS_API_TOKEN, env.CF_API_TOKEN]
    .filter((t, i, all): t is string => !!t && all.indexOf(t) === i);
  if (!accountId || tokens.length === 0) return { list: null, status: "no_credentials" };
  let status: CfApiStatus = "no_credentials";
  for (const token of tokens) {
    const r = await fetchCfD1ListWith(accountId, token);
    if (r.list) return r;
    status = r.status;
  }
  return { list: null, status };
}

async function fetchCfD1ListWith(
  accountId: string,
  token: string,
): Promise<{ list: CfSizes | null; status: CfApiStatus }> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database?per_page=${CF_LIST_PER_PAGE}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CF_API_TIMEOUT_MS),
      },
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { list: null, status: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
  // 401/403: token without D1:Read — expected on some deploys; fall back.
  if (!res.ok) return { list: null, status: `http_${res.status}` };
  try {
    const body = (await res.json()) as { success?: unknown; result?: unknown };
    if (body.success !== true || !Array.isArray(body.result)) return { list: null, status: "api_error" };
    const out: CfSizes = new Map();
    for (const raw of body.result as CfD1ListEntry[]) {
      if (typeof raw.uuid !== "string") continue;
      out.set(raw.uuid.toLowerCase(), {
        sizeBytes: finiteOrNull(raw.file_size),
        tables: finiteOrNull(raw.num_tables),
      });
    }
    return { list: out, status: "ok" };
  } catch {
    return { list: null, status: "api_error" };
  }
}

async function safeFirst<T>(db: D1Database, sql: string): Promise<T | null> {
  try {
    return await db.prepare(sql).first<T>();
  } catch {
    return null;
  }
}

/** User tables in one bound database (sqlite_master minus sqlite_ / _cf_ tables). */
async function userTableCount(db: D1Database): Promise<number | null> {
  const row = await safeFirst<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  );
  return finiteOrNull(row?.n);
}

/** PRAGMA fallback for one bound database. Sequential, three tiny reads. */
async function pragmaSize(db: D1Database): Promise<{ sizeBytes: number | null; tables: number | null }> {
  const pageSize = await safeFirst<{ page_size: number }>(db, "PRAGMA page_size");
  const pageCount = await safeFirst<{ page_count: number }>(db, "PRAGMA page_count");
  const ps = finiteOrNull(pageSize?.page_size);
  const pc = finiteOrNull(pageCount?.page_count);
  return {
    sizeBytes: ps != null && pc != null && ps > 0 ? ps * pc : null,
    tables: await userTableCount(db),
  };
}

/** Measure every registry store, uncached. Never throws. */
export async function measureDatabaseSizes(env: Env): Promise<DbSizesBlock> {
  const deployEnv = deployEnvOf(env);
  const cf = await fetchCfD1List(env);
  const databases: DbSizeRow[] = [];
  for (const spec of DB_REGISTRY) {
    databases.push(await measureOne(env, spec, deployEnv, cf.list));
  }
  return { databases, cf_api_status: cf.status };
}

async function measureOne(
  env: Env,
  spec: DbSpec,
  deployEnv: ReturnType<typeof deployEnvOf>,
  cfList: CfSizes | null,
): Promise<DbSizeRow> {
  const base = {
    store: spec.id,
    name: deployEnv ? spec.databaseName[deployEnv] : null,
    capBytes: D1_DB_CAP_BYTES,
  };
  const dbId = deployEnv ? spec.databaseId[deployEnv] : null;
  const cf = dbId && cfList ? cfList.get(dbId.toLowerCase()) : undefined;
  // Only measure the store's OWN binding — a fallback's size would be a lie.
  const db = hasStore(env, spec.id) ? storeBinding(env, spec.id) : undefined;
  if (cf && cf.sizeBytes != null) {
    // The CF list reports num_tables = 0 for every database (seen in prod
    // 2026-11-22), so a 0 there is "not reported", not "empty": count from
    // sqlite_master on the store's own binding instead (one tiny read).
    const tables = cf.tables != null && cf.tables > 0
      ? cf.tables
      : db ? await userTableCount(db) : null;
    return { ...base, sizeBytes: cf.sizeBytes, tables, source: "cf_api" };
  }
  if (!db) return { ...base, sizeBytes: null, tables: null, source: null };
  const p = await pragmaSize(db);
  return {
    ...base,
    sizeBytes: p.sizeBytes,
    tables: p.tables ?? cf?.tables ?? null,
    source: p.sizeBytes != null ? "pragma" : null,
  };
}

/**
 * The system-health `infrastructure` block (handlers/admin/health.ts).
 * mainDb / auditDb keep their legacy keys; anything unmeasured is null
 * (`region` has no measured source and stays the fixed 'ENAM').
 * `databases[]` + `cf_api_status` are additive.
 */
export async function systemHealthInfrastructure(env: Env) {
  const { databases, cf_api_status } = await getDatabaseSizes(env);
  const main = databases.find((d) => d.store === "core");
  const audit = databases.find((d) => d.store === "audit");
  return {
    mainDb: {
      name: main?.name ?? null,
      sizeMb: main?.sizeBytes != null ? Math.round((main.sizeBytes / 1024 / 1024) * 10) / 10 : null,
      tables: main?.tables ?? null,
      region: "ENAM",
    },
    auditDb: {
      name: audit?.name ?? null,
      sizeKb: audit?.sizeBytes != null ? Math.round(audit.sizeBytes / 1024) : null,
      tables: audit?.tables ?? null,
      region: "ENAM",
    },
    worker: { name: "averrow-worker", platform: "Cloudflare Workers" },
    kvNamespaces: boundKvNamespaces(env).map((name) => ({ name })),
    databases,
    cf_api_status,
  };
}

/** Registry sizes, KV-cached 1h (5 min when a bound store went unmeasured). */
export function getDatabaseSizes(env: Env): Promise<DbSizesBlock> {
  return cachedValue<DbSizesBlock>(env, DB_SIZES_CACHE_KEY, DB_SIZES_TTL_S, () => measureDatabaseSizes(env), {
    ttlFor: (block) =>
      block.databases.some((r) => r.sizeBytes == null && hasStore(env, r.store))
        ? DB_SIZES_DEGRADED_TTL_S
        : DB_SIZES_TTL_S,
    singleFlight: { lockTtlSeconds: 60, waitMs: 10_000 },
  });
}
