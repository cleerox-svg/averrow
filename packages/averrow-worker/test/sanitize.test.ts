import { describe, it, expect } from "vitest";
import { sanitize, sanitizeTags, sanitizeDomain } from "../src/lib/sanitize";

describe("sanitize", () => {
  it("strips HTML tags", () => {
    expect(sanitize("<script>alert(1)</script>hello")).toBe("alert(1)hello");
  });

  it("encodes special characters", () => {
    const result = sanitize('test "quotes" & <angles>');
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
  });

  it("trims whitespace", () => {
    expect(sanitize("  hello  ")).toBe("hello");
  });

  it("respects maxLength", () => {
    const long = "a".repeat(2000);
    expect(sanitize(long, 100).length).toBe(100);
  });

  it("defaults to 1000 char max", () => {
    const long = "a".repeat(2000);
    expect(sanitize(long).length).toBe(1000);
  });
});

describe("sanitizeTags", () => {
  it("limits to maxTags", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `tag-${i}`);
    expect(sanitizeTags(tags).length).toBe(20);
  });

  it("strips special characters from tags", () => {
    expect(sanitizeTags(["<script>", "normal-tag"])).toEqual(["", "normal-tag"]);
  });

  it("handles empty array", () => {
    expect(sanitizeTags([])).toEqual([]);
  });
});

describe("sanitizeDomain", () => {
  it("accepts valid domains", () => {
    expect(sanitizeDomain("example.com")).toBe("example.com");
    expect(sanitizeDomain("sub.domain.co.uk")).toBe("sub.domain.co.uk");
  });

  it("strips protocol", () => {
    expect(sanitizeDomain("https://example.com")).toBe("example.com");
    expect(sanitizeDomain("http://test.org")).toBe("test.org");
  });

  it("strips path", () => {
    expect(sanitizeDomain("example.com/path/to/page")).toBe("example.com");
  });

  it("lowercases", () => {
    expect(sanitizeDomain("EXAMPLE.COM")).toBe("example.com");
  });

  it("rejects invalid domains", () => {
    expect(sanitizeDomain("not a domain!")).toBeNull();
    expect(sanitizeDomain("<script>")).toBeNull();
    expect(sanitizeDomain("")).toBeNull();
  });

  it("caps at 253 chars", () => {
    const long = "a".repeat(250) + ".com";
    const result = sanitizeDomain(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(253);
  });
});
