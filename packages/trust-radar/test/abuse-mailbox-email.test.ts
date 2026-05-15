import { describe, it, expect } from "vitest";
import { handleAbuseMailboxEmail } from "../src/handlers/abuseMailboxEmail";
import type { Env } from "../src/types";

interface CapturedRun { sql: string; binds: unknown[] }

interface Stub {
  alias?: { org_id: number; alias: string } | null;
}

function makeMessage(to: string, from: string, rawBody: string): {
  from: string; to: string; headers: Headers;
  raw: ReadableStream<Uint8Array>; rawSize: number;
  setReject(r: string): void; forward(to: string, headers?: Headers): Promise<void>;
} {
  const enc = new TextEncoder().encode(rawBody);
  return {
    from, to,
    headers: new Headers(),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(enc);
        controller.close();
      },
    }),
    rawSize: enc.length,
    setReject(_r) { /* no-op */ },
    async forward() { /* no-op */ },
  };
}

function makeEnv(stub: Stub, captured: CapturedRun[]): Env {
  function makeChain(sql: string, binds: unknown[] = []) {
    return {
      bind: (...next: unknown[]) => makeChain(sql, [...binds, ...next]),
      run:   async () => { captured.push({ sql, binds }); return { success: true }; },
      all:   async () => ({ results: [] }),
      first: async () => {
        if (sql.includes("FROM org_abuse_aliases")) {
          return stub.alias ?? null;
        }
        return null;
      },
    };
  }
  return { DB: { prepare: (sql: string) => makeChain(sql) } } as unknown as Env;
}

const FORWARDED_RAW = [
  "Received: from mail.acme.com",
  "From: Alice Employee <alice@acme.com>",
  "To: verify-acme@averrow.com",
  "Subject: Fwd: URGENT — Account Verification",
  "Date: Wed, 7 May 2026 14:32:00 -0500",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Hi team, see below. This looks suspicious.",
  "",
  "---------- Forwarded message ----------",
  "From: Notifications <notify@bad-acme.example>",
  "Date: Wed, 7 May 2026 14:30:00 -0500",
  "Subject: URGENT — Account Verification Required",
  "To: alice@acme.com",
  "",
  "Your Acme Bank account will be locked. Click https://bad-acme.example/verify to verify.",
  "Also check https://phisher.example/login for backup.",
].join("\r\n");

describe("handleAbuseMailboxEmail", () => {
  it("drops the message when alias isn't registered", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({ alias: null }, captured);
    const msg = makeMessage("verify-unknown@averrow.com", "alice@acme.com", FORWARDED_RAW);
    await handleAbuseMailboxEmail(msg, env);
    // No INSERT happens
    const insert = captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"));
    expect(insert).toBeUndefined();
  });

  it("inserts an abuse_inbox_messages row when alias resolves", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({ alias: { org_id: 42, alias: "verify-acme@averrow.com" } }, captured);
    const msg = makeMessage("verify-acme@averrow.com", "alice@acme.com", FORWARDED_RAW);
    await handleAbuseMailboxEmail(msg, env);

    const insert = captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"));
    expect(insert).toBeDefined();
    // bind order (PR-AT, post-forwarded_by_domain insertion):
    //   0  id
    //   1  org_id
    //   2  forwarded_by_email
    //   3  forwarded_by_domain
    //   4  inbound_alias
    //   5  original_from
    //   6  original_subject
    //   7  original_body_snippet
    //   8  attachment_count
    //   9  url_count
    //  10  raw_body
    //  11  raw_headers (JSON)
    //  12  extracted_urls (JSON)
    //  13  attachment_names (JSON)
    //  14  raw_size_bytes
    //  15  throttled (0/1)
    //  16  throttle_reason
    expect(insert?.binds[1]).toBe(42);                                  // org_id
    expect(insert?.binds[2]).toBe("alice@acme.com");                    // forwarded_by_email
    expect(insert?.binds[3]).toBe("acme.com");                          // forwarded_by_domain
    expect(insert?.binds[4]).toBe("verify-acme@averrow.com");           // inbound_alias
    expect(insert?.binds[5]).toBe("notify@bad-acme.example");           // original_from
    expect(insert?.binds[6]).toContain("URGENT");                       // original_subject
    expect(insert?.binds[7]).toContain("Acme Bank");                    // body snippet
    expect(insert?.binds[9]).toBe(2);                                   // url_count
    expect(insert?.binds[15]).toBe(0);                                  // throttled (legit single message)
    expect(insert?.binds[16]).toBeNull();                               // throttle_reason
  });

  it("treats the alias case-insensitively", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({ alias: { org_id: 7, alias: "verify-acme@averrow.com" } }, captured);
    const msg = makeMessage("Verify-Acme@Averrow.com", "user@example.com", FORWARDED_RAW);
    await handleAbuseMailboxEmail(msg, env);
    expect(captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"))).toBeDefined();
  });

  it("handles raw email with no recognizable forwarded marker", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({ alias: { org_id: 42, alias: "verify-acme@averrow.com" } }, captured);
    const raw = [
      "From: alice@acme.com",
      "To: verify-acme@averrow.com",
      "Subject: this came in",
      "",
      "Just plain forwarded text with a link https://suspicious.example/x",
    ].join("\r\n");
    const msg = makeMessage("verify-acme@averrow.com", "alice@acme.com", raw);
    await handleAbuseMailboxEmail(msg, env);
    const insert = captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"));
    expect(insert).toBeDefined();
    // original_from / subject may be null; body snippet still set
    expect(insert?.binds[9]).toBe(1);  // url_count
  });

  it("counts attachments via Content-Disposition header", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({ alias: { org_id: 42, alias: "verify-acme@averrow.com" } }, captured);
    const raw = [
      "From: alice@acme.com",
      "To: verify-acme@averrow.com",
      "Subject: Fwd: with attachment",
      "Content-Type: multipart/mixed; boundary=BOUND",
      "",
      "--BOUND",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--BOUND",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=phish.pdf",
      "",
      "...binary...",
      "--BOUND--",
    ].join("\r\n");
    const msg = makeMessage("verify-acme@averrow.com", "alice@acme.com", raw);
    await handleAbuseMailboxEmail(msg, env);
    const insert = captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"));
    expect(insert?.binds[8]).toBe(1);  // attachment_count
  });
});
