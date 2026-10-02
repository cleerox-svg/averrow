/**
 * Ingest-side responder behaviour: positive-authentication backscatter
 * guard, strict single-recipient parsing, triage Workflow dispatch, and
 * the honest ack copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleAbuseMailboxEmail, extractHeaderInstances } from "../src/handlers/abuseMailboxEmail";
import {
  decideBackscatterGuard, parseSingleRecipient, parseAuthResultsHeader, ackExplainer,
} from "../src/lib/abuse-mailbox-responder";
import type { Env } from "../src/types";

interface CapturedRun { sql: string; binds: unknown[] }
interface ResendCall { to: string[]; subject: string; html: string; text: string }

const realFetch = globalThis.fetch;
let resendCalls: ResendCall[];
let resendHeaders: Array<Record<string, string>>;
beforeEach(() => {
  resendCalls = [];
  resendHeaders = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.resend.com/emails") {
      resendCalls.push(JSON.parse(String(init?.body)) as ResendCall);
      resendHeaders.push((init?.headers ?? {}) as Record<string, string>);
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

const CF_PASS = "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=acme.com; spf=pass smtp.mailfrom=acme.com; dmarc=pass header.from=acme.com policy.dmarc=reject";

/** Outer forward. `authHeaders` default: our MTA's dmarc=pass for acme.com. */
function raw(fromHeader: string, authHeaders: string[] = [CF_PASS]): string {
  return [
    ...authHeaders,
    `From: ${fromHeader}`,
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

function insertOf(captured: CapturedRun[]): CapturedRun {
  const insert = captured.find((c) => c.sql.includes("INSERT INTO abuse_inbox_messages"));
  if (!insert) throw new Error("no INSERT captured");
  return insert;
}
/** responder_suppressed_reason is the second-to-last INSERT bind. */
function suppressedReasonOf(captured: CapturedRun[]): unknown {
  const b = insertOf(captured).binds;
  return b[b.length - 2];
}

// ─── Pure guard ──────────────────────────────────────────────────

describe("parseSingleRecipient", () => {
  it("accepts one mailbox in the usual forms", () => {
    expect(parseSingleRecipient("Alice <Alice@Acme.com>")).toBe("alice@acme.com");
    expect(parseSingleRecipient("alice@acme.com")).toBe("alice@acme.com");
    expect(parseSingleRecipient(`"Doe, John" <john.doe@acme.co.uk>`)).toBe("john.doe@acme.co.uk");
  });
  it("rejects address lists, merged headers, multiple @ and junk in angle brackets", () => {
    for (const v of [
      "a@acme.com, b@evil.example",
      "Alice <a@acme.com>, Bob <b@evil.example>",
      "a@acme.com; b@evil.example",
      "victim@bank.com <attacker@evil.example>",
      "Alice <a@acme.com> <b@evil.example>",
      "Alice <a@b@acme.com>",
      "Alice <not an address>",
      "Alice <a@acme.com",
      "a@acme",
      "",
    ]) {
      expect(parseSingleRecipient(v)).toBeNull();
    }
  });
});

describe("parseAuthResultsHeader", () => {
  it("reads authserv-id, dmarc result and header.from, ignoring comments", () => {
    expect(parseAuthResultsHeader("mx.cloudflare.net; spf=pass (sender ok; really); dmarc=pass header.from=acme.com"))
      .toEqual({ authservId: "mx.cloudflare.net", dmarc: "pass", dmarcHeaderFrom: "acme.com" });
  });
  it("strips the ARC instance tag", () => {
    expect(parseAuthResultsHeader("i=1; mx.cloudflare.net; dmarc=none header.from=acme.com")?.authservId)
      .toBe("mx.cloudflare.net");
  });
});

describe("decideBackscatterGuard — positive authentication", () => {
  const base = {
    headerFrom: "Alice <alice@acme.com>",
    envelopeFrom: "bounce@mail.acme.com",
    arcAuthResultsHeaders: [] as string[],
  };
  const cf = (dmarc: string, from = "acme.com") => `mx.cloudflare.net; spf=pass; dmarc=${dmarc} header.from=${from}`;

  it("CF dmarc=pass for the From domain + matching envelope → send, normalized recipient", () => {
    expect(decideBackscatterGuard({ ...base, authResultsHeaders: [cf("pass")] }))
      .toEqual({ send: true, reason: "ok", recipient: "alice@acme.com" });
  });

  it("forged Authentication-Results with a non-CF authserv-id → no_trusted_auth", () => {
    const d = decideBackscatterGuard({
      ...base, authResultsHeaders: ["mx.google.com; dmarc=pass header.from=acme.com"],
    });
    expect(d).toMatchObject({ send: false, reason: "backscatter:no_trusted_auth" });
  });

  it("a forged pass ABOVE our header is ignored — our topmost CF header decides", () => {
    const d = decideBackscatterGuard({
      ...base,
      authResultsHeaders: ["evil.example; dmarc=pass header.from=acme.com", cf("fail")],
    });
    expect(d.reason).toBe("backscatter:dmarc_not_pass");
  });

  it("only the TOPMOST CF header counts (a lower forged CF-labelled pass is ignored)", () => {
    const d = decideBackscatterGuard({ ...base, authResultsHeaders: [cf("fail"), cf("pass")] });
    expect(d.reason).toBe("backscatter:dmarc_not_pass");
  });

  it("dmarc=none → suppressed", () => {
    expect(decideBackscatterGuard({ ...base, authResultsHeaders: [cf("none")] }).reason)
      .toBe("backscatter:dmarc_not_pass");
  });

  it("missing CF header → no_trusted_auth", () => {
    expect(decideBackscatterGuard({ ...base, authResultsHeaders: [] }).reason).toBe("backscatter:no_trusted_auth");
  });

  it("dmarc=pass for a DIFFERENT domain than the header-From → domain_mismatch", () => {
    expect(decideBackscatterGuard({ ...base, authResultsHeaders: [cf("pass", "other.example")] }).reason)
      .toBe("backscatter:domain_mismatch");
  });

  it("header-From vs envelope registrable-domain mismatch → domain_mismatch", () => {
    const d = decideBackscatterGuard({
      ...base, envelopeFrom: "x@spammer.example", authResultsHeaders: [cf("pass")],
    });
    expect(d.reason).toBe("backscatter:domain_mismatch");
  });

  it("falls back to the CF ARC-Authentication-Results header", () => {
    const d = decideBackscatterGuard({
      ...base, authResultsHeaders: [],
      arcAuthResultsHeaders: ["i=1; mx.cloudflare.net; dmarc=pass header.from=acme.com"],
    });
    expect(d.send).toBe(true);
  });

  it("comma / multi-address From → invalid_recipient", () => {
    for (const headerFrom of ["alice@acme.com, bob@acme.com", "victim@bank.com <alice@acme.com>"]) {
      expect(decideBackscatterGuard({ ...base, headerFrom, authResultsHeaders: [cf("pass")] }))
        .toMatchObject({ send: false, reason: "backscatter:invalid_recipient", recipient: null });
    }
  });
});

describe("extractHeaderInstances", () => {
  it("returns each instance in order, unfolded, from the outer header block only", () => {
    const text = [
      "Authentication-Results: mx.cloudflare.net;",
      "\tdmarc=pass header.from=acme.com",
      "Authentication-Results: evil.example; dmarc=pass",
      "Subject: x",
      "",
      "Authentication-Results: body.example; dmarc=pass",
    ].join("\r\n");
    expect(extractHeaderInstances(text, "authentication-results")).toEqual([
      "mx.cloudflare.net; dmarc=pass header.from=acme.com",
      "evil.example; dmarc=pass",
    ]);
  });
});

// ─── Handler ─────────────────────────────────────────────────────

describe("handleAbuseMailboxEmail — responder guards + workflow dispatch", () => {
  it("CF dmarc=pass: acks the strictly-parsed recipient and dispatches the Workflow once", async () => {
    const captured: CapturedRun[] = [];
    const create = vi.fn(async () => ({ id: "x" }));
    const env = makeEnv(captured, { create });
    await handleAbuseMailboxEmail(
      makeMessage("verify-acme@averrow.com", "alice@acme.com", raw("Alice <Alice@Acme.com>")), env);

    expect(resendCalls).toHaveLength(1);
    const insert = insertOf(captured);
    // One normalized value: stored forwarded_by_email === Resend `to`.
    expect(insert.binds[3]).toBe("alice@acme.com");
    expect(resendCalls[0]!.to).toEqual(["alice@acme.com"]);
    expect(suppressedReasonOf(captured)).toBeNull();
    // Registrable-domain throttle key is written by the INSERT too.
    expect(insert.binds[insert.binds.length - 1]).toBe("acme.com");
    expect(resendHeaders[0]!["Idempotency-Key"]).toBe(`abuse-ack/${String(insert.binds[0])}`);

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as { id: string; params: { messageId: string } };
    expect(arg.params.messageId).toBe(insert.binds[0]);
    expect(arg.id).toBe(`abuse-${String(insert.binds[0])}`);
  });

  it("forged non-CF Authentication-Results: no ack, reason written BY THE INSERT, Workflow still dispatched", async () => {
    const captured: CapturedRun[] = [];
    const create = vi.fn(async () => ({ id: "x" }));
    const env = makeEnv(captured, { create });
    await handleAbuseMailboxEmail(makeMessage("verify-acme@averrow.com", "alice@acme.com",
      raw("alice@acme.com", ["Authentication-Results: mx.attacker.example; dmarc=pass header.from=acme.com"])), env);

    expect(resendCalls).toHaveLength(0);
    expect(suppressedReasonOf(captured)).toBe("backscatter:no_trusted_auth");
    // No separate best-effort stamp UPDATE any more.
    expect(captured.some((c) => c.sql.startsWith("UPDATE") && c.sql.includes("responder_suppressed_reason"))).toBe(false);
    // Verdict still lands within minutes; the send step is a no-op for it.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("CF dmarc=none: suppressed", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv(captured);
    await handleAbuseMailboxEmail(makeMessage("verify-acme@averrow.com", "alice@acme.com",
      raw("alice@acme.com", ["Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=none header.from=acme.com"])), env);
    expect(resendCalls).toHaveLength(0);
    expect(suppressedReasonOf(captured)).toBe("backscatter:dmarc_not_pass");
  });

  it("header-From vs envelope mismatch: suppressed", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv(captured);
    await handleAbuseMailboxEmail(
      makeMessage("verify-acme@averrow.com", "bulk@spammer.example", raw("alice@acme.com")), env);
    expect(resendCalls).toHaveLength(0);
    expect(suppressedReasonOf(captured)).toBe("backscatter:domain_mismatch");
  });

  it("comma / multi-address From: rejected (invalid_recipient), no email", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv(captured);
    await handleAbuseMailboxEmail(makeMessage("verify-acme@averrow.com", "alice@acme.com",
      raw("alice@acme.com, victim@bank.example")), env);
    expect(resendCalls).toHaveLength(0);
    expect(suppressedReasonOf(captured)).toBe("backscatter:invalid_recipient");
  });

  it("ingest still succeeds when the Workflow dispatch throws", async () => {
    const captured: CapturedRun[] = [];
    const create = vi.fn(async () => { throw new Error("WorkflowInternalError"); });
    const env = makeEnv(captured, { create });
    await expect(handleAbuseMailboxEmail(
      makeMessage("verify-acme@averrow.com", "alice@acme.com", raw("alice@acme.com")), env)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(insertOf(captured)).toBeDefined();
    expect(captured.find((c) => c.sql.includes("ack_sent_at"))).toBeDefined();
  });

  it("ack copy is the honest rules-based explainer and the echoed subject is defanged", async () => {
    const env = makeEnv([]);
    const body = raw("alice@acme.com").replace(
      "Subject: Account Verification Required",
      "Subject: Verify at https://bad-acme.example/login now",
    );
    await handleAbuseMailboxEmail(makeMessage("verify-acme@averrow.com", "alice@acme.com", body), env);
    const { html, text } = resendCalls[0]!;
    const expected = ackExplainer("Averrow");
    expect(expected).toBe(
      "The Averrow platform extracts indicators (links, sender headers, sending IP, attachments) and checks them " +
      "against our threat-intelligence feeds. If they match known malicious activity, you'll receive a determination " +
      "email shortly. Otherwise your report goes to an analyst for review and you'll get an email confirming that.",
    );
    expect(text).toContain(expected);
    expect(html).toContain("checks them against our threat-intelligence feeds");
    for (const b of [html, text]) {
      expect(b).not.toMatch(/via AI/);
      expect(b).not.toMatch(/within the hour/);
      expect(b).not.toContain("bad-acme.example");
      expect(b).not.toContain("https://bad-acme");
    }
    expect(text).toContain("Verify at bad-acme[.]example/login now");
  });
});
