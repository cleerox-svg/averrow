// Averrow — D1 database registry + store accessor
//
// ONE description of every database the Worker binds: its binding name, the
// per-environment database name / id, its migrations directory, whether the
// binding is required, and what it is for. `test/db-registry.test.ts` parses
// wrangler.toml and fails if this table and the `[[d1_databases]]` /
// `[[env.*.d1_databases]]` blocks disagree in either direction, so this file
// cannot silently drift from what is deployed.
//
// `store(env, id)` is the seam for a later move of a store off D1 (e.g. the
// core store to Postgres): new code that only needs `prepare` / `batch` reads
// a store through it and is typed against that subset (`StoreDb`), so it does
// not grow a dependency on D1-only surface (sessions, dump, exec).
//
// Database names / ids here are configuration, mirrored from wrangler.toml —
// not measurements. Sizes and table counts are measured at runtime
// (lib/db-sizes.ts).

import type { Env } from "../types";

export type StoreId = "core" | "audit" | "geo" | "dnsq" | "telemetry" | "archive";
export type DeployEnv = "prod" | "staging" | "dev";

export interface DbSpec {
  id: StoreId;
  /** Env binding name (wrangler.toml `binding`). */
  binding: string;
  /** wrangler.toml `database_name` per environment; null = not bound there. */
  databaseName: Record<DeployEnv, string | null>;
  /** wrangler.toml `database_id` per environment; null = not bound there. */
  databaseId: Record<DeployEnv, string | null>;
  /** wrangler.toml `migrations_dir`, relative to packages/averrow-worker. */
  migrationsDir: string;
  /** Required = typed non-optional on Env and bound in every environment. */
  required: boolean;
  role: string;
  /**
   * Store to serve when this binding is absent. Only `telemetry` sets one
   * (core: until the cut-over the wave-1 tables live on core, and dev has
   * no telemetry DB). The DNS queue's main-DB fallback was removed in PR-4,
   * an absent GEOIP_DB is a clean no-op for its callers, and an absent
   * ARCHIVE_DB must be handled by its callers, so `store()` throws instead.
   * Note: which DB the telemetry *cluster* is served from is decided by
   * lib/db-route.ts `telemetryStore()` (KV flag), not by this fallback.
   */
  fallback?: StoreId;
}

/** D1's per-database storage cap (10 GB on Workers Paid). */
export const D1_DB_CAP_BYTES = 10 * 1024 ** 3;

export const DB_REGISTRY: readonly DbSpec[] = [
  {
    id: "core",
    binding: "DB",
    databaseName: {
      prod: "trust-radar-v2",
      staging: "trust-radar-v2-staging",
      dev: "trust-radar-v2-dev",
    },
    databaseId: {
      prod: "a3776a5f-c07c-4e20-9f3b-8d7f8c7f90c6",
      staging: "7709322c-7020-41f9-ad96-aa797cf585de",
      dev: "83f702ee-3600-4f0a-84e8-102c49765429",
    },
    migrationsDir: "migrations",
    required: true,
    role: "Primary platform database (threats, brands, agents, tenants)",
  },
  {
    id: "audit",
    binding: "AUDIT_DB",
    databaseName: {
      prod: "trust-radar-v2-audit",
      staging: "trust-radar-v2-audit-staging",
      dev: "trust-radar-v2-audit-dev",
    },
    databaseId: {
      prod: "55d58eff-47f3-4533-afa4-e52d494376e0",
      staging: "45539971-b965-4bfb-a1d3-93a03771b1c4",
      dev: "3f2c2683-bc2b-474a-b61a-89d80bb2cded",
    },
    migrationsDir: "migrations-audit",
    required: true,
    role: "Audit log",
  },
  {
    id: "geo",
    binding: "GEOIP_DB",
    databaseName: { prod: "geoip-db", staging: null, dev: null },
    databaseId: { prod: "f47a6b18-b343-46d9-87e8-ef8ef4aa8521", staging: null, dev: null },
    migrationsDir: "migrations-geoip",
    required: false,
    role: "MaxMind GeoLite2 reference ranges (Cartographer Phase 0.5)",
  },
  {
    id: "dnsq",
    binding: "DNS_QUEUE_DB",
    databaseName: { prod: "trust-radar-dns-queue", staging: null, dev: null },
    databaseId: { prod: "b2c6dae6-26d4-4d03-b3ff-08709bcf04c9", staging: null, dev: null },
    migrationsDir: "migrations-dns-queue",
    required: false,
    role: "DNS resolution work queue",
  },
  {
    id: "telemetry",
    binding: "TELEMETRY_DB",
    databaseName: { prod: "averrow-telemetry", staging: "averrow-telemetry-staging", dev: null },
    databaseId: {
      prod: "67ebf20d-6176-4a5a-8da2-338c1f9e9399",
      staging: "beac6ee0-5c86-4aba-8218-788c2d0c0e35",
      dev: null,
    },
    migrationsDir: "migrations-telemetry",
    required: false,
    role: "Agent runs, feed history, agent events, AI ledger",
    fallback: "core",
  },
  {
    id: "archive",
    binding: "ARCHIVE_DB",
    databaseName: { prod: "averrow-archive", staging: "averrow-archive-staging", dev: null },
    databaseId: {
      prod: "90c13d5a-182e-414d-9320-6241c9a62593",
      staging: "9efead5b-89fc-49bc-88a9-c6c4cd744113",
      dev: null,
    },
    migrationsDir: "migrations-archive",
    required: false,
    role: "Index of threats archived to R2",
  },
];

/**
 * KV namespace bindings, mirrored from wrangler.toml `[[kv_namespaces]]` /
 * `[[env.*.kv_namespaces]]` (pinned by test/db-registry.test.ts). Explicit
 * on purpose: duck-typing env would also match RPC / Fetcher proxies.
 */
export const KV_REGISTRY: readonly { binding: string; role: string }[] = [
  { binding: "CACHE", role: "Page-load / counter cache, locks, cursors" },
];

/** KV_REGISTRY bindings actually present on this env. */
export function boundKvNamespaces(env: Env): string[] {
  const rec = env as unknown as Record<string, unknown>;
  return KV_REGISTRY.map((k) => k.binding).filter((b) => rec[b] != null);
}

/** The D1 surface a store exposes to new code — keep it this narrow. */
export type StoreDb = Pick<D1Database, "prepare" | "batch">;

export class StoreUnavailableError extends Error {
  constructor(readonly storeId: StoreId) {
    super(`store_unavailable: ${storeId} has no binding in this environment`);
    this.name = "StoreUnavailableError";
  }
}

export function specFor(id: StoreId): DbSpec {
  const spec = DB_REGISTRY.find((s) => s.id === id);
  // Unreachable for a StoreId; keeps the lookup total without a cast.
  if (!spec) throw new Error(`db-registry: unknown store ${id}`);
  return spec;
}

function bindingValue(env: Env, binding: string): D1Database | undefined {
  // Presence, not shape: a binding is bound when env carries an object for
  // it (test doubles often implement only the methods they exercise).
  const v = (env as unknown as Record<string, unknown>)[binding];
  return v != null && typeof v === "object" ? (v as D1Database) : undefined;
}

/**
 * The raw D1 binding for a store (fallback-aware), or undefined when neither
 * it nor its fallback is bound. For D1-specific helpers (lib/db.ts sessions);
 * everything else should use `store()`.
 */
export function storeBinding(env: Env, id: StoreId): D1Database | undefined {
  const seen = new Set<StoreId>();
  let cur: StoreId | undefined = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const spec = specFor(cur);
    const db = bindingValue(env, spec.binding);
    if (db) return db;
    cur = spec.fallback;
  }
  return undefined;
}

/**
 * The database for a store. `store(env, 'core') === env.DB`. Throws
 * StoreUnavailableError when the store (and its fallback, if any) is not
 * bound — use `hasStore()` first for an optional store.
 */
export function store(env: Env, id: StoreId): StoreDb {
  const db = storeBinding(env, id);
  if (!db) throw new StoreUnavailableError(id);
  return db;
}

/** Whether the store itself (not a fallback) is bound in this env. */
export function hasStore(env: Env, id: StoreId): boolean {
  return bindingValue(env, specFor(id).binding) !== undefined;
}

/** Deploy environment from `env.ENVIRONMENT` (wrangler `[vars]`); null if unrecognised. */
export function deployEnvOf(env: Pick<Env, "ENVIRONMENT">): DeployEnv | null {
  switch (env.ENVIRONMENT) {
    case "production": return "prod";
    case "staging": return "staging";
    case "development": return "dev";
    default: return null;
  }
}

/** The registry entry owning a D1 database id (any environment), if any. */
export function storeForDatabaseId(id: string): DbSpec | undefined {
  const needle = id.toLowerCase();
  return DB_REGISTRY.find((s) =>
    Object.values(s.databaseId).some((v) => v != null && v.toLowerCase() === needle));
}

/** `{ name, store }` label for a database id; nulls for a database outside the registry. */
export function labelDatabaseId(id: string): { name: string | null; store: StoreId | null } {
  const spec = storeForDatabaseId(id);
  if (!spec) return { name: null, store: null };
  const needle = id.toLowerCase();
  const envKey = (Object.keys(spec.databaseId) as DeployEnv[])
    .find((k) => spec.databaseId[k]?.toLowerCase() === needle);
  return { name: envKey ? spec.databaseName[envKey] : null, store: spec.id };
}

/** Add `name` / `store` to every `{ database_id }` row (additive; other fields untouched). */
export function labelPerDatabase<T extends { database_id: string }>(
  rows: readonly T[],
): Array<T & { name: string | null; store: StoreId | null }> {
  return rows.map((r) => ({ ...r, ...labelDatabaseId(r.database_id) }));
}
