import { describe, it, expect, beforeEach } from "vitest";
import { handleContactSubmission } from "../src/handlers/contact";
import type { Env } from "../src/types";

// ─── Minimal in-memory mocks (mirrors track-handler.test.ts) ──────
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

function makeEnv(kv: MockKV, db: MockDB): Env {
  return { CACHE: kv, DB: db } as unknown as Env;
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://averrow.com/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.20", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = {
  name: "Dana Prospect",
  email: "dana@acme.com",
  company: "Acme Corp",
  companySize: "51-200",
  interest: "demo",
  message: "We'd like a walkthrough of brand protection.",
};

// Bind order: id, name, email, company, company_size, interest, message, ip
const COMPANY_SIZE_IDX = 4;

describe("handleContactSubmission", () => {
  let kv: MockKV;
  let db: MockDB;
  let env: Env;

  beforeEach(() => {
    kv = new MockKV();
    db = new MockDB();
    env = makeEnv(kv, db);
  });

  it("accepts a valid submission → 200 and inserts one row", async () => {
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { success: boolean; data?: { id: string } };
    expect(parsed.success).toBe(true);
    expect(parsed.data?.id).toBeTruthy();
    expect(db.inserts).toHaveLength(1);
  });

  it("persists company_size (previously dropped)", async () => {
    await handleContactSubmission(req(VALID), env);
    expect(db.inserts[0][COMPANY_SIZE_IDX]).toBe("51-200");
  });

  it("silently accepts but does NOT insert when the honeypot is filled", async () => {
    const res = await handleContactSubmission(req({ ...VALID, company_website: "http://spam.example" }), env);
    // Returns success so the bot can't detect the trap...
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { success: boolean };
    expect(parsed.success).toBe(true);
    // ...but nothing is persisted.
    expect(db.inserts).toHaveLength(0);
  });

  it("ignores a whitespace-only honeypot value (treats it as empty)", async () => {
    const res = await handleContactSubmission(req({ ...VALID, company_website: "   " }), env);
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
  });

  it("rejects a submission missing required fields without inserting", async () => {
    const res = await handleContactSubmission(req({ name: "No Message", email: "x@y.com" }), env);
    expect(res.status).toBe(400);
    expect(db.inserts).toHaveLength(0);
  });

  it("rejects an invalid email", async () => {
    const res = await handleContactSubmission(req({ ...VALID, email: "not-an-email" }), env);
    expect(res.status).toBe(400);
    expect(db.inserts).toHaveLength(0);
  });

  it("increments the per-IP counter only on a persisted submission", async () => {
    await handleContactSubmission(req(VALID), env);
    expect(await kv.get("pub_contact_203.0.113.20")).toBe("1");
  });

  it("returns 429 without inserting once over the per-IP cap", async () => {
    await kv.put("pub_contact_203.0.113.20", "5"); // at cap
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(429);
    expect(db.inserts).toHaveLength(0);
  });

  it("never counts a honeypot hit toward the rate limit", async () => {
    await handleContactSubmission(req({ ...VALID, company_website: "spam" }), env);
    // No counter written — the drop happens before the rate-limit path.
    expect(await kv.get("pub_contact_203.0.113.20")).toBeNull();
  });
});
