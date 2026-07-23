/**
 * Parse + row-building coverage for the feeds migrated to bulkInsertThreats
 * (openphish, urlhaus, threatfox, feodo, tweetfeed). Verifies each feed
 * still produces the correct ThreatRow shapes / counts after moving off the
 * per-row isDuplicate/insert/markSeen loop. (ipsum is covered in
 * expand-feeds-phase1.test.ts.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { openphish } from "../src/feeds/openphish";
import { urlhaus } from "../src/feeds/urlhaus";
import { threatfox } from "../src/feeds/threatfox";
import { feodo } from "../src/feeds/feodo";
import { tweetfeed } from "../src/feeds/tweetfeed";
import type { Env } from "../src/types";

// insertThreat / buildThreatInsertStmt bind offsets.
const COL_SOURCE_FEED = 1;
const COL_THREAT_TYPE = 2;
const COL_MAL_URL = 3;
const COL_MAL_DOMAIN = 4;
const COL_IP = 7;
const COL_STATUS = 11;
const COL_IOC_VALUE = 14;
const COL_SEVERITY = 15;

function makeEnv(): { env: Env; threatBinds: unknown[][] } {
  const threatBinds: unknown[][] = [];
  const stmt = (sql: string) => ({
    __sql: sql,
    bind(...args: unknown[]) {
      return {
        __sql: sql,
        __args: args,
        async run() { return { meta: { changes: 1 } }; }, // e.g. diagnosticFetch's agent_outputs insert
        async first() { return null; },
      };
    },
    async run() { return { meta: { changes: 1 } }; },
    async first() { return null; },
  });
  const env = {
    ABUSECH_AUTH_KEY: "test-key",
    DB: {
      prepare(sql: string) { return stmt(sql); },
      async batch(stmts: Array<{ __sql: string; __args: unknown[] }>) {
        return stmts.map((s) => {
          if (/INSERT\s+OR\s+IGNORE\s+INTO\s+threats/i.test(s.__sql)) threatBinds.push(s.__args);
          return { meta: { changes: 1 } };
        });
      },
    },
  } as unknown as Env;
  return { env, threatBinds };
}

function resp(body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const make = (): unknown => ({
    ok: true, status: 200, statusText: "OK",
    headers: { get: () => null },
    clone: () => make(),
    async text() { return text; },
    async json() { return typeof body === "string" ? JSON.parse(text) : body; },
  });
  return make() as Response;
}

function mockFetch(body: unknown) {
  globalThis.fetch = vi.fn(async () => resp(body)) as unknown as typeof fetch;
}

beforeEach(() => vi.restoreAllMocks());

describe("openphish (bulk)", () => {
  it("ingests deduped phishing URLs and skips non-http lines", async () => {
    mockFetch("http://a.com/x\nhttp://a.com/x\nhttps://b.com\nnot-a-url\n");
    const { env, threatBinds } = makeEnv();
    const r = await openphish.ingest({ env, feedName: "openphish", feedUrl: "https://x" });
    expect(r.itemsNew).toBe(2); // a.com deduped, b.com kept, junk skipped
    expect(threatBinds.map((b) => b[COL_MAL_URL])).toEqual(["http://a.com/x", "https://b.com"]);
    expect(threatBinds[0]![COL_THREAT_TYPE]).toBe("phishing");
    expect(threatBinds[0]![COL_SOURCE_FEED]).toBe("openphish");
  });
});

describe("urlhaus (bulk)", () => {
  it("parses the CSV, sets active/down severity+status, and detects IP hosts", async () => {
    const csv =
      "# header\n" +
      '"1","2026-01-01 00:00:00","http://evil.com/m","online","","malware_download","t","l","r"\n' +
      '"2","2026-01-02 00:00:00","http://1.2.3.4/x","offline","","malware","","",""';
    mockFetch(csv);
    const { env, threatBinds } = makeEnv();
    const r = await urlhaus.ingest({ env, feedName: "urlhaus", feedUrl: "https://x" });
    expect(r.itemsNew).toBe(2);
    const active = threatBinds.find((b) => b[COL_MAL_URL] === "http://evil.com/m")!;
    expect(active[COL_MAL_DOMAIN]).toBe("evil.com");
    expect(active[COL_SEVERITY]).toBe("high");
    expect(active[COL_STATUS]).toBe("active");
    const down = threatBinds.find((b) => b[COL_MAL_URL] === "http://1.2.3.4/x")!;
    expect(down[COL_IP]).toBe("1.2.3.4");
    expect(down[COL_SEVERITY]).toBe("medium");
    expect(down[COL_STATUS]).toBe("down");
  });
});

describe("threatfox (bulk)", () => {
  it("maps IOC types, strips IP ports, and skips hash IOCs", async () => {
    mockFetch({
      query_status: "ok",
      data: [
        { id: 1, ioc: "evil.com", ioc_type: "domain", threat_type: "payload_delivery", confidence_level: 95 },
        { id: 2, ioc: "1.2.3.4:443", ioc_type: "ip:port", threat_type: "botnet_cc", confidence_level: 75 },
        { id: 3, ioc: "abc123", ioc_type: "sha256_hash", threat_type: "payload_delivery", confidence_level: 90 },
      ],
    });
    const { env, threatBinds } = makeEnv();
    const r = await threatfox.ingest({ env, feedName: "threatfox", feedUrl: "https://x" });
    expect(r.itemsNew).toBe(2); // hash skipped
    expect(r.itemsFetched).toBe(2); // fetched == rows attempted (post hash-skip/dedup)
    const dom = threatBinds.find((b) => b[COL_MAL_DOMAIN] === "evil.com")!;
    expect(dom[COL_THREAT_TYPE]).toBe("malware_distribution");
    expect(dom[COL_SEVERITY]).toBe("critical"); // conf 95
    const ip = threatBinds.find((b) => b[COL_IP] === "1.2.3.4")!; // port stripped
    expect(ip[COL_THREAT_TYPE]).toBe("c2");
    expect(ip[COL_SEVERITY]).toBe("high"); // conf 75
  });
});

describe("feodo (bulk)", () => {
  it("ingests deduped botnet C2 IPs and carries the malware family", async () => {
    mockFetch([
      { ip_address: "9.9.9.9", malware: "Emotet" },
      { ip_address: "9.9.9.9", malware: "Emotet" }, // dup
      { ip_address: "not-an-ip" },
    ]);
    const { env, threatBinds } = makeEnv();
    const r = await feodo.ingest({ env, feedName: "feodo", feedUrl: "https://x" });
    expect(r.itemsNew).toBe(1);
    expect(r.itemsFetched).toBe(1); // fetched == unique valid IPs attempted
    expect(threatBinds[0]![COL_IP]).toBe("9.9.9.9");
    expect(threatBinds[0]![COL_IOC_VALUE]).toBe("9.9.9.9 (Emotet)");
    expect(threatBinds[0]![COL_THREAT_TYPE]).toBe("malware_distribution");
  });

  it("throws on a populated array with zero usable IPs (schema-change guard)", async () => {
    mockFetch([{ foo: "bar" }, { baz: "qux" }]);
    const { env } = makeEnv();
    await expect(feodo.ingest({ env, feedName: "feodo", feedUrl: "https://x" })).rejects.toThrow(/0 IPs/);
  });
});

describe("tweetfeed (bulk)", () => {
  it("maps each IOC type to its ThreatRow shape and skips unknown types", async () => {
    mockFetch([
      { type: "url", value: "http://p.com/x", tags: ["phishing"] },
      { type: "ip", value: "5.5.5.5", tags: ["c2"] },
      { type: "sha256", value: "ABCDEF", tags: ["stealer"] },
      { type: "weird", value: "z", tags: [] },
    ]);
    const { env, threatBinds } = makeEnv();
    const r = await tweetfeed.ingest({ env, feedName: "tweetfeed", feedUrl: "https://x" });
    expect(r.itemsNew).toBe(3); // weird type skipped
    const url = threatBinds.find((b) => b[COL_MAL_URL] === "http://p.com/x")!;
    expect(url[COL_THREAT_TYPE]).toBe("phishing");
    const ip = threatBinds.find((b) => b[COL_IP] === "5.5.5.5")!;
    expect(ip[COL_THREAT_TYPE]).toBe("malicious_ip");
    expect(ip[COL_SEVERITY]).toBe("critical"); // c2 tag
    // sha256 row: threat_type malware_distribution + JSON ioc_value payload preserved.
    const hashRow = threatBinds.find((b) => b[COL_THREAT_TYPE] === "malware_distribution")!;
    const payload = JSON.parse(String(hashRow[COL_IOC_VALUE]));
    expect(payload).toMatchObject({ value: "ABCDEF", type: "sha256" });
  });
});
