/**
 * Regression tests for the WhoisDS NRD source integration.
 *
 * Production incident 2026-09-11: `nrd_hagezi` failed 11/11 pulls in 24h,
 * every one with "NRD WhoisDS: empty response body (0 bytes)", and the
 * circuit breaker auto-paused the feed. Root cause was the download URL
 * shape — WhoisDS keys the free download on base64("YYYY-MM-DD.zip") plus
 * a trailing "/nrd" segment, not the plain date filename. The plain form
 * answers HTTP 200 with a zero-byte body, so `res.ok` was true, the
 * day-before fallback never fired, and the pull died every time.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { nrd_hagezi, nrdDownloadUrl } from "../src/feeds/nrd_hagezi";
import type { Env } from "../src/types";

function utcDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Env stub: no monitored brands, so processArchive exits after parsing. */
function makeEnv(): Env {
  return {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async run() { return { meta: { changes: 0 } }; },
              async all() { return { results: [] }; },
              async first() { return null; },
            };
          },
          async run() { return { meta: { changes: 0 } }; },
          async all() { return { results: [] }; },
        };
      },
    },
  } as unknown as Env;
}

/** A response carrying `bytes` as its body. */
function res(bytes: Uint8Array, ok = true, status = 200): Response {
  return {
    ok,
    status,
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  } as unknown as Response;
}

/** Plain-text (uncompressed, non-container) domain list — the feed accepts it. */
function textBody(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

afterEach(() => vi.unstubAllGlobals());

describe("nrdDownloadUrl", () => {
  it("base64-encodes '<date>.zip' and appends the /nrd segment", () => {
    // echo -n "2026-09-10.zip" | base64 → MjAyNi0wOS0xMC56aXA=
    expect(nrdDownloadUrl("2026-09-10")).toBe(
      "https://whoisds.com/whois-database/newly-registered-domains/MjAyNi0wOS0xMC56aXA/nrd",
    );
  });

  it("strips base64 '=' padding (the form WhoisDS's own download links use)", () => {
    expect(nrdDownloadUrl("2026-09-10")).not.toContain("=");
    expect(nrdDownloadUrl("2026-01-01")).not.toContain("=");
  });

  it("never emits the bare '<date>.zip' path that returned 0 bytes in production", () => {
    expect(nrdDownloadUrl("2026-09-10")).not.toContain("2026-09-10.zip");
  });
});

describe("nrd_hagezi ingest", () => {
  it("requests yesterday's archive at the base64 /nrd URL", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return res(textBody("example-one.com\nexample-two.com\n"));
    }));

    const r = await nrd_hagezi.ingest({ env: makeEnv(), feedName: "nrd_hagezi", feedUrl: "" });

    expect(urls).toEqual([nrdDownloadUrl(utcDaysAgo(1))]);
    expect(r.itemsFetched).toBe(2);
  });

  it("falls back to the day before when yesterday returns a zero-byte 200", async () => {
    // The exact production shape: HTTP 200, empty body. The old code only
    // fell back on !res.ok, so this died instead of retrying.
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length === 1
        ? res(new Uint8Array(0))
        : res(textBody("late-publish.com\n"));
    }));

    const r = await nrd_hagezi.ingest({ env: makeEnv(), feedName: "nrd_hagezi", feedUrl: "" });

    expect(urls).toEqual([nrdDownloadUrl(utcDaysAgo(1)), nrdDownloadUrl(utcDaysAgo(2))]);
    expect(r.itemsFetched).toBe(1);
  });

  it("falls back on a non-2xx yesterday (rollover before WhoisDS publishes)", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length === 1 ? res(new Uint8Array(0), false, 404) : res(textBody("a.com\n"));
    }));

    const r = await nrd_hagezi.ingest({ env: makeEnv(), feedName: "nrd_hagezi", feedUrl: "" });
    expect(urls).toHaveLength(2);
    expect(r.itemsFetched).toBe(1);
  });

  it("reports two zero-byte days in the wording that parks the feed as upstream-dead", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(new Uint8Array(0))));

    // autoPauseFeed (lib/feedRunner.ts) matches this phrase to choose
    // paused_reason='auto:upstream_dead', which the 4-hour auto-recovery
    // sweep does NOT revive — no more pause → recover → fail ping-pong.
    await expect(
      nrd_hagezi.ingest({ env: makeEnv(), feedName: "nrd_hagezi", feedUrl: "" }),
    ).rejects.toThrow(/served no data on 2 consecutive days/);

    // Both dates must appear so the breaker's stamped error is diagnosable.
    await expect(
      nrd_hagezi.ingest({ env: makeEnv(), feedName: "nrd_hagezi", feedUrl: "" }),
    ).rejects.toThrow(new RegExp(`${utcDaysAgo(1)}.*${utcDaysAgo(2)}`));
  });

  it("keeps a mixed/transient failure OUT of the upstream-dead wording", async () => {
    // One empty day + one HTTP 503 is an outage shape, not a dead source:
    // it must stay `auto:consecutive_failures` so the 4h sweep can revive it.
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? res(new Uint8Array(0)) : res(new Uint8Array(0), false, 503))));

    await expect(
      nrd_hagezi.ingest({ env: makeEnv(), feedName: "nrd_hagezi", feedUrl: "" }),
    ).rejects.toThrow(/no usable archive/);
    await expect(
      nrd_hagezi.ingest({ env: makeEnv(), feedName: "nrd_hagezi", feedUrl: "" }),
    ).rejects.not.toThrow(/served no data on/);
  });

  it("surfaces a fetch throw as a failure rather than hanging the pull", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(
      nrd_hagezi.ingest({ env: makeEnv(), feedName: "nrd_hagezi", feedUrl: "" }),
    ).rejects.toThrow(/network down/);
  });
});
