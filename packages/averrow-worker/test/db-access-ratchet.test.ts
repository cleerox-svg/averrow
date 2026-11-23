/**
 * DB access ratchet (plan C2).
 *
 * 1. The number of `env.DB` references in src/ may only go DOWN. Each store
 *    move (telemetry, archive, ...) converts callers from the raw core
 *    binding to a store accessor (lib/db-registry.ts `store()`,
 *    lib/db-route.ts `telemetryStore()`); a new `env.DB` reference would
 *    quietly pin more work to core. When the count drops, lower
 *    ENV_DB_BASELINE to the new number in the same PR so the gain is locked.
 *    (Raw text count, comments included: it is a ratchet, not a parser.)
 *
 * 2. `env.TELEMETRY_DB` (or any `.TELEMETRY_DB` / `["TELEMETRY_DB"]` access)
 *    is banned outside lib/db-registry.ts and lib/db-route.ts: whether the
 *    telemetry cluster is served from core or TELEMETRY_DB is decided by
 *    the route flag, and a direct binding read would bypass it (split
 *    writes across two DBs during the cut-over).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Recorded 2026-11-22 (B1a/B1b: 2293; B1c agent-runs family moved: 2207; B1c review fixes: 2205; B1d feeds + budget families moved: 2106; dead batchInsertOutputs removed 2026-11-23: 2104; B1 wave 2 agent_outputs moved to the agents family: 2058). Lower it as callers move; never raise it. */
const ENV_DB_BASELINE = 2051;

const SRC = resolve(__dirname, "..", "src");
const TELEMETRY_BINDING_ALLOWED = new Set(["lib/db-registry.ts", "lib/db-route.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = sourceFiles(SRC).map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));

describe("DB access ratchet", () => {
  it(`env.DB references in src/ do not rise above the baseline (${ENV_DB_BASELINE})`, () => {
    const perFile = files
      .map((f) => ({ rel: f.rel, n: (f.text.match(/\benv\.DB\b/g) ?? []).length }))
      .filter((f) => f.n > 0);
    const total = perFile.reduce((s, f) => s + f.n, 0);
    expect(total, `env.DB references rose to ${total} (baseline ${ENV_DB_BASELINE}). ` +
      "Read/write through a store accessor (lib/db-registry.ts store(), lib/db-route.ts telemetryStore()) instead of adding env.DB. " +
      "If the count went DOWN, lower ENV_DB_BASELINE in test/db-access-ratchet.test.ts.").toBeLessThanOrEqual(ENV_DB_BASELINE);
  });

  it("TELEMETRY_DB is only touched by lib/db-registry.ts and lib/db-route.ts", () => {
    const access = /\.TELEMETRY_DB\b|\[\s*["'`]TELEMETRY_DB["'`]\s*\]/;
    const offenders = files.filter((f) => !TELEMETRY_BINDING_ALLOWED.has(f.rel) && access.test(f.text)).map((f) => f.rel);
    expect(offenders, "use lib/db-route.ts telemetryStore(env), which honours the db_route:telemetry flag").toEqual([]);
  });

  it("the telemetry store is not fetched through the registry accessors outside db-route/db-registry/db-health/db-sizes/db-inventory", () => {
    // store(env, "telemetry") / storeBinding(env, "telemetry") bypass the
    // route flag the same way env.TELEMETRY_DB does. The health/size/inventory
    // tooling legitimately inspects the binding itself; nothing else may.
    const allowed = new Set([...TELEMETRY_BINDING_ALLOWED, "lib/db-health.ts", "lib/db-sizes.ts", "lib/db-inventory.ts"]);
    const viaAccessor = /\b(?:store|storeBinding|hasStore)\(\s*[A-Za-z_.]+\s*,\s*["'`]telemetry["'`]\s*\)/;
    const offenders = files.filter((f) => !allowed.has(f.rel) && viaAccessor.test(f.text)).map((f) => f.rel);
    expect(offenders, "use lib/db-route.ts telemetryStore(env), which honours the db_route:telemetry flag").toEqual([]);
  });
});
