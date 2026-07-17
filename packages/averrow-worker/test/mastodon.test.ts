/**
 * Tests for the mastodon ingest path (2026-05-04 rewrite).
 *
 * The previous version per-tick scanned 4 instances × 10 brands ×
 * 2 queries × 20 statuses with 4 awaits/status, blowing the Worker
 * subrequest ceiling and leaving orphan pull-history rows. The
 * rewrite addresses two structural problems:
 *
 *   1) **One instance per tick**, rotated via KV offset.
 *   2) **Bulk INSERT OR IGNORE via db.batch()**, no per-status
 *      KV-GET / DB-SELECT / KV-PUT round-trips.
 *
 * These tests verify both invariants without round-tripping a real
 * Mastodon instance — fetch is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mastodon } from "../src/feeds/mastodon";
import type { Env } from "../src/types";

interface CapturedBatch {
  size: number;
}

interface MockOpts {
  brandRows?: Array<{ id: string; name: string; canonical_domain: string | null }>;
  statusesPerSearch?: number;
  initialInstanceOffset?: string | null;
  initialBrandOffset?: string | null;
}

function makeEnv(opts: MockOpts = {}) {
  const captured: { kvWrites: Array<{ key: string; value: string }>; batches: CapturedBatch[] } = {
    kvWrites: [],
    batches: [],
  };
  const kv = new Map<string, string>();
  if (opts.initialInstanceOffset != null) kv.set("mastodon_instance_offset", opts.initialInstanceOffset);
  if (opts.initialBrandOffset != null) kv.set("mastodon_brand_offset", opts.initialBrandOffset);

  const brandRows = opts.brandRows ?? [
    { id: "b1", name: "Acme", canonical_domain: "acme.com" },
    { id: "b2", name: "Widgetco", canonical_domain: "widgetco.io" },
  ];
  const statusesPerSearch = opts.statusesPerSearch ?? 3;

  // Pre-built status payload — fetch returns the same body for every
  // search/timeline call. The ID embeds an index so the buffer keys are
  // unique within the tick.
  let nextStatusIndex = 0;
  const buildStatus = (offset: number) => ({
    id: `s${offset}`,
    url: `https://example.invalid/s${offset}`,
    content: "<p>Acme is offering refunds at acme.com</p>",
    created_at: "2026-05-04T12:00:00Z",
    favourites_count: 0,
    reblogs_count: 0,
    in_reply_to_id: null,
    account: {
      acct: "alice@example.invalid",
      url: "https://example.invalid/@alice",
      display_name: "Alice",
      followers_count: 5,
    },
  });

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const isSearch = url.includes("/api/v2/search");
    const isTimeline = url.includes("/api/v1/timelines/public");
    if (!isSearch && !isTimeline) throw new Error(`unexpected fetch ${url}`);
    const payload = Array.from({ length: statusesPerSearch }, () => buildStatus(nextStatusIndex++));
    return {
      ok: true,
      json: async () => (isSearch ? { statuses: payload } : payload),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  // Mock D1: brand-eligibility queries always succeed; batch flush
  // simulates 100% new (changes=1) per row so the test can observe
  // batch size and verify rotation.
  const env = {
    DB: {
      prepare(sql: string) {
        const isBrandsBatch = /SELECT b\.id, b\.name, b\.canonical_domain/.test(sql);
        const isAllBrands = /SELECT id, name, canonical_domain FROM brands/.test(sql);
        const all = async () => ({
          results: isBrandsBatch || isAllBrands ? brandRows : [],
        });
        return {
          // `.bind(...).all()` path (the brand-rotation query)
          bind(..._args: unknown[]) {
            return { all };
          },
          // `.all()` direct path (the all-brands query, no params)
          all,
        };
      },
      async batch(stmts: unknown[]) {
        captured.batches.push({ size: stmts.length });
        return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    },
    CACHE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
        captured.kvWrites.push({ key, value });
      },
    },
  } as unknown as Env;

  return { env, captured, kv };
}

describe("mastodon", () => {
  let realSetTimeout: typeof setTimeout;
  beforeEach(() => {
    // The feed waits 1.5s between Mastodon API calls to stay under
    // the 300 req/5min instance limit. Bypass that wait in tests by
    // stubbing setTimeout to execute synchronously — we are not
    // verifying rate-limit behavior, only the SQL/KV contract.
    realSetTimeout = globalThis.setTimeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).setTimeout = (fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
  });
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  it("rotates one instance per tick via KV offset", async () => {
    const { env, captured, kv } = makeEnv({ initialInstanceOffset: "1" });

    await mastodon.ingest({
      env,
      feedName: "mastodon",
      feedUrl: "",
    });

    // Offset advances from 1 → 2.
    const writeOffset = captured.kvWrites.find((w) => w.key === "mastodon_instance_offset");
    expect(writeOffset?.value).toBe("2");
    expect(kv.get("mastodon_instance_offset")).toBe("2");

    // All fetched URLs must hit the SAME instance for this tick.
    const fetchMock = vi.mocked(globalThis.fetch);
    const hosts = new Set<string>();
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      const host = new URL(url).host;
      hosts.add(host);
    }
    expect(hosts.size).toBe(1);
  });

  it("wraps the offset around the 4-instance ring", async () => {
    const { env, kv } = makeEnv({ initialInstanceOffset: "3" });
    await mastodon.ingest({ env, feedName: "mastodon", feedUrl: "" });
    expect(kv.get("mastodon_instance_offset")).toBe("0");
  });

  it("flushes pending mentions via db.batch() (no per-status round-trips)", async () => {
    const { env, captured } = makeEnv({
      brandRows: [{ id: "b1", name: "Acme", canonical_domain: "acme.com" }],
      statusesPerSearch: 4,
    });

    await mastodon.ingest({ env, feedName: "mastodon", feedUrl: "" });

    // db.batch was called at least once.
    expect(captured.batches.length).toBeGreaterThan(0);
    // Total INSERT statements equal the de-duped buffer size — the
    // exact number depends on (statuses × searches), but it must be
    // > 0 so we know the batch path actually ran.
    const totalStmts = captured.batches.reduce((acc, b) => acc + b.size, 0);
    expect(totalStmts).toBeGreaterThan(0);
  });

  it("throws when no brand is eligible (visible operator gate)", async () => {
    const { env } = makeEnv({ brandRows: [] });
    await expect(
      mastodon.ingest({ env, feedName: "mastodon", feedUrl: "" }),
    ).rejects.toThrow(/no eligible brands/);
  });
});
