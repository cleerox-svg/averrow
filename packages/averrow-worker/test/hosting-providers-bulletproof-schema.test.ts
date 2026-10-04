// hosting_providers.is_bulletproof — schema consistency between prod and a
// migration-built DB.
//
// Prod gained the column OUT-OF-BAND (INTEGER, nullable, DEFAULT 0); no
// migration defined it, so staging/dev/the derived-schema harness lacked it
// and GET /api/providers/v2 (which selects hp.is_bulletproof) 500'd there.
// migrations/0078 now adds it as a fresh-bootstrap fix (0053 precedent) —
// prod-invisible because 0078 is long-applied there and never re-runs.
//
// Guards:
//   1. The migration-derived schema carries the column, with prod's shape.
//   2. It is added exactly once, in 0078. A second ADD COLUMN in a NEW
//      migration would fail prod with "duplicate column name".
//   3. Every hp.* column the providers v2 SELECT names exists in the derived
//      schema, so the next out-of-band drift fails here, not in staging.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { deriveSchema, splitStatements } from "./migration-schema";
import { hasSqlite, openDerivedDb } from "./sqlite-d1-harness";

const ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = resolve(ROOT, "migrations");

describe("hosting_providers.is_bulletproof (migration-derived schema)", () => {
  it("derived schema includes is_bulletproof, contributed by 0078", () => {
    const schema = deriveSchema(["hosting_providers"]);
    expect(schema.columns.hosting_providers).toContain("is_bulletproof");
    expect(schema.sources.hosting_providers).toContain("0078_cartographer_score_recency.sql");
  });

  it("is added by exactly one migration statement, in 0078", () => {
    const adders: string[] = [];
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      for (const stmt of splitStatements(sql)) {
        if (/^ALTER\s+TABLE\s+hosting_providers\s+ADD\s+COLUMN\s+is_bulletproof\b/i.test(stmt)) {
          adders.push(file);
        }
      }
    }
    expect(adders).toEqual(["0078_cartographer_score_recency.sql"]);
  });

  it.skipIf(!hasSqlite())("materialises with prod's shape: INTEGER, nullable, DEFAULT 0", () => {
    const db = openDerivedDb(["hosting_providers"]);
    const cols = db.prepare("PRAGMA table_info(hosting_providers)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const col = cols.find((c) => c.name === "is_bulletproof");
    expect(col).toBeDefined();
    expect(col!.type).toBe("INTEGER");
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBe("0");

    db.exec("INSERT INTO hosting_providers (id, name) VALUES ('hp_1', 'Example')");
    const row = db.prepare("SELECT is_bulletproof FROM hosting_providers WHERE id = 'hp_1'").all() as Array<{
      is_bulletproof: number | null;
    }>;
    expect(row[0]!.is_bulletproof).toBe(0);
  });

  it("every hp.* column selected by /api/providers/v2 exists in the derived schema", () => {
    const src = readFileSync(resolve(ROOT, "src/handlers/providers.ts"), "utf8");
    const start = src.indexOf("SELECT hp.id, hp.name, hp.asn, hp.country,");
    expect(start).toBeGreaterThan(-1);
    const select = src.slice(start, src.indexOf("FROM hosting_providers hp", start));
    const named = [...select.matchAll(/\bhp\.([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]!.toLowerCase());
    expect(named).toContain("is_bulletproof");
    const columns = deriveSchema(["hosting_providers"]).columns.hosting_providers!;
    expect(named.filter((c) => !columns.includes(c))).toEqual([]);
  });
});
