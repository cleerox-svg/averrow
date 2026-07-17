import { describe, it, expect } from "vitest";
import {
  handleAbuseMailboxEmail,
  extractInnerRfc822Message,
  extractAttachments,
  mergeUrlLists,
} from "../src/handlers/abuseMailboxEmail";
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
    // bind order (PR-BA, post-brand_id insertion):
    //   0  id
    //   1  org_id
    //   2  brand_id (PR-BA — matched monitored brand or NULL)
    //   3  forwarded_by_email
    //   4  forwarded_by_domain
    //   5  inbound_alias
    //   6  original_from
    //   7  original_subject
    //   8  original_body_snippet
    //   9  attachment_count
    //  10  url_count
    //  11  raw_body
    //  12  raw_headers (JSON)
    //  13  extracted_urls (JSON)
    //  14  attachment_names (JSON)
    //  15  raw_size_bytes
    //  16  throttled (0/1)
    //  17  throttle_reason
    //  18  auth_results (JSON)
    //  19  sender_ip
    //  20  correlated_threat_ids (JSON)
    expect(insert?.binds[1]).toBe(42);                                  // org_id
    expect(insert?.binds[2]).toBeNull();                                // brand_id (no monitored brands stub)
    expect(insert?.binds[3]).toBe("alice@acme.com");                    // forwarded_by_email
    expect(insert?.binds[4]).toBe("acme.com");                          // forwarded_by_domain
    expect(insert?.binds[5]).toBe("verify-acme@averrow.com");           // inbound_alias
    expect(insert?.binds[6]).toBe("notify@bad-acme.example");           // original_from
    expect(insert?.binds[7]).toContain("URGENT");                       // original_subject
    expect(insert?.binds[8]).toContain("Acme Bank");                    // body snippet
    expect(insert?.binds[10]).toBe(2);                                  // url_count
    expect(insert?.binds[16]).toBe(0);                                  // throttled (legit single message)
    expect(insert?.binds[17]).toBeNull();                               // throttle_reason
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
    expect(insert?.binds[10]).toBe(1);  // url_count
  });

  it("PR-AZ: extracts inner phishing email when forwarded as a message/rfc822 attachment", async () => {
    // Reproduction of the 2026-05-19 production failure: Gmail "Forward
    // as attachment" wraps the original phishing email in a
    // message/rfc822 MIME part. Pre-PR-AZ, every classifier signal
    // (From, Subject, URLs, body) came from the user's outer wrapper —
    // hiding the actual phishing content from Haiku entirely.
    const captured: CapturedRun[] = [];
    const env = makeEnv({ alias: { org_id: 42, alias: "phishing@averrow.com" } }, captured);
    const raw = [
      "Received: from mail.google.com",
      "From: Claude Leroux <claude@acme.com>",
      "To: phishing@averrow.com",
      "Subject: Suspicious email",
      "Content-Type: multipart/mixed; boundary=OUTER",
      "",
      "--OUTER",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "-- ",
      "Claude Leroux",
      "519-492-0972",
      "",
      "--OUTER",
      "Content-Type: message/rfc822",
      "Content-Disposition: attachment",
      "",
      "From: McAfee Notifications <notify@mcafee-secure-update.example>",
      "To: claude@acme.com",
      "Subject: Your McAfee payment failed and protection is off #67785425",
      "Date: Tue, 19 May 2026 10:00:00 -0700",
      "Authentication-Results: mx.google.com; spf=fail; dkim=none; dmarc=fail",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Your McAfee subscription has expired. Click https://mcafee-secure-update.example/renew to renew now.",
      "Backup link: https://payment-update.example/verify",
      "",
      "--OUTER--",
    ].join("\r\n");
    const msg = makeMessage("phishing@averrow.com", "claude@acme.com", raw);
    await handleAbuseMailboxEmail(msg, env);

    const insert = captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"));
    expect(insert).toBeDefined();
    // Bind indices below assume PR-BA layout (brand_id at bind[2]):
    // original_from comes from the INNER rfc822 message, not the outer wrapper
    expect(insert?.binds[6]).toBe("notify@mcafee-secure-update.example");
    // original_subject is the phishing subject, not the user's "Suspicious email"
    expect(insert?.binds[7]).toContain("McAfee payment failed");
    // body snippet shows the phishing content, not the user's signature
    expect(insert?.binds[8]).toContain("McAfee subscription");
    expect(insert?.binds[8]).not.toMatch(/^-- \nClaude Leroux/);
    // Both URLs from the inner body surface — pre-PR-AZ this would be 0
    expect(insert?.binds[10]).toBeGreaterThanOrEqual(2);
    // attachment_count surfaces the rfc822 part (was 0 pre-PR-AZ)
    expect(insert?.binds[9]).toBeGreaterThanOrEqual(1);

    // PR-AZ: stored raw_headers includes the inner phisher's headers
    // under `_forwarded_inner` so the forensic UI can show them.
    const rawHeadersJson = insert?.binds[12] as string;
    expect(rawHeadersJson).toContain("_forwarded_inner");
    expect(rawHeadersJson).toContain("mcafee-secure-update.example");

    // PR-AZ: auth_results column is parsed from the INNER message's
    // Authentication-Results header (spf=fail / dmarc=fail), NOT the
    // outer Gmail envelope's (which would pass). This is the signal
    // the Haiku prompt actually sees.
    const authResultsJson = insert?.binds[18] as string;
    expect(authResultsJson).toMatch(/"spf":"fail"/);
    expect(authResultsJson).toMatch(/"dmarc":"fail"/);
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
    expect(insert?.binds[9]).toBe(1);  // attachment_count
  });
});
