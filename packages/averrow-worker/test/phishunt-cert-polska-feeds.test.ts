/**
 * phishunt.io (feeds/phishunt.ts, migration 0330) and the CERT Polska
 * Warning List (feeds/certPolska.ts, migration 0331).
 *
 * Fixtures mirror the live record shapes verified 2026-11-15 (field names,
 * types, newest-first ordering); domains are placeholders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  phishunt, parsePhishuntRecord, PHISHUNT_MAX_ROWS, PHISHUNT_MAX_BODY_BYTES,
} from "../src/feeds/phishunt";
import {
  cert_polska, JsonArrayObjectScanner, CERT_POLSKA_WATERMARK_KEY,
  CERT_POLSKA_MAX_INSERTS_PER_RUN, CERT_POLSKA_MAX_SCAN_RECORDS, normalizeCertPolskaDomain,
  parseUtcDate, formatWatermark, parseWatermark,
} from "../src/feeds/certPolska";
import { feedModules } from "../src/feeds";
import type { Env } from "../src/types";

// Bound-arg offsets into the threats INSERT (buildThreatInsertStmt, feedRunner.ts).
const COL_ID = 0;
const COL_SOURCE = 1;
const COL_TYPE = 2;
const COL_URL = 3;
const COL_DOMAIN = 4;
const COL_IP = 7;
const COL_ASN = 8;
const COL_CONFIDENCE = 12;
const COL_SEVERITY = 15;

interface Harness {
  env: Env;
  kv: Map<string, string>;
  inserted: unknown[][];
  existing: Set<string>;
  /** Fail the Nth threats batch (1-based); 0 = never. */
  failBatch: { n: number };
  /** Make CACHE.put throw. */
  failPut: { on: boolean };
}

function makeEnv(): Harness {
  const kv = new Map<string, string>();
  const inserted: unknown[][] = [];
  const existing = new Set<string>();
  const failBatch = { n: 0 };
  const failPut = { on: false };
  let threatBatches = 0;
  const stmt = (sql: string, args: unknown[] = []) => ({
    __sql: sql, __args: args,
    bind: (...a: unknown[]) => stmt(sql, a),
    async run() { return { meta: { changes: 0 } }; },
    async all() { return { results: [] }; },
    async first() { return null; },
  });
  const env = {
    CACHE: {
      async get(k: string) { return kv.get(k) ?? null; },
      async put(k: string, v: string) { if (failPut.on) throw new Error("KV down"); kv.set(k, v); },
    },
    DB: {
      prepare: (sql: string) => stmt(sql),
      async batch(stmts: Array<{ __sql: string; __args: unknown[] }>) {
        const isThreats = stmts.some((s) => /INSERT\s+OR\s+IGNORE\s+INTO\s+threats/i.test(s.__sql));
        if (isThreats) {
          threatBatches++;
          if (failBatch.n === threatBatches) throw new Error("D1 overloaded");
        }
        return stmts.map((s) => {
          if (!/INSERT\s+OR\s+IGNORE\s+INTO\s+threats/i.test(s.__sql)) return { meta: { changes: 0 } };
          const id = s.__args[COL_ID] as string;
          if (existing.has(id)) return { meta: { changes: 0 } };
          existing.add(id);
          inserted.push(s.__args);
          return { meta: { changes: 1 } };
        });
      },
    },
  } as unknown as Env;
  return { env, kv, inserted, existing, failBatch, failPut };
}

/** The id part of the stored CERT Polska watermark (`<id>:<ms>`). */
function wmId(h: Harness): string | undefined {
  return h.kv.get(CERT_POLSKA_WATERMARK_KEY)?.split(":")[0];
}

/** A Response emitting the UTF-8 BYTES of `body` in `byteChunk`-byte pieces. */
function byteStreamResponse(body: string, byteChunk: number): Response {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + byteChunk));
      offset += byteChunk;
    },
  });
  return new Response(stream);
}

/** A Response whose body is emitted in `chunkSize`-char pieces; counts pulls. */
function streamResponse(body: string, chunkSize = 64, status = 200): { res: Response; pulls: () => number } {
  let offset = 0;
  let pulls = 0;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (offset >= body.length) { controller.close(); return; }
      controller.enqueue(enc.encode(body.slice(offset, offset + chunkSize)));
      offset += chunkSize;
    },
  });
  return { res: new Response(stream, { status }), pulls: () => pulls };
}

function mockFetch(make: () => Response) {
  globalThis.fetch = vi.fn(async () => make()) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── phishunt ───────────────────────────────────────────────────

function phRecord(i: number, verdict = "high", extra: Record<string, unknown> = {}) {
  return {
    url: `https://shop-example${i}.test/p/index.html`,
    domain: `shop-example${i}.test`,
    company: "examplebank",
    date: "2026-11-14T23:30:07.993499+00:00",
    first_seen: "2026-11-14T13:01:15.282767+00:00",
    uuid: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    ip: "64.29.17.195",
    country: "United States",
    asn: "16509",
    org: "Example Hosting",
    cert: "WR1",
    malicious_google: false, malicious_openphish: true, malicious_phishtank: false,
    malicious_tweetfeed: false, malicious_urlscan: false,
    top_signals: [{ signal: "brand_in_title", label: "Brand in title", points: 4.5 }],
    score: 33,
    verdict,
    url_only: false,
    ...extra,
  };
}

const PH_CTX = (env: Env) => ({ env, feedName: "phishunt", feedUrl: "https://phishunt.io/feed.json" });

describe("phishunt", () => {
  it("is registered under its feed_configs name", () => {
    expect(feedModules.phishunt).toBeDefined();
    expect(feedModules.cert_polska).toBeDefined();
  });

  it("maps verdict bands, keeps IPv4 + AS-prefixed ASN, skips noise, dedups within the payload", async () => {
    const body = JSON.stringify([
      phRecord(1, "critical"),
      phRecord(2, "high"),
      phRecord(3, "medium", { ip: "not-an-ip", asn: "garbage" }),
      phRecord(4, "low"),
      phRecord(5, "noise"),
      phRecord(1, "critical"), // duplicate URL
      { domain: "no-url.test" }, // no url → skipped
      phRecord(6, "high", { url: "ftp://x.test/a" }), // not http(s)
    ]);
    mockFetch(() => new Response(body));
    const h = makeEnv();
    const r = await phishunt.ingest(PH_CTX(h.env));

    expect(r).toEqual({ itemsFetched: 4, itemsNew: 4, itemsDuplicate: 0, itemsError: 0 });
    const byUrl = new Map(h.inserted.map((a) => [a[COL_URL], a]));
    const crit = byUrl.get("https://shop-example1.test/p/index.html")!;
    expect(crit[COL_SOURCE]).toBe("phishunt");
    expect(crit[COL_TYPE]).toBe("phishing");
    expect(crit[COL_DOMAIN]).toBe("shop-example1.test");
    expect(crit[COL_IP]).toBe("64.29.17.195");
    expect(crit[COL_ASN]).toBe("AS16509");
    expect(crit[COL_SEVERITY]).toBe("high");
    expect(crit[COL_CONFIDENCE]).toBe(85);
    expect(String(crit[COL_ID])).toMatch(/^thr-phishunt-[0-9a-f]{16}$/);
    const med = byUrl.get("https://shop-example3.test/p/index.html")!;
    expect(med[COL_IP]).toBeNull();
    expect(med[COL_ASN]).toBeNull();
    expect(med[COL_SEVERITY]).toBe("medium");
    expect(byUrl.get("https://shop-example4.test/p/index.html")![COL_SEVERITY]).toBe("low");
    expect(byUrl.has("https://shop-example5.test/p/index.html")).toBe(false);
  });

  it("a repeated window is all duplicates (itemsNew counts only inserted rows)", async () => {
    const body = JSON.stringify([phRecord(1), phRecord(2)]);
    mockFetch(() => new Response(body));
    const h = makeEnv();
    await phishunt.ingest(PH_CTX(h.env));
    const again = await phishunt.ingest(PH_CTX(h.env));
    expect(again).toEqual({ itemsFetched: 2, itemsNew: 0, itemsDuplicate: 2, itemsError: 0 });
  });

  it(`caps rows per pull at ${PHISHUNT_MAX_ROWS}`, async () => {
    const recs = Array.from({ length: PHISHUNT_MAX_ROWS + 300 }, (_, i) => phRecord(i));
    mockFetch(() => new Response(JSON.stringify(recs)));
    const h = makeEnv();
    const r = await phishunt.ingest(PH_CTX(h.env));
    expect(r.itemsFetched).toBe(PHISHUNT_MAX_ROWS);
    expect(h.inserted).toHaveLength(PHISHUNT_MAX_ROWS);
  });

  it.each([
    ["HTTP error", () => new Response("down", { status: 503 }), /HTTP 503/],
    ["non-JSON", () => new Response("<html>oops</html>"), /not JSON/],
    ["non-array", () => new Response(JSON.stringify({ error: "x" })), /JSON array/],
    ["empty array", () => new Response("[]"), /empty/],
    ["no record has a url", () => new Response(JSON.stringify([{ domain: "a.test" }, { foo: 1 }])), /no usable records/],
  ])("%s → the pull fails (throws), nothing inserted", async (_label, make, msg) => {
    mockFetch(make as () => Response);
    const h = makeEnv();
    await expect(phishunt.ingest(PH_CTX(h.env))).rejects.toThrow(msg);
    expect(h.inserted).toHaveLength(0);
  });

  it("a body over the byte cap fails the pull", async () => {
    const big = "[" + " ".repeat(PHISHUNT_MAX_BODY_BYTES) + "]";
    mockFetch(() => streamResponse(big, 1024 * 1024).res);
    const h = makeEnv();
    await expect(phishunt.ingest(PH_CTX(h.env))).rejects.toThrow(/larger than/);
  });

  it("an all-noise window is a successful empty pull", async () => {
    mockFetch(() => new Response(JSON.stringify([phRecord(1, "noise")])));
    const h = makeEnv();
    const r = await phishunt.ingest(PH_CTX(h.env));
    expect(r.itemsNew).toBe(0);
  });

  it("parsePhishuntRecord classifies invalid / noise / unknown verdicts", () => {
    expect(parsePhishuntRecord(null)).toEqual({ kind: "invalid" });
    expect(parsePhishuntRecord("https://x.test")).toEqual({ kind: "invalid" });
    expect(parsePhishuntRecord([phRecord(1)])).toEqual({ kind: "invalid" });
    expect(parsePhishuntRecord(phRecord(1, "noise"))).toEqual({ kind: "noise" });
    expect(parsePhishuntRecord(phRecord(1, "suspicious"))).toEqual({ kind: "unknown_verdict", verdict: "suspicious" });
    expect(parsePhishuntRecord(phRecord(1, "", { verdict: undefined }))).toEqual({ kind: "unknown_verdict", verdict: null });
    expect(parsePhishuntRecord(phRecord(1, "HIGH")).kind).toBe("row");
  });

  it("zero rows with any unknown verdict fails the pull (renamed bands are not 'noise')", async () => {
    mockFetch(() => new Response(JSON.stringify([phRecord(1, "noise"), phRecord(2, "likely_phish")])));
    const h = makeEnv();
    await expect(phishunt.ingest(PH_CTX(h.env))).rejects.toThrow(/unknown verdict.*likely_phish/);
    expect(h.inserted).toHaveLength(0);
  });

  it("unknown verdicts on more than half the records fail the pull even with some rows", async () => {
    mockFetch(() => new Response(JSON.stringify([
      phRecord(1, "high"), phRecord(2, "sev_3"), phRecord(3, "sev_4"),
    ])));
    const h = makeEnv();
    await expect(phishunt.ingest(PH_CTX(h.env))).rejects.toThrow(/2\/3 records carry an unknown verdict/);
  });

  it("a minority of unknown verdicts is skipped with a pull warning", async () => {
    mockFetch(() => new Response(JSON.stringify([
      phRecord(1, "high"), phRecord(2, "medium"), phRecord(3, "weird"),
    ])));
    const h = makeEnv();
    const r = await phishunt.ingest(PH_CTX(h.env));
    expect(r.itemsNew).toBe(2);
    expect(r.warning).toMatch(/1 record\(s\) with an unknown verdict/);
  });
});

// ─── CERT Polska ────────────────────────────────────────────────

const NOW = Date.parse("2026-11-15T12:00:00Z");
const HOUR = 3_600_000;

interface CpRec { id: number; domain: string; ageH: number; deleted?: boolean }

/** Pretty-printed like the live file (4-space indent, newest first). */
function cpBody(recs: CpRec[]): string {
  const sorted = [...recs].sort((a, b) => b.id - a.id);
  return JSON.stringify(sorted.map((r) => ({
    RegisterPositionId: r.id,
    DomainAddress: r.domain,
    InsertDate: new Date(NOW - r.ageH * HOUR).toISOString().replace(".000Z", "+00:00"),
    DeleteDate: r.deleted ? new Date(NOW).toISOString() : null,
  })), null, 4);
}

/** n records with ids base+1..base+n, the highest id newest. */
function cpRange(base: number, n: number, ageStepH = 0.01): CpRec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: base + i + 1, domain: `oferta-${base + i + 1}.pl-paczka.sbs`, ageH: (n - i) * ageStepH,
  }));
}

const CP_CTX = (env: Env) => ({ env, feedName: "cert_polska", feedUrl: "https://hole.cert.pl/domains/v2/domains.json" });

describe("JsonArrayObjectScanner", () => {
  it("yields objects split across arbitrary chunk boundaries, incl. braces/quotes inside strings", () => {
    const text = JSON.stringify([{ a: "x{y}z\"]", n: { m: [1, 2] } }, { a: "b" }], null, 2);
    for (const size of [1, 3, 7, 1000]) {
      const s = new JsonArrayObjectScanner();
      const out: unknown[] = [];
      for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
      expect(out).toEqual([{ a: "x{y}z\"]", n: { m: [1, 2] } }, { a: "b" }]);
      expect(s.isEnded).toBe(true);
    }
  });

  it.each([
    ["not an array", "{\"a\":1}"],
    ["string element", "[\"a.pl\"]"],
    ["malformed object", "[{\"a\":}]"],
  ])("throws on %s", (_l, text) => {
    expect(() => new JsonArrayObjectScanner().push(text)).toThrow();
  });
});

describe("cert_polska", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("baseline (no watermark): ingests only the last 24h, sets the watermark to the top id", async () => {
    const recs: CpRec[] = [
      { id: 101, domain: "old-1.pl-oferta.shop", ageH: 72 },
      { id: 102, domain: "old-2.pl-oferta.shop", ageH: 30 },
      { id: 103, domain: "new-1.pl-oferta.shop", ageH: 20 },
      { id: 104, domain: "new-2.pl-oferta.shop", ageH: 1, deleted: true },
      { id: 105, domain: "new-3.pl-oferta.shop", ageH: 0.5 },
    ];
    mockFetch(() => new Response(cpBody(recs)));
    const h = makeEnv();
    const r = await cert_polska.ingest(CP_CTX(h.env));

    expect(r).toMatchObject({ itemsFetched: 2, itemsNew: 2, itemsError: 0 });
    expect(h.inserted.map((a) => a[COL_DOMAIN]).sort()).toEqual(["new-1.pl-oferta.shop", "new-3.pl-oferta.shop"]);
    const row = h.inserted[0]!;
    expect(row[COL_SOURCE]).toBe("cert_polska");
    expect(row[COL_TYPE]).toBe("phishing");
    expect(row[COL_URL]).toBeNull();
    expect(row[COL_SEVERITY]).toBe("high");
    expect(row[COL_CONFIDENCE]).toBe(80);
    expect(String(row[COL_ID])).toMatch(/^thr-cert_polska-[0-9a-f]{16}$/);
    expect(wmId(h)).toBe("105");
  });

  it("baseline with no additions in the window ingests nothing but records the watermark", async () => {
    mockFetch(() => new Response(cpBody([{ id: 50, domain: "stale.pl-oferta.shop", ageH: 48 }])));
    const h = makeEnv();
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(0);
    expect(wmId(h)).toBe("50");
  });

  it("steady state: ingests only ids above the watermark and stops reading the stream there", async () => {
    const recs = cpRange(1000, 3000); // ids 1001..4000
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "3990");
    let pulls = () => 0;
    mockFetch(() => { const s = streamResponse(cpBody(recs), 512); pulls = s.pulls; return s.res; });

    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(10);
    expect(h.inserted.map((a) => a[COL_DOMAIN])).toEqual(
      Array.from({ length: 10 }, (_, i) => `oferta-${3991 + i}.pl-paczka.sbs`), // oldest-first
    );
    expect(wmId(h)).toBe("4000");
    // ~140 bytes/record: 11 records ≈ 1.6 KB ≈ 4 chunks of a ~420 KB body.
    expect(pulls()).toBeLessThan(10);
  });

  it("nothing new → no writes, watermark unchanged", async () => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "4000");
    mockFetch(() => new Response(cpBody(cpRange(1000, 3000))));
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r).toEqual({ itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(wmId(h)).toBe("4000");
  });

  it(`caps inserts at ${CERT_POLSKA_MAX_INSERTS_PER_RUN}/run oldest-first; the next run continues`, async () => {
    const recs = cpRange(0, 1200); // ids 1..1200
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "100"); // 1100 new
    mockFetch(() => new Response(cpBody(recs)));

    const r1 = await cert_polska.ingest(CP_CTX(h.env));
    expect(r1.itemsNew).toBe(CERT_POLSKA_MAX_INSERTS_PER_RUN);
    expect(wmId(h)).toBe(String(100 + CERT_POLSKA_MAX_INSERTS_PER_RUN));

    const r2 = await cert_polska.ingest(CP_CTX(h.env));
    expect(r2.itemsNew).toBe(CERT_POLSKA_MAX_INSERTS_PER_RUN);
    const r3 = await cert_polska.ingest(CP_CTX(h.env));
    expect(r3.itemsNew).toBe(100);
    expect(wmId(h)).toBe("1200");
    expect(new Set(h.inserted.map((a) => a[COL_ID])).size).toBe(1100);
  });

  it("a failed insert chunk stops the run; the watermark stays at the last settled chunk", async () => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "1000");
    h.failBatch.n = 2; // second chunk of 50 fails
    mockFetch(() => new Response(cpBody(cpRange(1000, 120))));

    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(50);
    expect(r.itemsError).toBe(50);
    expect(r.warning).toMatch(/failed to insert/);
    expect(wmId(h)).toBe("1050");

    h.failBatch.n = 0;
    const r2 = await cert_polska.ingest(CP_CTX(h.env));
    expect(r2.itemsNew).toBe(70);
    expect(wmId(h)).toBe("1120");
  });

  it("deleted and invalid domains are settled without inserting", async () => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "10");
    mockFetch(() => new Response(cpBody([
      { id: 11, domain: "gone.pl-oferta.shop", ageH: 1, deleted: true },
      { id: 12, domain: "not a domain", ageH: 1 },
      { id: 13, domain: "OK-Domain.pl-oferta.shop.", ageH: 1 },
    ])));
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(1);
    expect(h.inserted[0]![COL_DOMAIN]).toBe("ok-domain.pl-oferta.shop");
    expect(wmId(h)).toBe("13");
  });

  it("backlog beyond the scan cap: newest slice ingested, gap skipped, warning", async () => {
    const recs = cpRange(0, CERT_POLSKA_MAX_SCAN_RECORDS + 200);
    const top = CERT_POLSKA_MAX_SCAN_RECORDS + 200;
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "1");
    mockFetch(() => new Response(cpBody(recs)));
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(CERT_POLSKA_MAX_INSERTS_PER_RUN);
    expect(r.warning).toMatch(/backlog/);
    expect(h.inserted.map((a) => a[COL_DOMAIN])).toContain(`oferta-${top}.pl-paczka.sbs`);
    expect(wmId(h)).toBe(String(top));
  });

  it("upstream renumbered (top id below watermark): re-baseline, ingest nothing", async () => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "999999");
    mockFetch(() => new Response(cpBody(cpRange(0, 20))));
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(0);
    expect(r.warning).toMatch(/renumbered/);
    expect(wmId(h)).toBe("20");
  });

  it.each([
    ["HTTP error", () => new Response("x", { status: 502 }), /HTTP 502/],
    ["empty array", () => new Response("[]"), /empty/],
    ["empty body", () => new Response(""), /empty body/],
    ["HTML", () => new Response("<html></html>"), /not a JSON array/],
    ["truncated", () => new Response("[{\"RegisterPositionId\": 5, \"Dom"), /truncated/],
    ["only malformed records", () => new Response(JSON.stringify([{ foo: 1 }, { bar: 2 }])), /no valid records/],
  ])("%s → the pull fails and the watermark is untouched", async (_l, make, msg) => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "42");
    mockFetch(make as () => Response);
    await expect(cert_polska.ingest(CP_CTX(h.env))).rejects.toThrow(msg);
    expect(wmId(h)).toBe("42");
    expect(h.inserted).toHaveLength(0);
  });

  it("normalizeCertPolskaDomain", () => {
    expect(normalizeCertPolskaDomain("allegro.pl-oferta.shop")).toBe("allegro.pl-oferta.shop");
    expect(normalizeCertPolskaDomain("x.y")).toBeNull();
    expect(normalizeCertPolskaDomain("nodot")).toBeNull();
    expect(normalizeCertPolskaDomain("bad_char.pl")).toBeNull();
    // IDN → punycode A-label.
    expect(normalizeCertPolskaDomain("allegrołokalnie.pl")).toBe("xn--allegrookalnie-mnc.pl");
    // A Unicode name carrying URL syntax must not yield a different host.
    expect(normalizeCertPolskaDomain("ą.pl/@evil.example")).toBeNull();
    expect(normalizeCertPolskaDomain("ą.pl:80")).toBeNull();
  });

  it("a failed insert with nothing settled fails the pull and leaves the watermark", async () => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "1000");
    h.failBatch.n = 1; // the first (and only) chunk fails
    mockFetch(() => new Response(cpBody(cpRange(1000, 20))));
    await expect(cert_polska.ingest(CP_CTX(h.env))).rejects.toThrow(/nothing settled/);
    expect(h.kv.get(CERT_POLSKA_WATERMARK_KEY)).toBe("1000");
  });

  it("re-baseline survives a KV write failure (warning, not a throw)", async () => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "999999");
    h.failPut.on = true;
    mockFetch(() => new Response(cpBody(cpRange(0, 5))));
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(0);
    expect(r.warning).toMatch(/renumbered.*watermark write failed/);
    expect(h.kv.get(CERT_POLSKA_WATERMARK_KEY)).toBe("999999");
  });

  it("Unicode domains: converted to punycode; ones that fail validation are counted in the warning", async () => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "10");
    mockFetch(() => new Response(cpBody([
      { id: 11, domain: "allegrołokalnie.pl-oferta.shop", ageH: 1 },
      { id: 12, domain: "ą.pl/@evil.example", ageH: 1 },
    ])));
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(1);
    expect(h.inserted[0]![COL_DOMAIN]).toBe("xn--allegrookalnie-mnc.pl-oferta.shop");
    expect(r.warning).toMatch(/1 Unicode domain\(s\) failed validation/);
    expect(wmId(h)).toBe("12");
  });

  it("streams a multi-byte UTF-8 character split across byte chunks", async () => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, "10");
    const body = cpBody([
      { id: 10, domain: "older.pl-oferta.shop", ageH: 5 },
      { id: 11, domain: "żółć-paczka.pl-oferta.shop", ageH: 1 },
    ]);
    // 1-byte chunks split every 2-byte character (ż, ó, ł, ć) across reads.
    mockFetch(() => byteStreamResponse(body, 1));
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(1);
    expect(h.inserted[0]![COL_DOMAIN]).toBe(normalizeCertPolskaDomain("żółć-paczka.pl-oferta.shop"));
    expect(String(h.inserted[0]![COL_DOMAIN])).toMatch(/^xn--/);
    expect(r.warning).toBeUndefined();
  });

  it("parseUtcDate reads a timestamp with no offset as UTC", () => {
    expect(parseUtcDate("2026-11-15T00:06:09")).toBe(Date.parse("2026-11-15T00:06:09Z"));
    expect(parseUtcDate("2026-11-15 00:06:09")).toBe(Date.parse("2026-11-15T00:06:09Z"));
    expect(parseUtcDate("2026-11-15T00:06:09+02:00")).toBe(Date.parse("2026-11-14T22:06:09Z"));
    expect(parseUtcDate("2026-11-15T00:06:09Z")).toBe(Date.parse("2026-11-15T00:06:09Z"));
  });

  it("watermark is stored as <id>:<run ms>; a bare id still parses", async () => {
    mockFetch(() => new Response(cpBody([{ id: 7, domain: "a.pl-oferta.shop", ageH: 1 }])));
    const h = makeEnv();
    await cert_polska.ingest(CP_CTX(h.env));
    expect(h.kv.get(CERT_POLSKA_WATERMARK_KEY)).toBe(formatWatermark(7, NOW));
    expect(parseWatermark("42")).toEqual({ id: 42, writtenAtMs: null });
    expect(parseWatermark("junk")).toBeNull();
  });

  it("warns when the record at the watermark was inserted after the run that set it (back-dated id)", async () => {
    const h = makeEnv();
    // Watermark 20 written 3h ago; record 20's InsertDate is 1h ago.
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, formatWatermark(20, NOW - 3 * HOUR));
    mockFetch(() => new Response(cpBody([
      { id: 21, domain: "new.pl-oferta.shop", ageH: 0.5 },
      { id: 20, domain: "late.pl-oferta.shop", ageH: 1 },
    ])));
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.itemsNew).toBe(1);
    expect(r.warning).toMatch(/record 20 .* inserted after the last run/);
  });

  it("no back-date warning when the record at the watermark predates the last run", async () => {
    const h = makeEnv();
    h.kv.set(CERT_POLSKA_WATERMARK_KEY, formatWatermark(20, NOW - HOUR));
    mockFetch(() => new Response(cpBody([
      { id: 21, domain: "new.pl-oferta.shop", ageH: 0.5 },
      { id: 20, domain: "old.pl-oferta.shop", ageH: 2 },
    ])));
    const r = await cert_polska.ingest(CP_CTX(h.env));
    expect(r.warning).toBeUndefined();
  });
});
