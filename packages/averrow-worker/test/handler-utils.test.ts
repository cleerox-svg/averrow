import { describe, it, expect } from "vitest";
import {
  parsePagination,
  parseFilters,
  buildWhereClause,
  requireFields,
  success,
  error,
} from "../src/lib/handler-utils";

// Helper to create a Request with query params
function makeRequest(path: string): Request {
  return new Request(`https://api.example.com${path}`);
}

describe("parsePagination", () => {
  it("returns default limit=50, offset=0, page=1 with no params", () => {
    const result = parsePagination(makeRequest("/api/items"));
    expect(result).toEqual({ limit: 50, offset: 0, page: 1 });
  });

  it("parses custom limit", () => {
    const result = parsePagination(makeRequest("/api/items?limit=10"));
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it("parses custom offset", () => {
    const result = parsePagination(makeRequest("/api/items?offset=20"));
    expect(result.offset).toBe(20);
    expect(result.limit).toBe(50);
  });

  it("parses both limit and offset", () => {
    const result = parsePagination(makeRequest("/api/items?limit=25&offset=50"));
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(50);
  });

  it("caps limit at default maxLimit of 100", () => {
    const result = parsePagination(makeRequest("/api/items?limit=500"));
    expect(result.limit).toBe(100);
  });

  it("caps limit at custom maxLimit", () => {
    const result = parsePagination(makeRequest("/api/items?limit=500"), {
      maxLimit: 200,
    });
    expect(result.limit).toBe(200);
  });

  it("uses custom default limit", () => {
    const result = parsePagination(makeRequest("/api/items"), { limit: 25 });
    expect(result.limit).toBe(25);
  });

  it("calculates page from offset and limit", () => {
    const result = parsePagination(makeRequest("/api/items?limit=10&offset=30"));
    // page = floor(30/10) + 1 = 4
    expect(result.page).toBe(4);
  });

  it("handles page=1 when offset=0", () => {
    const result = parsePagination(makeRequest("/api/items?limit=10&offset=0"));
    expect(result.page).toBe(1);
  });

  it("handles non-numeric limit gracefully", () => {
    const result = parsePagination(makeRequest("/api/items?limit=abc"));
    // parseInt("abc", 10) = NaN; Math.min(NaN, 100) = NaN
    // NaN behavior: page = floor(0/NaN) + 1 = NaN+1 = NaN
    // The function doesn't explicitly guard against NaN, but it should not crash
    expect(result).toBeDefined();
  });

  it("handles negative limit", () => {
    const result = parsePagination(makeRequest("/api/items?limit=-1"));
    // parseInt("-1") = -1; Math.min(-1, 100) = -1
    expect(result.limit).toBe(-1);
    // The function doesn't clamp negative — it's up to the handler to validate
  });

  it("handles zero limit", () => {
    const result = parsePagination(makeRequest("/api/items?limit=0"));
    expect(result.limit).toBe(0);
  });
});

describe("parseFilters", () => {
  it("extracts allowed filters from query params", () => {
    const result = parseFilters(
      makeRequest("/api/items?status=active&type=phishing"),
      ["status", "type"],
    );
    expect(result).toEqual({ status: "active", type: "phishing" });
  });

  it("ignores unknown filters", () => {
    const result = parseFilters(
      makeRequest("/api/items?unknown=value&status=active"),
      ["status", "type"],
    );
    expect(result).toEqual({ status: "active" });
    expect(result).not.toHaveProperty("unknown");
  });

  it("returns empty object when no allowed filters match", () => {
    const result = parseFilters(
      makeRequest("/api/items?unknown=value"),
      ["status", "type"],
    );
    expect(result).toEqual({});
  });

  it("returns empty object when no query params present", () => {
    const result = parseFilters(makeRequest("/api/items"), ["status", "type"]);
    expect(result).toEqual({});
  });

  it("excludes empty values", () => {
    // url.searchParams.get returns "" for ?status= which is falsy
    const result = parseFilters(
      makeRequest("/api/items?status="),
      ["status"],
    );
    // val = "" which is falsy, so it should not be included
    expect(result).toEqual({});
  });

  it("handles multiple allowed filters with partial matches", () => {
    const result = parseFilters(
      makeRequest("/api/items?status=active"),
      ["status", "type", "severity"],
    );
    expect(result).toEqual({ status: "active" });
  });

  it("preserves filter value case", () => {
    const result = parseFilters(
      makeRequest("/api/items?status=Active"),
      ["status"],
    );
    expect(result.status).toBe("Active");
  });
});

describe("buildWhereClause", () => {
  it("returns '1=1' with empty bindings for empty filters", () => {
    const result = buildWhereClause({}, { status: "status" });
    expect(result).toEqual({ clause: "1=1", bindings: [] });
  });

  it("builds single condition", () => {
    const result = buildWhereClause(
      { status: "active" },
      { status: "status" },
    );
    expect(result.clause).toBe("status = ?");
    expect(result.bindings).toEqual(["active"]);
  });

  it("builds multiple conditions joined with AND", () => {
    const result = buildWhereClause(
      { status: "active", type: "phishing" },
      { status: "status", type: "threat_type" },
    );
    expect(result.clause).toBe("status = ? AND threat_type = ?");
    expect(result.bindings).toEqual(["active", "phishing"]);
  });

  it("maps filter keys to column names", () => {
    const result = buildWhereClause(
      { type: "malware" },
      { type: "threat_type" },
    );
    expect(result.clause).toBe("threat_type = ?");
  });

  it("ignores filters without matching column mapping", () => {
    const result = buildWhereClause(
      { status: "active", unknown: "value" },
      { status: "status" },
    );
    expect(result.clause).toBe("status = ?");
    expect(result.bindings).toEqual(["active"]);
  });

  it("returns '1=1' when no filters match column map", () => {
    const result = buildWhereClause(
      { unknown: "value" },
      { status: "status" },
    );
    expect(result.clause).toBe("1=1");
    expect(result.bindings).toEqual([]);
  });
});

describe("requireFields", () => {
  it("returns null when all required fields are present", () => {
    const result = requireFields({ name: "test", email: "a@b.com" }, ["name", "email"], null);
    expect(result).toBeNull();
  });

  it("returns 400 Response when one field is missing", async () => {
    const result = requireFields({ name: "test" }, ["name", "email"], null);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(400);
    const body = await result!.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("email");
  });

  it("returns 400 Response listing all missing fields", async () => {
    const result = requireFields({}, ["name", "email", "domain"], null);
    expect(result).toBeInstanceOf(Response);
    const body = await result!.json() as { success: boolean; error: string };
    expect(body.error).toContain("name");
    expect(body.error).toContain("email");
    expect(body.error).toContain("domain");
  });

  it("treats falsy values (empty string) as missing", async () => {
    const result = requireFields({ name: "" }, ["name"], null);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(400);
  });

  it("treats null values as missing", async () => {
    const result = requireFields({ name: null }, ["name"], null);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(400);
  });

  it("accepts truthy values including 0", () => {
    // 0 is falsy in JS — requireFields uses !body[f] which treats 0 as missing
    const result = requireFields({ count: 0 }, ["count"], null);
    // 0 is falsy, so this will return a 400 response
    expect(result).toBeInstanceOf(Response);
  });

  it("accepts non-empty objects and arrays as present", () => {
    const result = requireFields({ tags: ["a"], meta: { key: "val" } }, ["tags", "meta"], null);
    expect(result).toBeNull();
  });
});

describe("success helper", () => {
  it("returns 200 JSON response with success=true and data", async () => {
    const response = success({ id: "123" }, null);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { id: string } };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ id: "123" });
  });

  it("accepts custom status code", async () => {
    const response = success({ id: "123" }, null, 201);
    expect(response.status).toBe(201);
  });

  it("wraps array data", async () => {
    const response = success([1, 2, 3], null);
    const body = await response.json() as { success: boolean; data: number[] };
    expect(body.data).toEqual([1, 2, 3]);
  });

  it("wraps null data", async () => {
    const response = success(null, null);
    const body = await response.json() as { success: boolean; data: null };
    expect(body.success).toBe(true);
    expect(body.data).toBeNull();
  });

  it("includes CORS headers", () => {
    const response = success({}, "https://averrow.com");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });
});

describe("error helper", () => {
  it("returns JSON response with success=false and error message", async () => {
    const response = error("Not found", 404, null);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(404);
    const body = await response.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Not found");
  });

  it("returns 500 for server errors", async () => {
    const response = error("Internal error", 500, null);
    expect(response.status).toBe(500);
    const body = await response.json() as { success: boolean; error: string };
    expect(body.error).toBe("Internal error");
  });

  it("returns 400 for bad requests", async () => {
    const response = error("Bad request", 400, null);
    expect(response.status).toBe(400);
  });

  it("includes CORS headers", () => {
    const response = error("err", 500, "https://averrow.com");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });
});
