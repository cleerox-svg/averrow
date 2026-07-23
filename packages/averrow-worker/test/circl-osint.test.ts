/**
 * Tests for the CIRCL OSINT MISP-feed ingest module (migration 0249).
 *
 * The upstream host is blocked by this session's egress proxy, so these
 * tests pin the module's contract against the documented MISP feed shape:
 * manifest cursor draining, to_ids filtering, network-IOC type mapping,
 * and cursor advancement.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { circl_osint } from "../src/feeds/circl_osint";
import type { Env } from "../src/types";

const NOW = Math.floor(Date.now() / 1000);

// insertThreat bind offsets (feedRunner.ts INSERT arg order).
const COL_SOURCE_FEED = 1;
const COL_THREAT_TYPE = 2;
const COL_MAL_URL = 3;
const COL_MAL_DOMAIN = 4;
const COL_IP = 7;
const COL_IOC_VALUE = 14;

interface Captured {
  threatBinds: unknown[][];
  cursorWrites: string[];
  fetchedUrls: string[];
}

function makeEnv(
  manifest: Record<string, { timestamp: string; info?: string }>,
  events: Record<string, unknown>,
  opts?: { cursor?: string },
): { env: Env; captured: Captured } {
  const captured: Captured = { threatBinds: [], cursorWrites: [], fetchedUrls: [] };
  let cursor = opts?.cursor ?? null;

  globalThis.fetch = vi.fn(async (url: string) => {
    captured.fetchedUrls.push(url);
    const make = (body: unknown) => ({
      ok: true,
      status: 200,
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    });
    if (url.endsWith("manifest.json")) return make(manifest) as unknown as Response;
    // event file: .../<uuid>.json
    const m = url.match(/\/([^/]+)\.json$/);
    const uuid = m?.[1];
    if (uuid && uuid in events) return make(events[uuid]) as unknown as Response;
    return { ok: false, status: 404, async json() { return {}; }, async text() { return ""; } } as unknown as Response;
  }) as unknown as typeof fetch;

  const env = {
    CACHE: {
      get: async (k: string) => (k === "circl_osint:cursor" ? cursor : null),
      put: async (k: string, v: string) => { if (k === "circl_osint:cursor") { cursor = v; captured.cursorWrites.push(v); } },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (/INSERT\s+OR\s+IGNORE\s+INTO\s+threats/i.test(sql)) captured.threatBinds.push(args);
                return { meta: { changes: 1 } };
              },
              async first() { return null; },
            };
          },
          async run() { return { meta: { changes: 1 } }; },
          async first() { return null; },
        };
      },
    },
  } as unknown as Env;

  return { env, captured };
}

const CTX = { feedName: "circl_osint", feedUrl: "https://circl.test/feed" };

beforeEach(() => vi.restoreAllMocks());

describe("circl_osint", () => {
  it("extracts to_ids network IOCs, maps types, and skips non-network / to_ids=false attrs", async () => {
    const manifest = {
      "uuid-a": { timestamp: String(NOW - 300) },
      "uuid-b": { timestamp: String(NOW - 200) },
    };
    const events = {
      "uuid-a": { Event: { Attribute: [
        { type: "domain", value: "Evil.COM", to_ids: true },      // -> domain evil.com
        { type: "ip-dst", value: "1.2.3.4", to_ids: true },       // -> ip
        { type: "md5", value: "deadbeef", to_ids: true },         // skipped (not network)
        { type: "domain", value: "safe.com", to_ids: false },     // skipped (to_ids false)
      ] } },
      "uuid-b": { Event: { Object: [ { Attribute: [
        { type: "url", value: "http://bad.test/x", to_ids: true },        // -> url
        { type: "ip-dst|port", value: "9.9.9.9|443", to_ids: true },      // -> ip 9.9.9.9 (port stripped)
      ] } ] } },
    };
    const { env, captured } = makeEnv(manifest, events);

    const result = await circl_osint.ingest({ env, ...CTX });

    expect(result.itemsNew).toBe(4);
    const feeds = captured.threatBinds.map((b) => b[COL_SOURCE_FEED]);
    expect(new Set(feeds)).toEqual(new Set(["circl_osint"]));

    // domain lowercased
    const domainRow = captured.threatBinds.find((b) => b[COL_MAL_DOMAIN] === "evil.com");
    expect(domainRow).toBeTruthy();
    expect(domainRow![COL_THREAT_TYPE]).toBe("malware_distribution");

    // ip rows, one port-stripped
    const ips = captured.threatBinds.filter((b) => b[COL_IP]).map((b) => b[COL_IP]);
    expect(ips).toContain("1.2.3.4");
    expect(ips).toContain("9.9.9.9");
    const ipRow = captured.threatBinds.find((b) => b[COL_IP] === "9.9.9.9");
    expect(ipRow![COL_THREAT_TYPE]).toBe("malicious_ip");

    // url row
    const urlRow = captured.threatBinds.find((b) => b[COL_MAL_URL] === "http://bad.test/x");
    expect(urlRow).toBeTruthy();
    expect(urlRow![COL_IOC_VALUE]).toBe("http://bad.test/x");
  });

  it("advances the KV cursor to the newest processed event timestamp", async () => {
    const manifest = { "uuid-a": { timestamp: String(NOW - 300) }, "uuid-b": { timestamp: String(NOW - 200) } };
    const events = {
      "uuid-a": { Event: { Attribute: [{ type: "domain", value: "a.com", to_ids: true }] } },
      "uuid-b": { Event: { Attribute: [{ type: "domain", value: "b.com", to_ids: true }] } },
    };
    const { env, captured } = makeEnv(manifest, events);

    await circl_osint.ingest({ env, ...CTX });

    expect(captured.cursorWrites.at(-1)).toBe(String(NOW - 200));
  });

  it("only processes events newer than the stored cursor", async () => {
    const manifest = { "uuid-a": { timestamp: String(NOW - 300) }, "uuid-b": { timestamp: String(NOW - 200) } };
    const events = {
      "uuid-a": { Event: { Attribute: [{ type: "domain", value: "a.com", to_ids: true }] } },
      "uuid-b": { Event: { Attribute: [{ type: "domain", value: "b.com", to_ids: true }] } },
    };
    // cursor sits between the two events → only uuid-b is newer.
    const { env, captured } = makeEnv(manifest, events, { cursor: String(NOW - 250) });

    const result = await circl_osint.ingest({ env, ...CTX });

    expect(result.itemsNew).toBe(1);
    expect(captured.threatBinds[0]![COL_MAL_DOMAIN]).toBe("b.com");
    // uuid-a's event file must never be fetched.
    expect(captured.fetchedUrls.some((u) => u.includes("uuid-a"))).toBe(false);
  });

  it("ignores events older than the 30-day backfill floor on a cold cursor", async () => {
    const manifest = {
      "recent": { timestamp: String(NOW - 100) },
      "ancient": { timestamp: String(NOW - 40 * 24 * 60 * 60) }, // 40 days old — below floor
    };
    const events = {
      "recent": { Event: { Attribute: [{ type: "domain", value: "recent.com", to_ids: true }] } },
      "ancient": { Event: { Attribute: [{ type: "domain", value: "ancient.com", to_ids: true }] } },
    };
    const { env, captured } = makeEnv(manifest, events); // no cursor → cold

    const result = await circl_osint.ingest({ env, ...CTX });

    expect(result.itemsNew).toBe(1);
    expect(captured.threatBinds[0]![COL_MAL_DOMAIN]).toBe("recent.com");
    expect(captured.fetchedUrls.some((u) => u.includes("ancient"))).toBe(false);
  });

  it("accepts to_ids in boolean / 1 / \"1\" forms and rejects falsey forms", async () => {
    const manifest = { e: { timestamp: String(NOW - 100) } };
    const events = { e: { Event: { Attribute: [
      { type: "domain", value: "a.com", to_ids: true },
      { type: "domain", value: "b.com", to_ids: 1 },
      { type: "domain", value: "c.com", to_ids: "1" },
      { type: "domain", value: "no1.com", to_ids: false },
      { type: "domain", value: "no2.com", to_ids: 0 },
      { type: "domain", value: "no3.com", to_ids: "0" },
      { type: "domain", value: "no4.com" }, // to_ids undefined
    ] } } };
    const { env, captured } = makeEnv(manifest, events);

    const result = await circl_osint.ingest({ env, ...CTX });

    expect(result.itemsNew).toBe(3);
    expect(captured.threatBinds.map((b) => b[COL_MAL_DOMAIN]).sort()).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("maps hostname, domain|ip and hostname|port to the host part (before the pipe)", async () => {
    const manifest = { e: { timestamp: String(NOW - 100) } };
    const events = { e: { Event: { Attribute: [
      { type: "hostname", value: "Host.Example", to_ids: true },
      { type: "domain|ip", value: "packed.com|5.6.7.8", to_ids: true },
      { type: "hostname|port", value: "h2.example|8080", to_ids: true },
    ] } } };
    const { env, captured } = makeEnv(manifest, events);

    const result = await circl_osint.ingest({ env, ...CTX });

    expect(result.itemsNew).toBe(3);
    expect(new Set(captured.threatBinds.map((b) => b[COL_MAL_DOMAIN]))).toEqual(
      new Set(["host.example", "packed.com", "h2.example"]),
    );
  });

  it("does NOT advance the cursor past an older event that failed to fetch", async () => {
    // uuid-a (older) is absent from events → mock 404s it, closing the
    // frontier; uuid-b (newer) still ingests, but the cursor must not jump
    // past uuid-a, so it gets retried on the next pull.
    const manifest = { "uuid-a": { timestamp: String(NOW - 300) }, "uuid-b": { timestamp: String(NOW - 200) } };
    const events = { "uuid-b": { Event: { Attribute: [{ type: "domain", value: "b.com", to_ids: true }] } } };
    const { env, captured } = makeEnv(manifest, events);

    const result = await circl_osint.ingest({ env, ...CTX });

    expect(result.itemsNew).toBe(1);
    expect(captured.threatBinds[0]![COL_MAL_DOMAIN]).toBe("b.com");
    expect(captured.cursorWrites).toEqual([]); // frontier closed at the failed event
  });

  it("does not write the cursor on a caught-up pull (boundary event re-scanned via >=)", async () => {
    const manifest = { e: { timestamp: String(NOW - 100) } };
    const events = { e: { Event: { Attribute: [{ type: "domain", value: "a.com", to_ids: true }] } } };
    const { env, captured } = makeEnv(manifest, events, { cursor: String(NOW - 100) });

    await circl_osint.ingest({ env, ...CTX });

    expect(captured.cursorWrites).toEqual([]);
  });

  it("drains at most MAX_EVENTS (20) per pull and continues on the next pull", async () => {
    const manifest: Record<string, { timestamp: string }> = {};
    const events: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      const id = `ev-${String(i).padStart(2, "0")}`;
      manifest[id] = { timestamp: String(NOW - 2500 + i) }; // strictly increasing
      events[id] = { Event: { Attribute: [{ type: "domain", value: `d${i}.com`, to_ids: true }] } };
    }
    const { env, captured } = makeEnv(manifest, events); // shared cursor across both pulls

    const r1 = await circl_osint.ingest({ env, ...CTX });
    expect(r1.itemsNew).toBe(20);
    expect(captured.cursorWrites.at(-1)).toBe(String(NOW - 2500 + 19)); // 20th event

    await circl_osint.ingest({ env, ...CTX });
    // Every one of the 25 distinct domains is captured across the two pulls.
    const domains = new Set(captured.threatBinds.map((b) => b[COL_MAL_DOMAIN]));
    for (let i = 0; i < 25; i++) expect(domains.has(`d${i}.com`)).toBe(true);
  });

  it("throws a clean error when the manifest is unreachable (feeds the circuit breaker)", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, async json() { return {}; }, async text() { return ""; } })) as unknown as typeof fetch;
    const env = { CACHE: { get: async () => null, put: async () => {} }, DB: {} } as unknown as Env;

    await expect(circl_osint.ingest({ env, ...CTX })).rejects.toThrow(/manifest HTTP 403/);
  });
});
