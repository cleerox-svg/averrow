/**
 * Ingest-side responder behaviour: backscatter guard, triage Workflow
 * dispatch, and the honest ack copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleAbuseMailboxEmail } from "../src/handlers/abuseMailboxEmail";
import { decideBackscatterGuard, ackExplainer } from "../src/lib/abuse-mailbox-responder";
import type { Env } from "../src/types";

interface CapturedRun { sql: string; binds: unknown[] }
interface ResendCall { to: string[]; subject: string; html: string; text: string }

const realFetch = globalThis.fetch;
let resendCalls: ResendCall[];
beforeEach(() => {
  resendCalls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.resend.com/emails") {
      resendCalls.push(JSON.parse(String(init?.body)) as ResendCall);
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function makeMessage(to: string, envelopeFrom: string, rawBody: string) {
  const enc = new TextEncoder().encode(rawBody);
  return {
    from: envelopeFrom, to,
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(enc); controller.close(); },
    }),
    rawSize: enc.length,
    setReject(_r: string) { /* no-op */ },
    async forward() { /* no-op */ },
  };
}

function makeEnv(captured: CapturedRun[], workflow?: { create: ReturnType<typeof vi.fn> }): Env {
  function chain(sql: string, binds: unknown[] = []) {
    return {
      bind: (...next: unknown[]) => chain(sql, [...binds, ...next]),
      run: async () => { captured.push({ sql, binds }); return { success: true, meta: { changes: 1 } }; },
      all: async () => ({ results: [] }),
      first: async () => (sql.includes("FROM org_abuse_aliases")
        ? { org_id: 42, alias: "verify-acme@averrow.com" }
        : null),
    };
  }
  return {
    DB: { prepare: (sql: string) => chain(sql) },
    RESEND_API_KEY: "re_test",
    ...(workflow ? { ABUSE_MAILBOX_TRIAGE: workflow } : {}),
  } as unknown as Env;
}

function raw(headerFrom: string, extraHeaders: string[] = []): string {
  return [
    ...extraHeaders,
    `From: Alice <${headerFrom}>`,
    "To: verify-acme@averrow.com",
    "Subject: Fwd: Account Verification",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "---------- Forwarded message ----------",
    "From: Notifications <notify@bad-acme.example>",
    "Subject: Account Verification Required",
    "",
    "Click https://bad-acme.example/verify now.",
  ].join("\r\n");
}

describe("decideBackscatterGuard", () => {
  it("allows matching registrable domains with no / passing DMARC", () => {
    expect(decideBackscatterGuard({ headerFrom: "a@acme.com", envelopeFrom: "bounce@mail.acme.com", outerDmarc: null }).send).toBe(true);
    expect(decideBackscatterGuard({ headerFrom: "a@acme.com", envelopeFrom: "a@acme.com", outerDmarc: "pass" }).send).toBe(true);
  });
  it("refuses a header/envelope domain mismatch", () => {
    expect(decideBackscatterGuard({ headerFrom: "victim@bank.com", envelopeFrom: "x@spammer.example", outerDmarc: null }))
      .toEqual({ send: false, reason: "backscatter:from_envelope_mismatch" });
  });
  it("refuses when outer DMARC is present and not pass", () => {
    expect(decideBackscatterGuard({ headerFrom: "a@acme.com", envelopeFrom: "a@acme.com", outerDmarc: "fail" }).reason)
      .toBe("backscatter:outer_dmarc_not_pass");
  });
  it("refuses when either sender is missing", () => {
    expect(decideBackscatterGuard({ headerFrom: null, envelopeFrom: "a@acme.com", outerDmarc: null }).send).toBe(false);
  });
});

describe("handleAbuseMailboxEmail — responder guards + workflow dispatch", () => {
  it("matching header/envelope: acks and dispatches the triage Workflow once with a per-message id", async () => {
    const captured: CapturedRun[] = [];
    const create = vi.fn(async () => ({ id: "x" }));
    const env = makeEnv(captured, { create });
    await handleAbuseMailboxEmail(makeMessage("verify-acme@averrow.com", "alice@acme.com", raw("alice@acme.com")), env);

    expect(resendCalls).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as { id: string; params: { messageId: string } };
    const insert = captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"))!;
    expect(arg.params.messageId).toBe(insert.binds[0]);
    expect(arg.id).toBe(`abuse-${String(insert.binds[0])}`);
  });

  it("mismatched header-From vs envelope: row stored, no ack, no Workflow, reason stamped", async () => {
    const captured: CapturedRun[] = [];
    const create = vi.fn(async () => ({ id: "x" }));
    const env = makeEnv(captured, { create });
    await handleAbuseMailboxEmail(
      makeMessage("verify-acme@averrow.com", "bulk@spammer.example", raw("victim@bank.com")), env);

    expect(captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"))).toBeDefined();
    expect(resendCalls).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    const stamp = captured.find((c) => c.sql.includes("responder_suppressed_reason"));
    expect(stamp?.binds[0]).toBe("backscatter:from_envelope_mismatch");
  });

  it("outer DMARC fail: no emails", async () => {
    const captured: CapturedRun[] = [];
    const create = vi.fn(async () => ({ id: "x" }));
    const env = makeEnv(captured, { create });
    await handleAbuseMailboxEmail(makeMessage("verify-acme@averrow.com", "alice@acme.com",
      raw("alice@acme.com", ["Authentication-Results: mx.cloudflare.net; spf=pass; dkim=fail; dmarc=fail"])), env);
    expect(resendCalls).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("ingest still succeeds when the Workflow dispatch throws", async () => {
    const captured: CapturedRun[] = [];
    const create = vi.fn(async () => { throw new Error("WorkflowInternalError"); });
    const env = makeEnv(captured, { create });
    await expect(handleAbuseMailboxEmail(
      makeMessage("verify-acme@averrow.com", "alice@acme.com", raw("alice@acme.com")), env)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"))).toBeDefined();
    expect(captured.find((c) => c.sql.includes("ack_sent_at"))).toBeDefined();
  });

  it("ack copy is the honest rules-based explainer (no AI / 'within the hour' claim)", async () => {
    const env = makeEnv([]);
    await handleAbuseMailboxEmail(makeMessage("verify-acme@averrow.com", "alice@acme.com", raw("alice@acme.com")), env);
    const { html, text } = resendCalls[0]!;
    const expected = ackExplainer("Averrow");
    expect(expected).toBe(
      "The Averrow platform extracts indicators (links, sender headers, sending IP, attachments) and checks them " +
      "against our threat-intelligence feeds. If they match known malicious activity, you'll receive a determination " +
      "email shortly. Otherwise your report goes to an analyst for review and you'll get an email confirming that.",
    );
    expect(text).toContain(expected);
    expect(html).toContain("checks them against our threat-intelligence feeds");
    for (const body of [html, text]) {
      expect(body).not.toMatch(/via AI/);
      expect(body).not.toMatch(/within the hour/);
    }
  });
});
