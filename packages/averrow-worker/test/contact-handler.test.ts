import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleContactSubmission } from "../src/handlers/contact";
import { CONTACT_NOTIFY_DAILY_CAP, contactNotifyKey } from "../src/lib/contact-notify";
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
  insertSql: string[] = [];
  updates: unknown[][] = [];
  failUpdates = false;
  prepare(sql: string) {
    const self = this;
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async run() {
        if (/^\s*UPDATE/i.test(sql)) {
          if (self.failUpdates) throw new Error("D1 down");
          self.updates.push(bound);
        } else {
          self.inserts.push(bound);
          self.insertSql.push(sql);
        }
        return { success: true };
      },
    };
  }
}

function makeEnv(kv: MockKV, db: MockDB, extra: Record<string, unknown> = {}): Env {
  return { CACHE: kv, DB: db, RESEND_API_KEY: "re_test", ...extra } as unknown as Env;
}

type ResendPayload = {
  from: string; to: string[]; subject: string; html: string; text: string; reply_to?: string;
};

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
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    kv = new MockKV();
    db = new MockDB();
    env = makeEnv(kv, db);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  // ─── G38: the sender's IP is never stored ─────────────────────────
  it("does not store the sender's IP (ip_address written as NULL)", async () => {
    await handleContactSubmission(req(VALID), env);
    expect(db.inserts[0]).not.toContain("203.0.113.20");
    expect(db.insertSql[0]).toMatch(/ip_address\)\s*VALUES\s*\([^)]*NULL\)/);
    // ...while the IP is still used, transiently, for the KV rate-limit key.
    expect(await kv.get("pub_contact_203.0.113.20")).toBe("1");
  });

  // ─── Optional domain ──────────────────────────────────────────────
  it("stores an optional domain normalised with normalizePublicHostname", async () => {
    const res = await handleContactSubmission(req({ ...VALID, domain: "https://WWW.Acme.com/path" }), env);
    expect(res.status).toBe(200);
    expect(db.inserts[0]).toContain("acme.com");
  });

  it("rejects an invalid domain without inserting", async () => {
    const res = await handleContactSubmission(req({ ...VALID, domain: "<img src=x>.com" }), env);
    expect(res.status).toBe(400);
    expect(db.inserts).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty domain as absent", async () => {
    const res = await handleContactSubmission(req({ ...VALID, domain: "" }), env);
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
  });

  // ─── G33: staff notification ──────────────────────────────────────
  it("emails the submission to the internal inbox with Reply-To = sender", async () => {
    const res = await handleContactSubmission(req({ ...VALID, domain: "acme.com" }), env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const payload = JSON.parse(String(init.body)) as ResendPayload;
    expect(payload.to).toEqual(["claude.leroux@averrow.com"]);
    expect(payload.reply_to).toBe("dana@acme.com");
    expect(payload.subject).toContain("Demo request");
    expect(payload.subject).toContain("Acme Corp");
    for (const v of ["Dana Prospect", "dana@acme.com", "Acme Corp", "51-200", "demo", "acme.com", "walkthrough"]) {
      expect(payload.text).toContain(v);
      expect(payload.html).toContain(v);
    }
    // Outcome stamped on the row.
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0][0]).toBe("sent");
  });

  it("never exposes the internal inbox in the response body", async () => {
    const res = await handleContactSubmission(req(VALID), env);
    expect(await res.text()).not.toContain("claude.leroux");
  });

  it("HTML-escapes every user field in the email", async () => {
    await handleContactSubmission(req({
      ...VALID,
      name: "<script>alert(1)</script>",
      company: "Evil & <b>Co</b>",
      message: "<img src=x onerror=alert(2)>",
    }), env);
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as ResendPayload;
    expect(payload.html).not.toContain("<script>");
    expect(payload.html).not.toContain("<img src=x");
    expect(payload.html).not.toContain("<b>Co</b>");
    expect(payload.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(payload.html).toContain("Evil &amp; &lt;b&gt;Co&lt;/b&gt;");
  });

  it("keeps the subject on one line when the company contains newlines", async () => {
    await handleContactSubmission(req({ ...VALID, company: "Acme\r\nBcc: x@evil.test" }), env);
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as ResendPayload;
    expect(payload.subject).not.toMatch(/[\r\n]/);
  });

  it("omits Reply-To when the sender address is not a single plain mailbox", async () => {
    await handleContactSubmission(req({ ...VALID, email: "a,b@acme.com" }), env);
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as ResendPayload;
    expect(payload.reply_to).toBeUndefined();
  });

  it("labels the subject by interest (security report)", async () => {
    await handleContactSubmission(req({ ...VALID, interest: "security" }), env);
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as ResendPayload;
    expect(payload.subject).toContain("Security report");
  });

  it("stops emailing at the daily cap but still stores the row", async () => {
    await kv.put(contactNotifyKey(), String(CONTACT_NOTIFY_DAILY_CAP));
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.updates[0][0]).toBe("capped");
  });

  it("counts each sent notification against the daily cap", async () => {
    await handleContactSubmission(req(VALID), env);
    expect(await kv.get(contactNotifyKey())).toBe("1");
  });

  it("fails closed on a KV error for the cap: row stored, no email, 200", async () => {
    const orig = kv.get.bind(kv);
    kv.get = async (key: string) => {
      if (key.startsWith("contact:notify:")) throw new Error("KV unavailable");
      return orig(key);
    };
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.updates[0][0]).toBe("cap_error");
  });

  it("still succeeds when Resend returns an error, and records 'failed'", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
    expect(db.updates[0][0]).toBe("failed");
  });

  it("still succeeds when the network call throws", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("network down"); });
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    expect(db.updates[0][0]).toBe("failed");
  });

  it("still succeeds when RESEND_API_KEY is not configured", async () => {
    env = makeEnv(kv, db, { RESEND_API_KEY: undefined });
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.updates[0][0]).toBe("failed");
  });

  it("still succeeds when stamping the notify outcome fails", async () => {
    db.failUpdates = true;
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
  });

  it("sends no email for a honeypot hit", async () => {
    await handleContactSubmission(req({ ...VALID, company_website: "spam" }), env);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("labels a demo-form submission (domain, no interest) as a demo request", async () => {
    const { interest: _omit, ...noInterest } = VALID;
    await handleContactSubmission(req({ ...noInterest, domain: "acme.com" }), env);
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as ResendPayload;
    expect(payload.subject).toBe("[Averrow website] Demo request — Acme Corp");
  });
});
