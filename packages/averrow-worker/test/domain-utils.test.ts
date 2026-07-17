import { describe, it, expect } from "vitest";
import { extractDomain } from "../src/lib/domain-utils";

describe("extractDomain", () => {
  // Standard URLs
  it("extracts domain from standard HTTPS URL", () => {
    expect(extractDomain("https://example.com/path")).toBe("example.com");
  });

  it("extracts domain from HTTP URL", () => {
    expect(extractDomain("http://example.com/page")).toBe("example.com");
  });

  // URLs with www
  it("strips www prefix from URL", () => {
    expect(extractDomain("https://www.example.com")).toBe("example.com");
  });

  it("strips www prefix from bare domain", () => {
    expect(extractDomain("www.example.com")).toBe("example.com");
  });

  // URLs with ports
  it("extracts domain from URL with port", () => {
    expect(extractDomain("https://example.com:8080/path")).toBe("example.com");
  });

  it("extracts domain from URL with non-standard port", () => {
    expect(extractDomain("http://example.com:3000")).toBe("example.com");
  });

  // Email addresses
  it("extracts domain from email address", () => {
    expect(extractDomain("user@example.com")).toBe("example.com");
  });

  it("extracts domain from email with subdomain", () => {
    expect(extractDomain("admin@mail.example.com")).toBe("mail.example.com");
  });

  it("extracts domain from email with plus addressing", () => {
    expect(extractDomain("user+tag@example.com")).toBe("example.com");
  });

  // Bare domains
  it("returns bare domain as-is (lowercased)", () => {
    expect(extractDomain("example.com")).toBe("example.com");
  });

  it("lowercases bare domain input", () => {
    expect(extractDomain("EXAMPLE.COM")).toBe("example.com");
  });

  // Subdomains
  it("preserves subdomains (non-www)", () => {
    expect(extractDomain("https://sub.example.com")).toBe("sub.example.com");
  });

  it("preserves deep subdomains", () => {
    expect(extractDomain("https://a.b.c.example.com")).toBe("a.b.c.example.com");
  });

  // IP addresses
  it("extracts IP address from URL", () => {
    expect(extractDomain("https://192.168.1.1")).toBe("192.168.1.1");
  });

  it("extracts IP address with port from URL", () => {
    expect(extractDomain("http://192.168.1.1:8080/path")).toBe("192.168.1.1");
  });

  // Invalid / empty input
  it("returns null for empty string", () => {
    expect(extractDomain("")).toBeNull();
  });

  it("returns null for null input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractDomain(null as any)).toBeNull();
  });

  it("returns null for undefined input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractDomain(undefined as any)).toBeNull();
  });

  // Malformed URLs — extractDomain falls through to the catch block
  // and returns a cleaned string (the input lowercased, trimmed, www stripped, split on /)
  it("handles plain text gracefully", () => {
    const result = extractDomain("not a url");
    // The catch block splits on '/' and returns the first part lowercased
    expect(result).toBe("not a url");
  });

  it("handles single word gracefully", () => {
    const result = extractDomain("localhost");
    expect(result).toBe("localhost");
  });

  // URLs with query params
  it("extracts domain from URL with query params", () => {
    expect(extractDomain("https://example.com?foo=bar")).toBe("example.com");
  });

  it("extracts domain from URL with complex query string", () => {
    expect(extractDomain("https://example.com/path?foo=bar&baz=qux")).toBe("example.com");
  });

  // URLs with fragments
  it("extracts domain from URL with fragment", () => {
    expect(extractDomain("https://example.com#section")).toBe("example.com");
  });

  it("extracts domain from URL with path and fragment", () => {
    expect(extractDomain("https://example.com/page#anchor")).toBe("example.com");
  });

  // Protocol-relative URLs
  it("handles protocol-relative URL", () => {
    // //example.com/path → prepended with https:// → "https:////example.com/path"
    // The URL constructor should still parse the hostname
    const result = extractDomain("//example.com/path");
    expect(result).toBe("example.com");
  });

  // Edge cases
  it("trims whitespace from input", () => {
    expect(extractDomain("  https://example.com  ")).toBe("example.com");
  });

  it("handles URL with trailing slash", () => {
    expect(extractDomain("https://example.com/")).toBe("example.com");
  });

  it("handles URL with authentication credentials", () => {
    expect(extractDomain("https://user:pass@example.com/path")).toBe("example.com");
  });

  it("handles internationalized domain", () => {
    expect(extractDomain("https://münchen.de")).toBeTruthy();
  });
});
