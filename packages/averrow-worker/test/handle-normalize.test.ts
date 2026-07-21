import { describe, it, expect } from "vitest";
import { normalizeHandleForPlatform } from "../src/lib/handle-normalize";

describe("normalizeHandleForPlatform — base normalization", () => {
  it("trims, lowercases, and drops a single leading @", () => {
    expect(normalizeHandleForPlatform("  @JaneDoe ", "twitter")).toBe("janedoe");
    expect(normalizeHandleForPlatform("JANEDOE", "instagram")).toBe("janedoe");
  });

  it("caps at 30 characters", () => {
    const long = "a".repeat(40);
    expect(normalizeHandleForPlatform(long, "instagram")).toHaveLength(30);
  });
});

describe("normalizeHandleForPlatform — dots (bug #22)", () => {
  it("keeps the dot on Instagram / TikTok / YouTube", () => {
    expect(normalizeHandleForPlatform("jane.doe", "instagram")).toBe("jane.doe");
    expect(normalizeHandleForPlatform("jane.doe", "tiktok")).toBe("jane.doe");
    expect(normalizeHandleForPlatform("jane.doe", "youtube")).toBe("jane.doe");
  });

  it("strips the dot on X/Twitter and GitHub", () => {
    expect(normalizeHandleForPlatform("jane.doe", "twitter")).toBe("janedoe");
    expect(normalizeHandleForPlatform("jane.doe", "github")).toBe("janedoe");
  });

  it("strips the dot on LinkedIn slugs", () => {
    expect(normalizeHandleForPlatform("jane.doe", "linkedin")).toBe("janedoe");
  });

  it("makes `jane.doe` and `janedoe` DISTINCT on Instagram but EQUAL on X", () => {
    // Instagram: two different accounts.
    expect(normalizeHandleForPlatform("jane.doe", "instagram")).not.toBe(
      normalizeHandleForPlatform("janedoe", "instagram"),
    );
    // X: same account.
    expect(normalizeHandleForPlatform("jane.doe", "twitter")).toBe(
      normalizeHandleForPlatform("janedoe", "twitter"),
    );
  });
});

describe("normalizeHandleForPlatform — underscore & hyphen rules", () => {
  it("keeps underscores on X/Twitter, Instagram, TikTok, YouTube", () => {
    for (const p of ["twitter", "instagram", "tiktok", "youtube"]) {
      expect(normalizeHandleForPlatform("jane_doe", p)).toBe("jane_doe");
    }
  });

  it("strips underscores on GitHub and LinkedIn", () => {
    expect(normalizeHandleForPlatform("jane_doe", "github")).toBe("janedoe");
    expect(normalizeHandleForPlatform("jane_doe", "linkedin")).toBe("janedoe");
  });

  it("keeps hyphens on GitHub, LinkedIn, and YouTube", () => {
    expect(normalizeHandleForPlatform("jane-doe", "github")).toBe("jane-doe");
    expect(normalizeHandleForPlatform("jane-doe", "linkedin")).toBe("jane-doe");
    expect(normalizeHandleForPlatform("jane-doe", "youtube")).toBe("jane-doe");
  });

  it("strips hyphens on X/Twitter, Instagram, and TikTok", () => {
    expect(normalizeHandleForPlatform("jane-doe", "twitter")).toBe("janedoe");
    expect(normalizeHandleForPlatform("jane-doe", "instagram")).toBe("janedoe");
    expect(normalizeHandleForPlatform("jane-doe", "tiktok")).toBe("janedoe");
  });
});

describe("normalizeHandleForPlatform — unknown platform fallback", () => {
  it("keeps the full handle-safe set (dot/underscore/hyphen) when platform is unknown", () => {
    expect(normalizeHandleForPlatform("jane.doe_x-y", "myspace")).toBe("jane.doe_x-y");
    expect(normalizeHandleForPlatform("jane.doe", null)).toBe("jane.doe");
    expect(normalizeHandleForPlatform("jane.doe", undefined)).toBe("jane.doe");
  });

  it("still strips truly invalid characters (spaces, symbols)", () => {
    expect(normalizeHandleForPlatform("jane doe!", "instagram")).toBe("janedoe");
    expect(normalizeHandleForPlatform("jané döe", "instagram")).toBe("jande"); // non-ASCII dropped
  });
});
