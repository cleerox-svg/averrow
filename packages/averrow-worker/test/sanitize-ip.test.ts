import { describe, it, expect } from "vitest";
import { sanitizeIp } from "../src/lib/sanitizeIp";

describe("sanitizeIp", () => {
  it("strips :port from IPv4", () => {
    expect(sanitizeIp("172.67.165.77:443")).toBe("172.67.165.77");
    expect(sanitizeIp("1.2.3.4:1")).toBe("1.2.3.4");
    expect(sanitizeIp("47.84.203.113:8888")).toBe("47.84.203.113");
  });

  it("leaves bare IPv4 untouched", () => {
    expect(sanitizeIp("192.168.1.1")).toBe("192.168.1.1");
    expect(sanitizeIp("8.8.8.8")).toBe("8.8.8.8");
  });

  it("leaves IPv6 unchanged (we don't yet resolve v6)", () => {
    expect(sanitizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(sanitizeIp("::1")).toBe("::1");
    expect(sanitizeIp("fe80::1")).toBe("fe80::1");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeIp("  172.67.165.77:443  ")).toBe("172.67.165.77");
    expect(sanitizeIp("\t1.2.3.4\n")).toBe("1.2.3.4");
  });

  it("handles null and empty", () => {
    expect(sanitizeIp(null)).toBeNull();
    expect(sanitizeIp(undefined)).toBeNull();
    expect(sanitizeIp("")).toBe("");
  });

  it("returns garbage as-is so the downstream parser can complain", () => {
    expect(sanitizeIp("not-an-ip")).toBe("not-an-ip");
    expect(sanitizeIp("999.999.999.999")).toBe("999.999.999.999");
  });
});
