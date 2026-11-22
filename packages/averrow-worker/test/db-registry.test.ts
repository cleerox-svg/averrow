/**
 * lib/db-registry.ts — pinned against wrangler.toml in both directions.
 *
 * Every `[[d1_databases]]` / `[[env.<name>.d1_databases]]` block must match a
 * registry entry (binding, database_name, database_id, migrations_dir) for
 * that environment, and every non-null registry (env, store) must have its
 * block. Every migrationsDir must exist and have a `db:migrate:*:prod`
 * script naming its binding.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  DB_REGISTRY,
  D1_DB_CAP_BYTES,
  store,
  storeBinding,
  hasStore,
  storeForDatabaseId,
  labelDatabaseId,
  labelPerDatabase,
  deployEnvOf,
  StoreUnavailableError,
  KV_REGISTRY,
  boundKvNamespaces,
  type DeployEnv,
} from "../src/lib/db-registry";
import { METERED_D1_BINDINGS } from "../src/lib/d1-meter";
import { getAgentDb, getWriteDb } from "../src/lib/db";
import type { Env } from "../src/types";

const ROOT = resolve(__dirname, "..");

interface TomlD1Block {
  env: DeployEnv;
  binding?: string;
  database_name?: string;
  database_id?: string;
  migrations_dir?: string;
}

/** Minimal parser: `[[d1_databases]]` / `[[env.X.d1_databases]]` blocks of `key = "value"` lines. */
function parseD1Blocks(toml: string): TomlD1Block[] {
  const envMap: Record<string, DeployEnv> = { staging: "staging", dev: "dev" };
  const blocks: TomlD1Block[] = [];
  let cur: TomlD1Block | null = null;
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      cur = null;
      const top = /^\[\[d1_databases\]\]$/.exec(line);
      const envd = /^\[\[env\.(\w+)\.d1_databases\]\]$/.exec(line);
      if (top) cur = { env: "prod" };
      else if (envd) {
        const e = envMap[envd[1] ?? ""];
        if (!e) throw new Error(`unknown wrangler env ${envd[1]}`);
        cur = { env: e };
      }
      if (cur) blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^(\w+)\s*=\s*"([^"]*)"/.exec(line);
    if (kv && kv[1] && kv[2] !== undefined) {
      (cur as unknown as Record<string, string>)[kv[1]] = kv[2];
    }
  }
  return blocks;
}

const toml = readFileSync(resolve(ROOT, "wrangler.toml"), "utf8");
const blocks = parseD1Blocks(toml);
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("DB_REGISTRY ↔ wrangler.toml", () => {
  it("parses the expected number of d1 blocks", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });

  it("every wrangler d1 block matches a registry entry", () => {
    for (const b of blocks) {
      const spec = DB_REGISTRY.find((s) => s.binding === b.binding);
      expect(spec, `no registry entry for binding ${b.binding} (${b.env})`).toBeDefined();
      if (!spec) continue;
      expect(spec.databaseName[b.env], `${b.binding} ${b.env} name`).toBe(b.database_name);
      expect(spec.databaseId[b.env], `${b.binding} ${b.env} id`).toBe(b.database_id);
      expect(spec.migrationsDir, `${b.binding} ${b.env} migrations_dir`).toBe(b.migrations_dir);
    }
  });

  it("every non-null registry (env, store) has its wrangler block, and vice versa nulls have none", () => {
    for (const spec of DB_REGISTRY) {
      for (const env of ["prod", "staging", "dev"] as const) {
        const block = blocks.find((b) => b.env === env && b.binding === spec.binding);
        if (spec.databaseId[env] == null) {
          expect(block, `${spec.binding} unexpectedly bound in ${env}`).toBeUndefined();
          expect(spec.databaseName[env]).toBeNull();
        } else {
          expect(block, `${spec.binding} missing in ${env}`).toBeDefined();
        }
      }
    }
  });

  it("required stores are bound in every environment", () => {
    for (const spec of DB_REGISTRY.filter((s) => s.required)) {
      for (const env of ["prod", "staging", "dev"] as const) {
        expect(spec.databaseId[env], `${spec.id} ${env}`).not.toBeNull();
      }
    }
  });

  it("ids and bindings are unique", () => {
    expect(new Set(DB_REGISTRY.map((s) => s.id)).size).toBe(DB_REGISTRY.length);
    expect(new Set(DB_REGISTRY.map((s) => s.binding)).size).toBe(DB_REGISTRY.length);
  });

  it("every migrationsDir exists and has a db:migrate:*:prod script for its binding", () => {
    for (const spec of DB_REGISTRY) {
      const dir = resolve(ROOT, spec.migrationsDir);
      expect(existsSync(dir) && statSync(dir).isDirectory(), `${spec.migrationsDir} missing`).toBe(true);
      const script = Object.entries(pkg.scripts).find(([name, cmd]) =>
        /^db:migrate:(?:[\w-]+:)?prod$/.test(name) &&
        new RegExp(`migrations apply ${spec.binding} --remote`).test(cmd));
      expect(script, `no db:migrate:*:prod for ${spec.binding}`).toBeDefined();
    }
  });
});

describe("KV_REGISTRY ↔ wrangler.toml [[kv_namespaces]]", () => {
  const kvBindings = new Set<string>();
  let inKv = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inKv = /^\[\[(?:env\.\w+\.)?kv_namespaces\]\]$/.test(line);
      continue;
    }
    const m = inKv ? /^binding\s*=\s*"([^"]+)"/.exec(line) : null;
    if (m?.[1]) kvBindings.add(m[1]);
  }

  it("matches the wrangler KV bindings exactly", () => {
    expect(kvBindings.size).toBeGreaterThan(0);
    expect(new Set(KV_REGISTRY.map((k) => k.binding))).toEqual(kvBindings);
  });

  it("lists only registry KV bindings present on env — never Fetcher / RPC proxies", () => {
    const kvLike = { get() {}, put() {}, list() {}, getWithMetadata() {} };
    const env = { CACHE: {}, ASSETS: kvLike, BROWSER: kvLike } as unknown as Env;
    expect(boundKvNamespaces(env)).toEqual(["CACHE"]);
    expect(boundKvNamespaces({} as unknown as Env)).toEqual([]);
  });
});

describe("store accessor", () => {
  const DB = { prepare: () => ({}), batch: async () => [] };
  const AUDIT_DB = { prepare: () => ({}), batch: async () => [] };
  const env = { DB, AUDIT_DB } as unknown as Env;

  it("core is env.DB; getAgentDb / getWriteDb delegate to it", () => {
    expect(store(env, "core")).toBe(DB);
    expect(getAgentDb(env)).toBe(DB);
    expect(getWriteDb(env, { bookmark: null })).toBe(DB);
    expect(store(env, "audit")).toBe(AUDIT_DB);
  });

  it("an unbound optional store throws StoreUnavailableError (no fallback configured)", () => {
    expect(hasStore(env, "dnsq")).toBe(false);
    expect(storeBinding(env, "dnsq")).toBeUndefined();
    expect(() => store(env, "dnsq")).toThrow(StoreUnavailableError);
  });

  it("METERED_D1_BINDINGS is derived from the registry", () => {
    expect([...METERED_D1_BINDINGS]).toEqual(DB_REGISTRY.map((s) => s.binding));
    expect(METERED_D1_BINDINGS).toEqual(expect.arrayContaining(["DB", "AUDIT_DB", "GEOIP_DB", "DNS_QUEUE_DB"]));
  });

  it("labels database ids", () => {
    const core = DB_REGISTRY.find((s) => s.id === "core");
    const prodId = core?.databaseId.prod ?? "";
    expect(storeForDatabaseId(prodId.toUpperCase())?.id).toBe("core");
    expect(labelDatabaseId(core?.databaseId.staging ?? "")).toEqual({ name: "trust-radar-v2-staging", store: "core" });
    expect(labelDatabaseId("not-a-db")).toEqual({ name: null, store: null });
    expect(labelPerDatabase([{ database_id: prodId, rows_read: 5 }])).toEqual([
      { database_id: prodId, rows_read: 5, name: "trust-radar-v2", store: "core" },
    ]);
  });

  it("maps ENVIRONMENT to a deploy env and exposes the 10 GB cap", () => {
    expect(deployEnvOf({ ENVIRONMENT: "production" })).toBe("prod");
    expect(deployEnvOf({ ENVIRONMENT: "staging" })).toBe("staging");
    expect(deployEnvOf({ ENVIRONMENT: "development" })).toBe("dev");
    expect(deployEnvOf({ ENVIRONMENT: "x" })).toBeNull();
    expect(D1_DB_CAP_BYTES).toBe(10 * 1024 ** 3);
  });
});
