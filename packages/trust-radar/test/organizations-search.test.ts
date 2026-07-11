/**
 * Tests for handlers/organizations.ts — handleSearchBrands
 * (GET /api/admin/brands/search, the legacy org-assignment picker).
 *
 * Locks the fix that dropped the `LEFT JOIN threats t ... GROUP BY b.id`
 * red flag (CLAUDE.md §8 "Pre-computed columns") in favor of reading the
 * pre-computed `brands.threat_count` column directly. Faked the same way
 * search.test.ts fakes D1: a hand-rolled `.prepare(sql).bind(...).all()`
 * object routed through a fake `env.DB.withSession()`, since the handler
 * now reads via getReadSession().
 */

import { describe, it, expect } from "vitest";
import { handleSearchBrands } from "../src/handlers/organizations";
import type { Env } from "../src/types";

interface Captured {
  sql: string;
  binds: unknown[];
}

function makeEnv(rows: Array<Record<string, unknown>> = [], calls: Captured[] = []): Env {
  const session = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all() {
              calls.push({ sql, binds });
              return { results: rows };
            },
          };
        },
      };
    },
  };
  return {
    DB: {
      withSession: () => session,
    },
  } as unknown as Env;
}

function req(qs: string): Request {
  return new Request(`https://averrow.com/api/admin/brands/search${qs}`);
}

async function bodyOf(res: Response) {
  return res.json() as Promise<{ success: boolean; data?: unknown; error?: string }>;
}

describe("handleSearchBrands — reads brands.threat_count, never joins threats", () => {
  it("selects the pre-computed brands.threat_count column and issues no JOIN / threats-table reference", async () => {
    const calls: Captured[] = [];
    const env = makeEnv(
      [{ id: "b1", name: "Acme", canonical_domain: "acme.com", threat_count: 5 }],
      calls,
    );
    const res = await handleSearchBrands(req("?q=ac"), env);

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const { sql } = calls[0];
    expect(sql).toMatch(/b\.threat_count/);
    expect(sql).not.toMatch(/JOIN/i);
    expect(sql).not.toMatch(/\bthreats\b/i);
    expect(sql).not.toMatch(/COUNT\(/i);
    expect(sql).not.toMatch(/GROUP BY/i);
  });

  it("returns the pre-computed threat_count straight through in the response", async () => {
    const env = makeEnv([
      { id: "b1", name: "Acme", canonical_domain: "acme.com", threat_count: 5 },
    ]);
    const res = await handleSearchBrands(req("?q=ac"), env);
    const body = (await bodyOf(res)) as { data: Array<Record<string, unknown>> };
    expect(body.data).toEqual([
      { id: "b1", name: "Acme", canonical_domain: "acme.com", threat_count: 5 },
    ]);
  });

  it("binds the name/domain prefix wildcard twice plus the limit, matching placeholder count", async () => {
    const calls: Captured[] = [];
    const env = makeEnv([], calls);
    await handleSearchBrands(req("?q=ac&limit=10"), env);

    expect(calls.length).toBe(1);
    const { sql, binds } = calls[0];
    const placeholderCount = (sql.match(/\?/g) ?? []).length;
    expect(binds.length).toBe(placeholderCount);
    expect(binds).toEqual(["%ac%", "%ac%", 10]);
  });

  it("clamps limit to the 50-row cap", async () => {
    const calls: Captured[] = [];
    const env = makeEnv([], calls);
    await handleSearchBrands(req("?q=ac&limit=999"), env);
    expect(calls[0].binds.at(-1)).toBe(50);
  });

  it("short-circuits to an empty result without touching the DB when q is empty", async () => {
    const calls: Captured[] = [];
    const env = makeEnv([], calls);
    const res = await handleSearchBrands(req(""), env);

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ success: true, data: [] });
    expect(calls.length).toBe(0);
  });
});
