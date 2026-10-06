/**
 * G25 — look-alikes feed the Brand Exposure Score.
 *
 * `lookalike_domains.status` is never 'active' (monitoring |
 * confirmed_threat | benign | taken_down), so the old filter made the
 * exposure score's domain_risk input permanently 0. These tests run the
 * real SQL against a schema + index set derived from `migrations/`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import {
  EXPOSURE_LOOKALIKE_COUNT_SQL,
  countExposureLookalikes,
} from "../src/lib/lookalike-exposure";
import { computeBrandExposureScore } from "../src/lib/brand-scoring";
import type { Env } from "../src/types";

const SCORING_TABLES = [
  "brands",
  "threats",
  "social_profiles",
  "lookalike_domains",
  "app_store_listings",
  "dark_web_mentions",
];

function openDb(tables: string[] = ["lookalike_domains"]): SqliteDb {
  const raw = openDerivedDb(tables);
  for (const ddl of liveIndexDdl("lookalike_domains").values()) raw.exec(ddl);
  return raw;
}

let seq = 0;
function lookalike(raw: SqliteDb, brandId: string, registered: number, status: string): void {
  seq += 1;
  raw.prepare(
    "INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type, registered, status) VALUES (?, ?, ?, 'typosquat', ?, ?)",
  ).run(`l${seq}`, brandId, `look${seq}.example`, registered, status);
}

describe.skipIf(!hasSqlite())("G25 exposure look-alike count", () => {
  it("is a covering seek on idx_lookalike_brand_exposure, not a walk of every registered row", () => {
    const raw = openDb();
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${EXPOSURE_LOOKALIKE_COUNT_SQL}`).all() as Array<{ detail: string }>)
      .map((r) => r.detail).join("\n");
    expect(plan).toContain("COVERING INDEX idx_lookalike_brand_exposure");
    expect(plan).not.toContain("idx_lookalike_registered");
    expect(plan).not.toMatch(/\bSCAN\b/);
  });

  it("counts only registered monitoring / confirmed_threat rows for the brand", async () => {
    const raw = openDb();
    // Counted.
    lookalike(raw, "b1", 1, "monitoring");
    lookalike(raw, "b1", 1, "monitoring");
    lookalike(raw, "b1", 1, "confirmed_threat");
    // Not counted: unregistered permutations, benign, taken down, other brand.
    lookalike(raw, "b1", 0, "monitoring");
    lookalike(raw, "b1", 0, "confirmed_threat");
    lookalike(raw, "b1", 1, "benign");
    lookalike(raw, "b1", 1, "taken_down");
    lookalike(raw, "b2", 1, "monitoring");

    const db = d1FromSqlite(raw);
    expect(await countExposureLookalikes(db, "b1")).toBe(3);
    expect(await countExposureLookalikes(db, "b2")).toBe(1);
    expect(await countExposureLookalikes(db, "nope")).toBe(0);
  });

  it("feeds computeBrandExposureScore's domain_risk (was always 0)", async () => {
    const raw = openDb(SCORING_TABLES);
    raw.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Acme', 'acme.example')").run();
    for (let i = 0; i < 4; i++) lookalike(raw, "b1", 1, "monitoring");
    lookalike(raw, "b1", 1, "benign");
    lookalike(raw, "b1", 0, "monitoring");

    const env = { DB: d1FromSqlite(raw) } as unknown as Env;
    const result = await computeBrandExposureScore(env, "b1");
    expect(result.domain_risk_score).toBe(20); // 4 live × 5
    expect(result.brand_exposure_score).toBeGreaterThan(0);

    const stored = raw.prepare("SELECT domain_risk_score FROM brands WHERE id = 'b1'").all() as Array<{ domain_risk_score: number }>;
    expect(stored[0]!.domain_risk_score).toBe(20);
  });
});

describe("G25 regression guard", () => {
  it("no source file filters lookalike_domains on the non-existent status 'active'", () => {
    const srcDir = resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith(".ts")) continue;
        const text = readFileSync(p, "utf8");
        if (/FROM\s+lookalike_domains\b(?:(?!\bFROM\b)[^;`"()])*\bstatus\s*=\s*'active'/i.test(text)) offenders.push(p);
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
