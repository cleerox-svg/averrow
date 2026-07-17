import { describe, it, expect } from "vitest";
import { trancoRankBucket } from "../src/handlers/admin";

describe("trancoRankBucket", () => {
  it("assigns top-1K to bucket 1", () => {
    expect(trancoRankBucket(1)).toBe(1);
    expect(trancoRankBucket(500)).toBe(1);
    expect(trancoRankBucket(1000)).toBe(1);
  });

  it("assigns top-10K (but not top-1K) to bucket 2", () => {
    expect(trancoRankBucket(1001)).toBe(2);
    expect(trancoRankBucket(5_000)).toBe(2);
    expect(trancoRankBucket(10_000)).toBe(2);
  });

  it("assigns top-100K (but not top-10K) to bucket 3", () => {
    expect(trancoRankBucket(10_001)).toBe(3);
    expect(trancoRankBucket(50_000)).toBe(3);
    expect(trancoRankBucket(100_000)).toBe(3);
  });

  it("assigns top-1M (but not top-100K) to bucket 4", () => {
    expect(trancoRankBucket(100_001)).toBe(4);
    expect(trancoRankBucket(500_000)).toBe(4);
    expect(trancoRankBucket(1_000_000)).toBe(4);
  });

  it("treats null/undefined/zero/negative as unranked (bucket 5)", () => {
    expect(trancoRankBucket(null)).toBe(5);
    expect(trancoRankBucket(undefined)).toBe(5);
    expect(trancoRankBucket(0)).toBe(5);
    expect(trancoRankBucket(-1)).toBe(5);
  });

  it("treats beyond-1M ranks as unranked (bucket 5)", () => {
    expect(trancoRankBucket(1_000_001)).toBe(5);
    expect(trancoRankBucket(9_999_999)).toBe(5);
  });

  it("intra-bucket jitter does not cross bucket — the whole point of this filter", () => {
    // The production audit found ~76K UPDATEs/day driven by tiny rank
    // shifts within the same band. None of these should trigger a write.
    expect(trancoRankBucket(50_000)).toBe(trancoRankBucket(75_000));
    expect(trancoRankBucket(2_000)).toBe(trancoRankBucket(9_500));
    expect(trancoRankBucket(101)).toBe(trancoRankBucket(999));
  });

  it("crossing a bucket boundary DOES register as a change", () => {
    expect(trancoRankBucket(1000)).not.toBe(trancoRankBucket(1001));
    expect(trancoRankBucket(10_000)).not.toBe(trancoRankBucket(10_001));
    expect(trancoRankBucket(100_000)).not.toBe(trancoRankBucket(100_001));
    expect(trancoRankBucket(1_000_000)).not.toBe(trancoRankBucket(1_000_001));
  });
});
