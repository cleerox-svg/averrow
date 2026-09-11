/**
 * Regression tests for the TAXII first-page timeout path.
 *
 * Production 2026-09-11: `taxii_otx` failed 4 of 19 pulls in 24h, every one
 * with the bare DOMException text "The operation was aborted due to
 * timeout". `feeds/taxii.ts` never passed `timeoutMs` to
 * `fetchTaxiiObjects`, so every page ran on the client's 30s default
 * (lib/taxii-client.ts:119) while the ingest budget was 9 minutes — and a
 * FIRST-page failure is rethrown (page N>0 breaks out with partial
 * success), so one slow page killed the whole pull.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

const fetchTaxiiObjects = vi.fn();
vi.mock("../src/lib/taxii-client", () => ({
  fetchTaxiiObjects: (...args: unknown[]) => fetchTaxiiObjects(...args),
}));

const { taxii, isTimeoutError } = await import("../src/feeds/taxii");

function emptyPage() {
  return {
    bundle: { type: "bundle", objects: [] },
    nextCursor: null,
    firstCursor: null,
    hasMore: false,
    status: 200,
  };
}

function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

function makeEnv(): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (/FROM feed_configs/i.test(sql)) {
                  return {
                    feed_name: "taxii_otx",
                    batch_size: 100,
                    taxii_root_url: "https://otx.alienvault.com/taxii/root/",
                    taxii_collection_id: "coll-1",
                    taxii_auth_type: "none",
                    taxii_username: null,
                    taxii_api_key_env: null,
                    taxii_next_added_after: null,
                  };
                }
                return null;
              },
              async run() { return { meta: { changes: 1 } }; },
              async all() { return { results: [] }; },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

const CTX = { feedName: "taxii_otx", feedUrl: "" };

beforeEach(() => { fetchTaxiiObjects.mockReset(); });

describe("isTimeoutError", () => {
  it("matches the AbortSignal.timeout shape", () => {
    expect(isTimeoutError(timeoutError())).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isTimeoutError(abort)).toBe(true);
  });

  it("does not match ordinary upstream errors", () => {
    expect(isTimeoutError(new Error("TAXII HTTP 503 from https://…"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError("timeout")).toBe(false); // not an Error object
  });
});

describe("taxii page fetch budget", () => {
  it("passes an explicit per-page timeout instead of the client's 30s default", async () => {
    fetchTaxiiObjects.mockResolvedValue(emptyPage());

    await taxii.ingest({ env: makeEnv(), ...CTX });

    expect(fetchTaxiiObjects).toHaveBeenCalledTimes(1);
    const opts = fetchTaxiiObjects.mock.calls[0]![0] as { timeoutMs: number };
    expect(opts.timeoutMs).toBe(120_000);
  });

  it("retries the FIRST page once on a timeout rather than failing the pull", async () => {
    let call = 0;
    fetchTaxiiObjects.mockImplementation(async () => {
      if (++call === 1) throw timeoutError();
      return emptyPage();
    });

    const r = await taxii.ingest({ env: makeEnv(), ...CTX });

    expect(fetchTaxiiObjects).toHaveBeenCalledTimes(2);
    expect(r.itemsError).toBe(0);
  });

  it("fails with a diagnosable message when the retry also times out", async () => {
    fetchTaxiiObjects.mockImplementation(async () => { throw timeoutError(); });

    await expect(taxii.ingest({ env: makeEnv(), ...CTX })).rejects.toThrow(
      /taxii_otx first page timed out after 120000ms \(retry also timed out\)/,
    );
    expect(fetchTaxiiObjects).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-timeout failure, and names the feed in the error", async () => {
    fetchTaxiiObjects.mockImplementation(async () => { throw new Error("TAXII HTTP 503 from https://otx"); });

    await expect(taxii.ingest({ env: makeEnv(), ...CTX })).rejects.toThrow(
      /taxii: taxii_otx first page failed — TAXII HTTP 503/,
    );
    expect(fetchTaxiiObjects).toHaveBeenCalledTimes(1);
  });
});
