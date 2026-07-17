/**
 * Tests for getCubeSourceWatermark — the probe Navigator uses to
 * skip prev-hour cube rebuilds when source data hasn't changed.
 *
 * Watermark format: `${max_created_at}|${count}`. Both fields are
 * required because COUNT alone misses the case where an
 * insert + delete in the same window leaves the count unchanged.
 */

import { describe, it, expect } from "vitest";
import { getCubeSourceWatermark } from "../src/lib/cube-builder";

function makeEnv(opts: { maxTs: string | null; count: number }) {
  let probeCount = 0;
  const env = {
    DB: {
      prepare(_sql: string) {
        return {
          bind: (..._args: unknown[]) => ({
            first: async () => {
              probeCount++;
              return { max_ts: opts.maxTs, n: opts.count };
            },
          }),
        };
      },
    },
  } as unknown as Parameters<typeof getCubeSourceWatermark>[0];
  return { env, getProbeCount: () => probeCount };
}

describe("getCubeSourceWatermark", () => {
  it("combines max(created_at) and count into one string", async () => {
    const { env } = makeEnv({ maxTs: "2026-05-20 01:42:13", count: 87 });
    const wm = await getCubeSourceWatermark(env, "2026-05-20 01:00:00");
    expect(wm).toBe("2026-05-20 01:42:13|87");
  });

  it("renders an empty hour as the empty-watermark sentinel '|0'", async () => {
    const { env } = makeEnv({ maxTs: null, count: 0 });
    const wm = await getCubeSourceWatermark(env, "2026-05-20 00:00:00");
    expect(wm).toBe("|0");
  });

  it("treats two identical (max_ts, count) pairs as equal watermarks", async () => {
    const a = await getCubeSourceWatermark(
      makeEnv({ maxTs: "2026-05-20 01:42:13", count: 87 }).env,
      "2026-05-20 01:00:00",
    );
    const b = await getCubeSourceWatermark(
      makeEnv({ maxTs: "2026-05-20 01:42:13", count: 87 }).env,
      "2026-05-20 01:00:00",
    );
    expect(a).toBe(b);
  });

  it("differs when count changes (new threat landed)", async () => {
    const a = await getCubeSourceWatermark(
      makeEnv({ maxTs: "2026-05-20 01:42:13", count: 87 }).env,
      "2026-05-20 01:00:00",
    );
    const b = await getCubeSourceWatermark(
      makeEnv({ maxTs: "2026-05-20 01:42:13", count: 88 }).env,
      "2026-05-20 01:00:00",
    );
    expect(a).not.toBe(b);
  });

  it("differs when max_ts advances (newer threat with same count — unusual but possible)", async () => {
    const a = await getCubeSourceWatermark(
      makeEnv({ maxTs: "2026-05-20 01:42:13", count: 87 }).env,
      "2026-05-20 01:00:00",
    );
    const b = await getCubeSourceWatermark(
      makeEnv({ maxTs: "2026-05-20 01:55:00", count: 87 }).env,
      "2026-05-20 01:00:00",
    );
    expect(a).not.toBe(b);
  });

  it("issues exactly one probe per call", async () => {
    const { env, getProbeCount } = makeEnv({ maxTs: "x", count: 1 });
    await getCubeSourceWatermark(env, "2026-05-20 01:00:00");
    expect(getProbeCount()).toBe(1);
  });
});
