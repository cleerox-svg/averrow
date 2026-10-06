// POST /api/contact over real SQLite (node:sqlite, schema derived from
// migrations/): the per-IP limit and the daily email cap are atomic D1
// counters in contact_rate (lib/contact-rate.ts), so the race tests below run
// the actual INSERT ... ON CONFLICT ... RETURNING statement.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleContactSubmission, CONTACT_RATE_LIMIT, isValidContactEmail } from "../src/handlers/contact";
import {
  CONTACT_NOTIFY_DAILY_CAP,
  UNVERIFIED_LINE,
  buildContactSubject,
  contactCapNoticeKey,
  contactNotifyKey,
} from "../src/lib/contact-notify";
import {
  contactIpRateKey,
  contactRateIpPrefix,
  purgeExpiredContactRate,
  sqliteUtc,
} from "../src/lib/contact-rate";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const JWT_SECRET = "test-secret-contact";
const IP = "203.0.113.20";

type ResendPayload = {
  from: string; to: string[]; subject: string; html: string; text: string; reply_to?: string;
};

/** Wrap a D1 so statements matching `fail` throw (on any execution method). */
function failing(db: D1Database, fail: (sql: string) => boolean): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      if (!fail(sql)) return stmt;
      const boom = async () => { throw new Error("D1 down"); };
      const s = { bind: () => s, run: boom, first: boom, all: boom };
      return s as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://averrow.com/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP, ...headers },
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

describe.skipIf(!hasSqlite())("handleContactSubmission", () => {
  let raw: SqliteDb;
  let d1: D1Database;
  let env: Env;
  let fetchMock: ReturnType<typeof vi.fn>;

  const makeEnv = (db: D1Database, extra: Record<string, unknown> = {}): Env =>
    ({ CACHE: fakeKv(), DB: db, JWT_SECRET, RESEND_API_KEY: "re_test", ...extra }) as unknown as Env;

  const rows = () =>
    raw.prepare("SELECT * FROM contact_submissions").all() as Array<Record<string, unknown>>;
  const counter = (key: string): number | null => {
    const r = raw.prepare("SELECT n FROM contact_rate WHERE key = ?").all(key) as Array<{ n: number }>;
    return r[0]?.n ?? null;
  };
  const setCounter = (key: string, n: number) =>
    raw.prepare("INSERT INTO contact_rate (key, n, expires_at) VALUES (?, ?, ?)").run(key, n, sqliteUtc(Date.now() + 86_400_000));
  const ipKey = async () => (await contactIpRateKey({ JWT_SECRET }, IP, 3600)).key;
  const payloads = () =>
    fetchMock.mock.calls.map((c) => JSON.parse(String((c as [string, RequestInit])[1].body)) as ResendPayload);

  beforeEach(() => {
    raw = openDerivedDb(["contact_submissions", "contact_rate"]);
    d1 = d1FromSqlite(raw);
    env = makeEnv(d1);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Basics ───────────────────────────────────────────────────────
  it("accepts a valid submission → 200 and inserts one row", async () => {
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { success: boolean; data?: { id: string } };
    expect(parsed.success).toBe(true);
    expect(parsed.data?.id).toBeTruthy();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.company_size).toBe("51-200");
  });

  it("silently accepts but does NOT insert when the honeypot is filled", async () => {
    const res = await handleContactSubmission(req({ ...VALID, company_website: "http://spam.example" }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
    expect(rows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // The drop happens before the rate-limit path.
    expect(counter(await ipKey())).toBeNull();
  });

  it("treats a non-string honeypot value as filled", async () => {
    const res = await handleContactSubmission(req({ ...VALID, company_website: 1 }), env);
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  it("ignores a whitespace-only honeypot value (treats it as empty)", async () => {
    const res = await handleContactSubmission(req({ ...VALID, company_website: "   " }), env);
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
  });

  it("rejects a submission missing required fields without inserting", async () => {
    const res = await handleContactSubmission(req({ name: "No Message", email: "x@y.com" }), env);
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it("400s (not 500) on malformed JSON", async () => {
    const res = await handleContactSubmission(req("{not json"), env);
    expect(res.status).toBe(400);
  });

  // ─── Validation hardening ─────────────────────────────────────────
  it.each([
    ["name", 42],
    ["email", ["dana@acme.com"]],
    ["message", { text: "hi" }],
    ["company", 7],
    ["companySize", true],
    ["interest", ["demo"]],
  ])("rejects a non-string %s with 400, not 500", async (field, value) => {
    const res = await handleContactSubmission(req({ ...VALID, [field]: value }), env);
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it.each(["name", "company", "companySize", "interest"])("caps %s at 200 characters", async (field) => {
    const ok = await handleContactSubmission(req({ ...VALID, [field]: "x".repeat(200) }), env);
    expect(ok.status).toBe(200);
    const res = await handleContactSubmission(req({ ...VALID, [field]: "x".repeat(201) }), env);
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(1);
  });

  it.each([
    "not-an-email",
    "javascript:alert(1)@acme.com",
    "a,b@acme.com",
    "<dana@acme.com>",
    "dana@acme",
    "dana..x@acme.com",
    "dana @acme.com",
  ])("rejects the email %j", async (email) => {
    const res = await handleContactSubmission(req({ ...VALID, email }), env);
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it("accepts ordinary addresses", () => {
    for (const e of ["dana@acme.com", "dana.prospect+demo@mail.acme.co.uk", "o'brien@acme.com"]) {
      expect(isValidContactEmail(e), e).toBe(true);
    }
  });

  // ─── G38: the sender's IP is never stored ─────────────────────────
  it("does not store the sender's IP anywhere", async () => {
    await handleContactSubmission(req(VALID), env);
    expect(rows()[0]!.ip_address).toBeNull();
    const dump = JSON.stringify(raw.prepare("SELECT * FROM contact_rate").all());
    expect(dump).not.toContain(IP);
    // ...while the IP is still used, transiently, for the hashed rate-limit key.
    expect(counter(await ipKey())).toBe(1);
  });

  // ─── Per-IP limit (atomic D1 counter) ─────────────────────────────
  it("returns 429 without inserting once over the per-IP cap", async () => {
    setCounter(await ipKey(), CONTACT_RATE_LIMIT);
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(429);
    expect(rows()).toHaveLength(0);
  });

  it("concurrent submissions from one IP: exactly the limit get through", async () => {
    const results = await Promise.all(
      Array.from({ length: CONTACT_RATE_LIMIT + 3 }, () => handleContactSubmission(req(VALID), env)),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(CONTACT_RATE_LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(3);
    expect(rows()).toHaveLength(CONTACT_RATE_LIMIT);
  });

  it("keys IPv6 senders on their /64", async () => {
    for (let i = 0; i < CONTACT_RATE_LIMIT; i++) {
      const r = await handleContactSubmission(req(VALID, { "CF-Connecting-IP": `2001:db8:1:2::${i + 1}` }), env);
      expect(r.status).toBe(200);
    }
    const blocked = await handleContactSubmission(req(VALID, { "CF-Connecting-IP": "2001:db8:1:2:ffff::9" }), env);
    expect(blocked.status).toBe(429);
    const otherNet = await handleContactSubmission(req(VALID, { "CF-Connecting-IP": "2001:db8:1:3::1" }), env);
    expect(otherNet.status).toBe(200);
  });

  it("gives the slot back when the insert fails", async () => {
    env = makeEnv(failing(d1, (sql) => /INSERT INTO contact_submissions/.test(sql)));
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(500);
    expect(counter(await ipKey())).toBe(0);
  });

  it("fails open when the rate counter errors: the submission is still stored", async () => {
    // Fail only the per-IP bump (first contact_rate statement); the cap bump
    // still runs so the email goes out.
    let first = true;
    env = makeEnv(failing(d1, (sql) => {
      if (/INSERT INTO contact_rate/.test(sql) && first) { first = false; return true; }
      return false;
    }));
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ─── Optional domain ──────────────────────────────────────────────
  it("stores an optional domain normalised with normalizePublicHostname", async () => {
    const res = await handleContactSubmission(req({ ...VALID, domain: "https://WWW.Acme.com/path" }), env);
    expect(res.status).toBe(200);
    expect(rows()[0]!.domain).toBe("acme.com");
  });

  it("rejects an invalid domain without inserting", async () => {
    const res = await handleContactSubmission(req({ ...VALID, domain: "<img src=x>.com" }), env);
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty domain as absent", async () => {
    const res = await handleContactSubmission(req({ ...VALID, domain: "" }), env);
    expect(res.status).toBe(200);
    expect(rows()[0]!.domain).toBeNull();
  });

  // ─── G33: staff notification ──────────────────────────────────────
  it("emails the submission to the internal inbox with Reply-To = sender", async () => {
    const res = await handleContactSubmission(req({ ...VALID, domain: "acme.com" }), env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const payload = payloads()[0]!;
    expect(payload.to).toEqual(["claude.leroux@averrow.com"]);
    expect(payload.reply_to).toBe("dana@acme.com");
    expect(payload.subject).toBe("[Averrow website] Demo request — Acme Corp");
    for (const v of ["Dana Prospect", "dana@acme.com", "Acme Corp", "51-200", "demo", "acme.com", "walkthrough"]) {
      expect(payload.text).toContain(v);
      expect(payload.html).toContain(v);
    }
    expect(rows()[0]!.notify_status).toBe("sent");
    expect(rows()[0]!.notified_at).not.toBeNull();
  });

  it("opens the email with an 'Unverified website submission' line", async () => {
    await handleContactSubmission(req(VALID), env);
    const p = payloads()[0]!;
    expect(p.text.split("\n")[0]).toBe(UNVERIFIED_LINE);
    expect(UNVERIFIED_LINE.startsWith("Unverified website submission")).toBe(true);
    expect(p.html.indexOf("Unverified website submission")).toBeLessThan(p.html.indexOf("Demo request"));
  });

  it("keeps the subject to the fixed label plus at most 40 characters of company", async () => {
    const subject = buildContactSubject({
      id: "x", name: "n", email: "e@x.com", companySize: null, interest: "general", domain: null, message: "m",
      company: "A".repeat(120),
    });
    const prefix = "[Averrow website] General inquiry — ";
    expect(subject.startsWith(prefix)).toBe(true);
    expect(subject.length - prefix.length).toBeLessThanOrEqual(40);
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
    const payload = payloads()[0]!;
    expect(payload.html).not.toContain("<script>");
    expect(payload.html).not.toContain("<img src=x");
    expect(payload.html).not.toContain("<b>Co</b>");
    expect(payload.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(payload.html).toContain("Evil &amp; &lt;b&gt;Co&lt;/b&gt;");
  });

  it("keeps the subject on one line when the company contains newlines", async () => {
    await handleContactSubmission(req({ ...VALID, company: "Acme\r\nBcc: x@evil.test" }), env);
    expect(payloads()[0]!.subject).not.toMatch(/[\r\n]/);
  });

  it("omits Reply-To when the sender address is valid but not header-safe", async () => {
    await handleContactSubmission(req({ ...VALID, email: "o'brien@acme.com" }), env);
    expect(payloads()[0]!.reply_to).toBeUndefined();
  });

  it.each([
    ["general", "General inquiry"],
    ["enterprise", "Plans and enterprise inquiry"],
    ["partnership", "Partnership inquiry"],
    ["security", "Security report"],
    ["careers", "Contact form"],
  ])("labels interest %s as %s", async (interest, label) => {
    await handleContactSubmission(req({ ...VALID, interest }), env);
    expect(payloads()[0]!.subject).toContain(`] ${label}`);
  });

  it("labels a legacy demo-form submission (domain, no interest) as a demo request", async () => {
    const { interest: _omit, ...noInterest } = VALID;
    await handleContactSubmission(req({ ...noInterest, domain: "acme.com" }), env);
    expect(payloads()[0]!.subject).toBe("[Averrow website] Demo request — Acme Corp");
  });

  it("sends no email for a honeypot hit", async () => {
    await handleContactSubmission(req({ ...VALID, company_website: "spam" }), env);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ─── Daily cap (atomic D1 counter) ────────────────────────────────
  it("counts each sent notification against the daily cap", async () => {
    await handleContactSubmission(req(VALID), env);
    expect(counter(contactNotifyKey())).toBe(1);
  });

  it("at the cap: row stored, no submission email, one cap-reached notice", async () => {
    setCounter(contactNotifyKey(), CONTACT_NOTIFY_DAILY_CAP);
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(rows()[0]!.notify_status).toBe("capped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const notice = payloads()[0]!;
    expect(notice.to).toEqual(["claude.leroux@averrow.com"]);
    expect(notice.subject).toBe("[Averrow website] Daily email cap reached");
    expect(notice.text).toContain("stored but not emailed");
    // The counter never sits above the cap.
    expect(counter(contactNotifyKey())).toBe(CONTACT_NOTIFY_DAILY_CAP);
    expect(counter(contactCapNoticeKey())).toBe(1);

    // Further capped submissions that day send nothing more.
    const res2 = await handleContactSubmission(req(VALID, { "CF-Connecting-IP": "198.51.100.7" }), env);
    expect(res2.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(2);
  });

  it("concurrent submissions around the cap: no slot is double-booked, one notice", async () => {
    setCounter(contactNotifyKey(), CONTACT_NOTIFY_DAILY_CAP - 2);
    const ips = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4", "198.51.100.5"];
    const results = await Promise.all(ips.map((ip) => handleContactSubmission(req(VALID, { "CF-Connecting-IP": ip }), env)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const statuses = rows().map((r) => r.notify_status).sort();
    expect(statuses).toEqual(["capped", "capped", "capped", "sent", "sent"]);
    const subjects = payloads().map((p) => p.subject);
    expect(subjects.filter((s) => s.includes("Daily email cap reached"))).toHaveLength(1);
    expect(subjects.filter((s) => s.includes("Demo request"))).toHaveLength(2);
    expect(counter(contactNotifyKey())).toBe(CONTACT_NOTIFY_DAILY_CAP);
  });

  it("a failed cap notice is retried by the next capped submission", async () => {
    setCounter(contactNotifyKey(), CONTACT_NOTIFY_DAILY_CAP);
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 500 }));
    await handleContactSubmission(req(VALID), env);
    expect(counter(contactCapNoticeKey())).toBe(0);
    await handleContactSubmission(req(VALID, { "CF-Connecting-IP": "198.51.100.9" }), env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(counter(contactCapNoticeKey())).toBe(1);
  });

  it("fails closed on a D1 error for the cap: row stored, no email, 200", async () => {
    env = makeEnv(failing(d1, (sql) => /INSERT INTO contact_rate/.test(sql)));
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()[0]!.notify_status).toBe("cap_error");
  });

  it("a Resend error records 'failed' and gives the cap slot back", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
    expect(rows()[0]!.notify_status).toBe("failed");
    expect(counter(contactNotifyKey())).toBe(0);
  });

  it("a network error records 'failed' and gives the cap slot back", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("network down"); });
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(rows()[0]!.notify_status).toBe("failed");
    expect(counter(contactNotifyKey())).toBe(0);
  });

  it("a missing RESEND_API_KEY burns no cap slot", async () => {
    env = makeEnv(d1, { RESEND_API_KEY: undefined });
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()[0]!.notify_status).toBe("failed");
    expect(counter(contactNotifyKey())).toBe(0);
  });

  it("still succeeds when stamping the notify outcome fails", async () => {
    env = makeEnv(failing(d1, (sql) => /UPDATE contact_submissions/.test(sql)));
    const res = await handleContactSubmission(req(VALID), env);
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
  });
});

describe("contactRateIpPrefix", () => {
  it.each([
    ["203.0.113.20", "203.0.113.20"],
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::ffff:192.0.2.1", "0:0:0:0::/64"],
    ["unknown", "unknown"],
    ["1:2:3", "1:2:3"],
  ])("%s → %s", (ip, want) => {
    expect(contactRateIpPrefix(ip)).toBe(want);
  });
});

describe("contactIpRateKey", () => {
  it("holds no IP, and differs per window and per network", async () => {
    const t = Date.UTC(2026, 9, 6, 12, 30);
    const a = await contactIpRateKey({ JWT_SECRET }, IP, 3600, t);
    expect(a.key).not.toContain(IP);
    expect(a.key).toMatch(/^contact:ip:[0-9a-f]{32}:\d+$/);
    expect(a.expiresAtMs).toBe(Date.UTC(2026, 9, 6, 13, 0));
    const sameWindow = await contactIpRateKey({ JWT_SECRET }, IP, 3600, t + 60_000);
    expect(sameWindow.key).toBe(a.key);
    const nextWindow = await contactIpRateKey({ JWT_SECRET }, IP, 3600, t + 3_600_000);
    expect(nextWindow.key.split(":")[2]).not.toBe(a.key.split(":")[2]);
    const other = await contactIpRateKey({ JWT_SECRET }, "203.0.113.21", 3600, t);
    expect(other.key).not.toBe(a.key);
  });
});

describe.skipIf(!hasSqlite())("purgeExpiredContactRate", () => {
  it("deletes only expired rows, in bounded batches", async () => {
    const raw = openDerivedDb(["contact_rate"]);
    const ins = raw.prepare("INSERT INTO contact_rate (key, n, expires_at) VALUES (?, 1, ?)");
    for (let i = 0; i < 7; i++) ins.run(`old:${i}`, sqliteUtc(Date.now() - 3_600_000));
    ins.run("live", sqliteUtc(Date.now() + 3_600_000));
    const env = { DB: d1FromSqlite(raw) } as unknown as Env;

    const first = await purgeExpiredContactRate(env, { batchSize: 3, maxBatches: 2 });
    expect(first).toMatchObject({ deleted: 6, batches: 2, more_remaining: true, error: null });
    const second = await purgeExpiredContactRate(env, { batchSize: 3, maxBatches: 2 });
    expect(second).toMatchObject({ deleted: 1, more_remaining: false, error: null });
    const left = raw.prepare("SELECT key FROM contact_rate").all() as Array<{ key: string }>;
    expect(left.map((r) => r.key)).toEqual(["live"]);
  });

  it("never throws", async () => {
    const env = { DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as Env;
    const r = await purgeExpiredContactRate(env);
    expect(r.error).toBe("D1 down");
  });
});
