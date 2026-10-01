import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/brand-count-reconciler", () => ({
  reconcileBrandThreatCounts: vi.fn(async () => ({ brandsChecked: 3, drifted: 2, fixed: 2 })),
}));

import {
  decideLink,
  runBrandLinkCleanup,
  clampLimit,
  APPLY_CONFIRM_TOKEN,
  type LinkRow,
} from "../src/lib/brand-link-cleanup";
import { handleBrandLinkCleanup } from "../src/handlers/admin/brand-link-cleanup";
import type { Env } from "../src/types";

let rid = 0;
function row(over: Partial<LinkRow>): LinkRow {
  rid++;
  return {
    rid, id: `t${rid}`, malicious_domain: null, malicious_url: null, ioc_value: null,
    target_brand_id: "brand_x", brand_match_method: null, brand_name: "X", brand_canonical: "x.com",
    ...over,
  };
}

const never = () => { throw new Error("rematch must not be called"); };

describe("decideLink", () => {
  it("keeps a link the new rules still accept, with its method", () => {
    const d = decideLink(row({
      malicious_domain: "paypal-secure.com", target_brand_id: "brand_paypal",
      brand_name: "PayPal", brand_canonical: "paypal.com",
    }), never);
    expect(d).toEqual({ action: "keep", method: "token", newBrandId: null, reason: null });
  });

  it("clears JSON IOC blobs without scanning the catalog", () => {
    const d = decideLink(row({
      ioc_value: '{"ip":"45.178.74.75","category":"telnet_brute","dataplane_feed":"telnetlogin"}',
      target_brand_id: "brand_login_gov", brand_name: "Login", brand_canonical: "login.gov",
    }), never);
    expect(d).toEqual({ action: "clear", method: null, newBrandId: null, reason: "non_hostname" });
  });

  it("clears IP-only links as non_hostname", () => {
    const d = decideLink(row({
      malicious_domain: "115.50.231.176", malicious_url: "http://115.50.231.176:49841/bin.sh",
      brand_name: "1x1x5", brand_canonical: "1x1x5.com",
    }), never);
    expect(d.reason).toBe("non_hostname");
  });

  it("clears generic-word brand links when nothing else matches", () => {
    const d = decideLink(row({
      malicious_domain: "drasw.club", brand_name: "Club", brand_canonical: "club.fr",
    }), () => null);
    expect(d).toEqual({ action: "clear", method: null, newBrandId: null, reason: "generic_brand" });
  });

  it("clears a fuzzy false positive as no_rule_match", () => {
    const d = decideLink(row({
      malicious_domain: "byveo.org", brand_name: "Coveo", brand_canonical: "coveo.com",
    }), () => null);
    expect(d.reason).toBe("no_rule_match");
  });

  it("relinks to the brand the new matcher picks", () => {
    const d = decideLink(row({
      malicious_domain: "paypal-login.github.io", target_brand_id: "brand_github",
      brand_name: "Github", brand_canonical: "github.com",
    }), () => ({ brandId: "brand_paypal", method: "token" }));
    expect(d).toEqual({ action: "relink", method: "token", newBrandId: "brand_paypal", reason: "no_rule_match" });
  });

  it("treats a dangling brand id as missing_brand", () => {
    const d = decideLink(row({ malicious_domain: "example.com", brand_name: null, brand_canonical: null }), () => null);
    expect(d.reason).toBe("missing_brand");
  });

  it("never 'relinks' to the same brand", () => {
    const d = decideLink(row({ malicious_domain: "byveo.org", brand_name: "Coveo", target_brand_id: "brand_x" }),
      () => ({ brandId: "brand_x", method: "levenshtein" }));
    expect(d.action).toBe("clear");
  });
});

// Minimal D1 stub: serves the batch SELECT, the brand catalog and the
// alerts COUNT; records every batch() write.
function stubEnv(links: LinkRow[], brands: Array<{ id: string; name: string; canonical_domain: string }>) {
  const batches: Array<Array<{ sql: string; binds: unknown[] }>> = [];
  const stmt = (sql: string, binds: unknown[] = []) => ({
    sql, binds,
    bind: (...b: unknown[]) => stmt(sql, b),
    all: async () => ({ results: sql.includes("FROM threats t") ? links : brands }),
    first: async () => ({ n: 1 }),
    run: async () => ({ success: true }),
  });
  const env = {
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (s: Array<{ sql: string; binds: unknown[] }>) => {
        batches.push(s.map(({ sql, binds }) => ({ sql, binds })));
        return [];
      },
    },
  } as unknown as Env;
  return { env, batches };
}

const LINKS = (): LinkRow[] => [
  row({ malicious_domain: "paypal-secure.com", target_brand_id: "brand_paypal", brand_name: "PayPal", brand_canonical: "paypal.com" }),
  row({ ioc_value: '{"ip":"1.2.3.4","dataplane_feed":"sshpwauth"}', target_brand_id: "brand_word", brand_name: "Word", brand_canonical: "word.tips" }),
  row({ malicious_domain: "paypal-login.github.io", target_brand_id: "brand_github", brand_name: "Github", brand_canonical: "github.com" }),
];
const CATALOG = [
  { id: "brand_paypal", name: "PayPal", canonical_domain: "paypal.com" },
  { id: "brand_github", name: "Github", canonical_domain: "github.com" },
  { id: "brand_word", name: "Word", canonical_domain: "word.tips" },
];

describe("runBrandLinkCleanup", () => {
  it("dry_run reports decisions and writes nothing", async () => {
    const { env, batches } = stubEnv(LINKS(), CATALOG);
    const r = await runBrandLinkCleanup(env, { mode: "dry_run", cursor: 0, limit: 10 });
    expect(batches).toHaveLength(0);
    expect(r).toMatchObject({
      scanned: 3, keep: 1, relink: 1, clear: 1, written: 0, done: true,
      keep_by_method: { token: 1 },
      by_reason: { non_hostname: 1, no_rule_match: 1 },
      removed_by_brand: { brand_word: 1, brand_github: 1 },
      added_by_brand: { brand_paypal: 1 },
      alerts_affected: 1,
    });
    expect(r.reconciled).toBeUndefined();
  });

  it("apply logs before changing each link, guards on the old brand, and reconciles when done", async () => {
    const links = LINKS();
    const { env, batches } = stubEnv(links, CATALOG);
    const r = await runBrandLinkCleanup(env, { mode: "apply", cursor: 0, limit: 10 });
    const writes = batches.flat();
    expect(r.written).toBe(writes.length);
    expect(writes).toHaveLength(5); // 1 method stamp + 2 × (log + update)

    expect(writes[0]!.sql).toMatch(/SET brand_match_method = \? WHERE id = \? AND brand_match_method IS NULL/);
    expect(writes[0]!.binds).toEqual(["token", links[0]!.id]);

    expect(writes[1]!.sql).toMatch(/INSERT OR IGNORE INTO brand_link_cleanup_log/);
    expect(writes[1]!.binds).toEqual([links[1]!.id, "brand_word", null, "clear", "non_hostname", null]);
    expect(writes[2]!.binds).toEqual([null, null, links[1]!.id, "brand_word"]);

    expect(writes[3]!.binds).toEqual([links[2]!.id, "brand_github", "brand_paypal", "relink", "no_rule_match", "token"]);
    expect(writes[4]!.binds).toEqual(["brand_paypal", "token", links[2]!.id, "brand_github"]);

    for (const w of writes) {
      expect((w.sql.match(/\?/g) ?? []).length, w.sql).toBe(w.binds.length);
    }
    expect(r.reconciled).toEqual({ brandsChecked: 3, drifted: 2, fixed: 2 });
  });

  it("advances the cursor and is not done on a full batch", async () => {
    const links = LINKS();
    const { env } = stubEnv(links, CATALOG);
    const r = await runBrandLinkCleanup(env, { mode: "dry_run", cursor: 0, limit: 3 });
    expect(r.done).toBe(false);
    expect(r.next_cursor).toBe(links[2]!.rid);
  });
});

describe("handleBrandLinkCleanup", () => {
  const { env } = stubEnv([], CATALOG);
  it("rejects apply without the confirm token", async () => {
    const res = await handleBrandLinkCleanup(new URL("https://x/api?mode=apply"), env);
    expect(res.status).toBe(400);
  });
  it("rejects an unknown mode", async () => {
    const res = await handleBrandLinkCleanup(new URL("https://x/api?mode=delete"), env);
    expect(res.status).toBe(400);
  });
  it("accepts apply with the token", async () => {
    const res = await handleBrandLinkCleanup(new URL(`https://x/api?mode=apply&confirm=${APPLY_CONFIRM_TOKEN}`), env);
    expect(res.status).toBe(200);
  });
  it("clamps limit", () => {
    expect(clampLimit(undefined)).toBe(500);
    expect(clampLimit(99999)).toBe(2000);
    expect(clampLimit(0)).toBe(1);
  });
});
