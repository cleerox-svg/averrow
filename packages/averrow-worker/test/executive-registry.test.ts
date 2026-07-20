import { describe, it, expect } from "vitest";
import {
  SUPPORTED_EXEC_PLATFORMS,
  isSupportedExecPlatform,
  validateFullName,
  validateTitle,
  validateStatus,
  validateWatchPlatforms,
  validateOfficialHandles,
  validateExecutiveCreate,
  buildExecutiveUpdate,
} from "../src/lib/executive-registry";

describe("executive-registry — platform keys", () => {
  it("mirrors the social-monitor's six supported platforms", () => {
    expect([...SUPPORTED_EXEC_PLATFORMS]).toEqual([
      "twitter", "linkedin", "instagram", "tiktok", "github", "youtube",
    ]);
  });
  it("isSupportedExecPlatform accepts known, rejects unknown", () => {
    expect(isSupportedExecPlatform("linkedin")).toBe(true);
    expect(isSupportedExecPlatform("facebook")).toBe(false);
    expect(isSupportedExecPlatform("LinkedIn")).toBe(false); // case-sensitive set
  });
});

describe("validateFullName", () => {
  it("accepts a trimmed non-empty name", () => {
    expect(validateFullName("  Ada Lovelace  ")).toEqual({ ok: true, value: "Ada Lovelace" });
  });
  it("rejects empty / whitespace / non-string", () => {
    expect(validateFullName("").ok).toBe(false);
    expect(validateFullName("   ").ok).toBe(false);
    expect(validateFullName(undefined).ok).toBe(false);
    expect(validateFullName(42).ok).toBe(false);
  });
  it("rejects over-long names", () => {
    expect(validateFullName("a".repeat(201)).ok).toBe(false);
  });
});

describe("validateTitle", () => {
  it("defaults empty/undefined to null", () => {
    expect(validateTitle(undefined)).toEqual({ ok: true, value: null });
    expect(validateTitle("   ")).toEqual({ ok: true, value: null });
  });
  it("trims a real title", () => {
    expect(validateTitle("  CEO ")).toEqual({ ok: true, value: "CEO" });
  });
  it("rejects non-string", () => {
    expect(validateTitle(7).ok).toBe(false);
  });
  it("rejects over-long titles (>200)", () => {
    expect(validateTitle("a".repeat(201)).ok).toBe(false);
    expect(validateTitle("a".repeat(200)).ok).toBe(true);
  });
});

describe("validateStatus", () => {
  it("defaults to active", () => {
    expect(validateStatus(undefined)).toEqual({ ok: true, value: "active" });
  });
  it("accepts active/paused", () => {
    expect(validateStatus("active")).toEqual({ ok: true, value: "active" });
    expect(validateStatus("paused")).toEqual({ ok: true, value: "paused" });
  });
  it("normalizes case + surrounding whitespace before matching (FIX 2)", () => {
    expect(validateStatus("Active")).toEqual({ ok: true, value: "active" });
    expect(validateStatus(" active")).toEqual({ ok: true, value: "active" });
    expect(validateStatus("PAUSED ")).toEqual({ ok: true, value: "paused" });
  });
  it("still rejects out-of-vocabulary values", () => {
    expect(validateStatus("retired").ok).toBe(false);
    expect(validateStatus("bogus").ok).toBe(false);
    expect(validateStatus(1).ok).toBe(false);
  });
});

describe("validateWatchPlatforms", () => {
  it("defaults to all six when omitted", () => {
    const r = validateWatchPlatforms(undefined);
    expect(r).toEqual({ ok: true, value: [...SUPPORTED_EXEC_PLATFORMS] });
  });
  it("accepts a valid subset and dedupes/lowercases", () => {
    const r = validateWatchPlatforms(["twitter", "TWITTER", "GitHub"]);
    expect(r).toEqual({ ok: true, value: ["twitter", "github"] });
  });
  it("rejects unknown platform keys — detection can't scan them", () => {
    const r = validateWatchPlatforms(["twitter", "facebook"]);
    expect(r.ok).toBe(false);
  });
  it("rejects non-array and empty array", () => {
    expect(validateWatchPlatforms("twitter").ok).toBe(false);
    expect(validateWatchPlatforms([]).ok).toBe(false);
  });
  it("rejects non-string entries", () => {
    expect(validateWatchPlatforms([1, 2]).ok).toBe(false);
  });
});

describe("validateOfficialHandles", () => {
  it("defaults to empty object when omitted", () => {
    expect(validateOfficialHandles(undefined)).toEqual({ ok: true, value: {} });
  });
  it("strips leading @ and lowercases platform key", () => {
    const r = validateOfficialHandles({ Twitter: "@ada", linkedin: "ada-l" });
    expect(r).toEqual({ ok: true, value: { twitter: "ada", linkedin: "ada-l" } });
  });
  it("rejects unknown platform key", () => {
    expect(validateOfficialHandles({ facebook: "ada" }).ok).toBe(false);
  });
  it("rejects empty handle value and non-string value", () => {
    expect(validateOfficialHandles({ twitter: "  " }).ok).toBe(false);
    expect(validateOfficialHandles({ twitter: 5 }).ok).toBe(false);
  });
  it("rejects an over-long handle value (>100)", () => {
    expect(validateOfficialHandles({ twitter: "a".repeat(101) }).ok).toBe(false);
    expect(validateOfficialHandles({ twitter: "a".repeat(100) }).ok).toBe(true);
  });
  it("rejects arrays / non-objects", () => {
    expect(validateOfficialHandles(["twitter"]).ok).toBe(false);
    expect(validateOfficialHandles("twitter").ok).toBe(false);
  });
});

describe("validateExecutiveCreate — full payload", () => {
  it("accepts a complete valid body", () => {
    const r = validateExecutiveCreate({
      full_name: "Ada Lovelace",
      title: "CEO",
      official_handles: { twitter: "@ada" },
      watch_platforms: ["twitter", "linkedin"],
      status: "active",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.official_handles).toEqual({ twitter: "ada" });
      expect(r.value.watch_platforms).toEqual(["twitter", "linkedin"]);
      expect(r.value.status).toBe("active");
      expect(r.value.title).toBe("CEO");
    }
  });
  it("applies defaults when optional fields omitted", () => {
    const r = validateExecutiveCreate({ full_name: "Grace Hopper" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBeNull();
      expect(r.value.official_handles).toEqual({});
      expect(r.value.watch_platforms).toEqual([...SUPPORTED_EXEC_PLATFORMS]);
      expect(r.value.status).toBe("active");
    }
  });
  it("fails fast on the first invalid field", () => {
    expect(validateExecutiveCreate({ full_name: "" }).ok).toBe(false);
    expect(validateExecutiveCreate({ full_name: "X", watch_platforms: ["nope"] }).ok).toBe(false);
    expect(validateExecutiveCreate({ full_name: "X", status: "bad" }).ok).toBe(false);
  });
});

describe("buildExecutiveUpdate — partial merge (omit = unchanged)", () => {
  it("omitted fields produce no SET fragments", () => {
    const r = buildExecutiveUpdate({});
    expect(r).toEqual({ ok: true, value: { sets: [], binds: [] } });
  });
  it("only present fields are emitted, in column order, with serialized JSON", () => {
    const r = buildExecutiveUpdate({
      status: "Paused",                       // normalized
      official_handles: { twitter: "@ada" },  // serialized + normalized
      full_name: "  Ada  ",                   // trimmed
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sets).toEqual(["full_name = ?", "official_handles = ?", "status = ?"]);
      expect(r.value.binds).toEqual(["Ada", JSON.stringify({ twitter: "ada" }), "paused"]);
    }
  });
  it("an explicitly-null title is a real change (sets NULL), distinct from omission", () => {
    const present = buildExecutiveUpdate({ title: null });
    expect(present).toEqual({ ok: true, value: { sets: ["title = ?"], binds: [null] } });
    const omitted = buildExecutiveUpdate({});
    expect(omitted.ok && omitted.value.sets.length).toBe(0);
  });
  it("watch_platforms is deduped/lowercased then serialized", () => {
    const r = buildExecutiveUpdate({ watch_platforms: ["TWITTER", "twitter", "GitHub"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sets).toEqual(["watch_platforms = ?"]);
      expect(r.value.binds).toEqual([JSON.stringify(["twitter", "github"])]);
    }
  });
  it("fails fast on the first invalid present field", () => {
    expect(buildExecutiveUpdate({ full_name: "" }).ok).toBe(false);
    expect(buildExecutiveUpdate({ watch_platforms: ["facebook"] }).ok).toBe(false);
    expect(buildExecutiveUpdate({ status: "bogus" }).ok).toBe(false);
    expect(buildExecutiveUpdate({ official_handles: { twitter: "a".repeat(101) } }).ok).toBe(false);
  });
});
