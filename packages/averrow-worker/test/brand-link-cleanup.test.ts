import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/brand-count-reconciler", () => ({
  reconcileBrandThreatCounts: vi.fn(async () => ({ brandsChecked: 3, drifted: 2, fixed: 2 })),
}));
const auditMock = vi.fn(async () => {});
vi.mock("../src/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...(a as [])) }));

import {
  decideLink,
  runBrandLinkCleanup,
  clampLimit,
  clampCursor,
  APPLY_CONFIRM_TOKEN,
  UNDO_CONFIRM_TOKEN,
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

// Minimal D1 stub: serves the batch SELECT, the brand catalog, the log
// SELECT and the alerts COUNT; records every batch() write and reports
// `changes: 1` for each statement (or per `changesFor`).
function stubEnv(
  links: LinkRow[],
  brands: Array<{ id: string; name: string; canonical_domain: string }>,
  opts: { logRows?: unknown[]; changesFor?: (sql: string, binds: unknown[]) => number } = {},
) {
  const batches: Array<Array<{ sql: string; binds: unknown[] }>> = [];
  const stmt = (sql: string, binds: unknown[] = []) => ({
    sql, binds,
    bind: (...b: unknown[]) => stmt(sql, b),
    all: async () => ({
      results: sql.includes("FROM threats t") ? links
        : sql.includes("FROM brand_link_cleanup_log") ? (opts.logRows ?? [])
        : brands,
    }),
    first: async () => ({ n: 1 }),
    run: async () => ({ success: true }),
  });
  const env = {
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (s: Array<{ sql: string; binds: unknown[] }>) => {
        batches.push(s.map(({ sql, binds }) => ({ sql, binds })));
        return s.map(({ sql, binds }) => ({ meta: { changes: opts.changesFor ? opts.changesFor(sql, binds) : 1 } }));
      },
    },
  } as unknown as Env;
  return { env, batches };
}

const LINKS = (): LinkRow[] => [
  row({ malicious_domain: "paypal-secure.com", target_brand_id: "brand_paypal", brand_name: "PayPal", brand_canonical: "paypal.com" }),
  row({ ioc_value: '{"ip":"1.2.3.4","dataplane_feed":"sshpwauth"}', target_brand_id: "brand_word", brand_name: "Word", brand_canonical: "word.tips" }),
  row({ malicious_domain: "paypal-login.github.io", target_brand_id: "brand_github", brand_name: "Github", brand_canonical: "github.com", brand_match_method: "keyword" }),
];
const CATALOG = [
  { id: "brand_paypal", name: "PayPal", canonical_domain: "paypal.com" },
  { id: "brand_github", name: "Github", canonical_domain: "github.com" },
  { id: "brand_word", name: "Word", canonical_domain: "word.tips" },
];
const OPTS = { cursor: 0, limit: 10, runId: "run1", actor: "user:u1" };

function arity(writes: Array<{ sql: string; binds: unknown[] }>) {
  for (const w of writes) expect((w.sql.match(/\?/g) ?? []).length, w.sql).toBe(w.binds.length);
}

describe("runBrandLinkCleanup — dry_run", () => {
  it("reports decisions and writes nothing", async () => {
    auditMock.mockClear();
    const { env, batches } = stubEnv(LINKS(), CATALOG);
    const r = await runBrandLinkCleanup(env, { ...OPTS, mode: "dry_run" });
    expect(batches).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      run_id: "run1", scanned: 3, keep: 1, relink: 1, clear: 1, changed: 0, done: true,
      keep_by_method: { token: 1 },
      by_reason: { non_hostname: 1, no_rule_match: 1 },
      removed_by_brand: { brand_word: 1, brand_github: 1 },
      added_by_brand: { brand_paypal: 1 },
      alerts_affected: 1,
    });
    expect(r.reconciled).toBeUndefined();
  });

  it("advances the cursor and is not done on a full batch", async () => {
    const links = LINKS();
    const { env } = stubEnv(links, CATALOG);
    const r = await runBrandLinkCleanup(env, { ...OPTS, mode: "dry_run", limit: 3 });
    expect(r.done).toBe(false);
    expect(r.next_cursor).toBe(links[2]!.rid);
  });
});

describe("runBrandLinkCleanup — apply", () => {
  it("writes each guarded log+update pair in ONE batch, records old method/run/actor, audits, never reconciles", async () => {
    auditMock.mockClear();
    const links = LINKS();
    const { env, batches } = stubEnv(links, CATALOG);
    const r = await runBrandLinkCleanup(env, { ...OPTS, mode: "apply" });

    expect(batches).toHaveLength(2); // method stamps, then the change pairs
    expect(batches[0]!).toHaveLength(1);
    expect(batches[0]![0]!.binds).toEqual(["token", links[0]!.id]);

    const pairs = batches[1]!;
    expect(pairs).toHaveLength(4);
    const [log1, upd1, log2, upd2] = pairs;
    expect(log1!.sql).toMatch(/WHERE EXISTS \(SELECT 1 FROM threats WHERE id = \? AND target_brand_id = \?\)/);
    expect(log1!.sql).toMatch(/ON CONFLICT\(threat_id\) DO UPDATE[\s\S]*WHERE brand_link_cleanup_log\.undone_at IS NOT NULL/);
    expect(log1!.binds).toEqual([links[1]!.id, "brand_word", null, null, null, "clear", "non_hostname", "run1", "user:u1", links[1]!.id, "brand_word"]);
    expect(upd1!.binds).toEqual([null, null, links[1]!.id, "brand_word"]);
    expect(log2!.binds).toEqual([links[2]!.id, "brand_github", "keyword", "brand_paypal", "token", "relink", "no_rule_match", "run1", "user:u1", links[2]!.id, "brand_github"]);
    expect(upd2!.binds).toEqual(["brand_paypal", "token", links[2]!.id, "brand_github"]);
    arity(batches.flat());

    expect(r.changed).toBe(2);
    expect(r.reconciled).toBeUndefined();
    expect(auditMock).toHaveBeenCalledWith(env, expect.objectContaining({
      action: "brand_links.cleanup.apply", userId: "u1", resourceId: "run1",
    }));
  });

  it("counts only UPDATEs that actually changed a row", async () => {
    const { env } = stubEnv(LINKS(), CATALOG, {
      changesFor: (sql, binds) => (sql.startsWith("UPDATE threats SET target_brand_id") && binds[3] === "brand_word" ? 0 : 1),
    });
    const r = await runBrandLinkCleanup(env, { ...OPTS, mode: "apply" });
    expect(r.changed).toBe(1);
  });
});

describe("runBrandLinkCleanup — undo", () => {
  it("restores only where the threat still holds the cleanup's value, scoped to the run", async () => {
    auditMock.mockClear();
    const logRows = [
      { rid: 1, threat_id: "t1", old_brand_id: "brand_word", old_method: null, new_brand_id: null },
      { rid: 2, threat_id: "t2", old_brand_id: "brand_github", old_method: "keyword", new_brand_id: "brand_paypal" },
    ];
    const { env, batches } = stubEnv([], CATALOG, {
      logRows,
      changesFor: (sql, binds) => (sql.startsWith("UPDATE threats") && binds[2] === "t1" ? 0 : 1),
    });
    const r = await runBrandLinkCleanup(env, { ...OPTS, mode: "undo" });
    const writes = batches.flat();
    expect(writes).toHaveLength(4);
    expect(writes[0]!.sql).toMatch(/SET undone_at = datetime\('now'\)[\s\S]*target_brand_id IS \?/);
    expect(writes[1]!.binds).toEqual(["brand_word", null, "t1", null]);
    expect(writes[3]!.binds).toEqual(["brand_github", "keyword", "t2", "brand_paypal"]);
    arity(writes);
    expect(r).toMatchObject({ scanned: 2, changed: 1, skipped: 1, next_cursor: 2, done: true });
    expect(auditMock).toHaveBeenCalledWith(env, expect.objectContaining({ action: "brand_links.cleanup.undo" }));
  });
});

describe("runBrandLinkCleanup — reconcile", () => {
  it("only runs the counter reconciler", async () => {
    const { env, batches } = stubEnv(LINKS(), CATALOG);
    const r = await runBrandLinkCleanup(env, { ...OPTS, mode: "reconcile" });
    expect(batches).toHaveLength(0);
    expect(r.reconciled).toEqual({ brandsChecked: 3, drifted: 2, fixed: 2 });
    expect(r.scanned).toBe(0);
  });
});

describe("handleBrandLinkCleanup", () => {
  const { env } = stubEnv([], CATALOG);
  const call = (qs: string) => handleBrandLinkCleanup(new URL(`https://x/api?${qs}`), env, "internal");
  it("rejects apply/undo without their confirm token", async () => {
    expect((await call("mode=apply")).status).toBe(400);
    expect((await call(`mode=undo&confirm=${APPLY_CONFIRM_TOKEN}`)).status).toBe(400);
  });
  it("does not echo the confirm token in the error", async () => {
    const body = await (await call("mode=apply")).text();
    expect(body).not.toContain(APPLY_CONFIRM_TOKEN);
  });
  it("rejects unknown modes and bad run ids", async () => {
    expect((await call("mode=delete")).status).toBe(400);
    expect((await call("run_id=bad%20id")).status).toBe(400);
  });
  it("accepts apply/undo with the right token", async () => {
    expect((await call(`mode=apply&confirm=${APPLY_CONFIRM_TOKEN}`)).status).toBe(200);
    expect((await call(`mode=undo&confirm=${UNDO_CONFIRM_TOKEN}`)).status).toBe(200);
  });
  it("clamps limit and cursor", () => {
    expect(clampLimit(undefined)).toBe(500);
    expect(clampLimit(99999)).toBe(2000);
    expect(clampLimit(0)).toBe(1);
    expect(clampCursor(-5)).toBe(0);
    expect(clampCursor(NaN)).toBe(0);
    expect(clampCursor(1e30)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
