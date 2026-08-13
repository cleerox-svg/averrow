import { describe, it, expect, beforeEach } from "vitest";
import { handleTrackEvent } from "../src/handlers/track";
import type { Env } from "../src/types";

// ─── Minimal in-memory mocks ──────────────────────────────────────
class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

class MockDB {
  inserts: unknown[][] = [];
  prepare(_sql: string) {
    const self = this;
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async run() {
        self.inserts.push(bound);
        return { success: true };
      },
    };
  }
}

// waitUntil that awaits the promise so the insert completes within the test.
function makeCtx(pending: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil(p: Promise<unknown>) {
      pending.push(Promise.resolve(p));
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

function makeEnv(kv: MockKV, db: MockDB): Env {
  return { CACHE: kv, DB: db } as unknown as Env;
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://averrow.com/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleTrackEvent", () => {
  let kv: MockKV;
  let db: MockDB;
  let env: Env;
  let pending: Promise<unknown>[];
  let ctx: ExecutionContext;

  beforeEach(() => {
    kv = new MockKV();
    db = new MockDB();
    env = makeEnv(kv, db);
    pending = [];
    ctx = makeCtx(pending);
  });

  it("accepts a valid pageview → 204 and inserts one beacon row", async () => {
    const res = await handleTrackEvent(req({ type: "pageview", page: "/pricing", ref: "https://chatgpt.com/" }), env, ctx);
    expect(res.status).toBe(204);
    await Promise.all(pending);
    expect(db.inserts).toHaveLength(1);
    // event_type is the first bound param; ai_source (last) reflects the referrer.
    const row = db.inserts[0];
    expect(row[0]).toBe("pageview");
    expect(row[1]).toBe("/pricing"); // page
    expect(row[row.length - 1]).toBe("ChatGPT"); // ai_source classified server-side
    expect(row[row.length - 2]).toBe(1); // is_ai_referral
  });

  it("accepts a cta click with ctaId", async () => {
    const res = await handleTrackEvent(req({ type: "cta", page: "/", ctaId: "nav-get-demo" }), env, ctx);
    expect(res.status).toBe(204);
    await Promise.all(pending);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0][0]).toBe("cta");
    expect(db.inserts[0][2]).toBe("nav-get-demo"); // cta_id
  });

  it("rejects an unknown event type without inserting", async () => {
    const res = await handleTrackEvent(req({ type: "purchase", page: "/" }), env, ctx);
    expect(res.status).toBe(400);
    await Promise.all(pending);
    expect(db.inserts).toHaveLength(0);
  });

  it("rejects a page that doesn't start with / ", async () => {
    const res = await handleTrackEvent(req({ type: "pageview", page: "pricing" }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON content-type", async () => {
    const res = await handleTrackEvent(
      req({ type: "pageview", page: "/" }, { "Content-Type": "text/plain" }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const res = await handleTrackEvent(req("{not json", {}), env, ctx);
    expect(res.status).toBe(400);
  });

  it("silently 204s and stops inserting once over the rate-limit cap", async () => {
    await kv.put("pub_track_203.0.113.9", "120"); // at cap
    const res = await handleTrackEvent(req({ type: "pageview", page: "/" }), env, ctx);
    expect(res.status).toBe(204);
    await Promise.all(pending);
    expect(db.inserts).toHaveLength(0);
  });

  it("never stores a raw IP in the inserted row", async () => {
    await handleTrackEvent(req({ type: "pageview", page: "/security" }), env, ctx);
    await Promise.all(pending);
    const row = db.inserts[0];
    expect(row.some((v) => v === "203.0.113.9")).toBe(false);
  });
});
