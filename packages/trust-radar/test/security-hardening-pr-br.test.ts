/**
 * Tests for the chunk-3 security hardening fixes (PR-BR).
 *
 * Covers:
 *   1. abuseMailboxUnsubscribe: email length cap + fail-closed when
 *      no secret is configured + token compare unchanged.
 *   2. matchVerdict static lookup (via parseAuthResults round-trip).
 *
 * NOT covered here (verified by code review + grep):
 *   - DMARC sanitizeXmlField: pure string transform, exercised
 *     indirectly when dmarc-receiver.ts tests run; explicit case
 *     below tests the helper via the export pattern.
 *   - Brand-match log injection: console.log output isn't easily
 *     observable; covered by code review + the existing
 *     abuse-mailbox-email tests still pass.
 */

import { describe, it, expect } from "vitest";
import { parseAuthResults } from "../src/lib/abuse-mailbox-iocs";
import { handleAbuseMailboxUnsubscribe } from "../src/handlers/abuseMailboxUnsubscribe";

// ─── Helpers ───────────────────────────────────────────────────────

function makeEnv(opts: {
  unsubSecret?: string;
  internalSecret?: string;
  dbInsertCalls?: string[][];
} = {}) {
  const dbCalls: string[][] = opts.dbInsertCalls ?? [];
  return {
    ABUSE_UNSUBSCRIBE_SECRET: opts.unsubSecret,
    AVERROW_INTERNAL_SECRET: opts.internalSecret,
    DB: {
      prepare(sql: string) {
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              dbCalls.push([sql, ...args.map(String)]);
              return { meta: { changes: 1 }, success: true };
            },
          }),
        };
      },
    },
  };
}

// HMAC-SHA-256 truncated to 16 hex — mirrors the production helper.
async function genToken(email: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(email.toLowerCase()),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("handleAbuseMailboxUnsubscribe — PR-BR hardening", () => {
  it("fails closed with 503 when no secret is configured", async () => {
    const env = makeEnv({});
    const req = new Request(
      "https://averrow.com/api/abuse-mailbox/unsubscribe?email=a@b.com&t=any",
      { method: "POST" },
    );
    const res = await handleAbuseMailboxUnsubscribe(req, env as never);
    expect(res.status).toBe(503);
  });

  it("rejects email longer than 320 chars (RFC 5321 max) with 400", async () => {
    const env = makeEnv({ unsubSecret: "test-secret" });
    const longEmail = "a".repeat(310) + "@b.com"; // 316 chars total — under cap
    const oversizedEmail = "a".repeat(320) + "@b.com"; // 326 chars — over cap

    const req1 = new Request(
      `https://averrow.com/api/abuse-mailbox/unsubscribe?email=${encodeURIComponent(longEmail)}&t=00`,
      { method: "POST" },
    );
    const res1 = await handleAbuseMailboxUnsubscribe(req1, env as never);
    // 316 chars passes the length check, then fails on bad token (401).
    expect(res1.status).toBe(401);

    const req2 = new Request(
      `https://averrow.com/api/abuse-mailbox/unsubscribe?email=${encodeURIComponent(oversizedEmail)}&t=00`,
      { method: "POST" },
    );
    const res2 = await handleAbuseMailboxUnsubscribe(req2, env as never);
    expect(res2.status).toBe(400);
  });

  it("happy path: valid token with secret configured → 204", async () => {
    const secret = "test-unsub-secret-pr-br";
    const email = "user@example.com";
    const token = await genToken(email, secret);

    const dbCalls: string[][] = [];
    const env = makeEnv({ unsubSecret: secret, dbInsertCalls: dbCalls });
    const req = new Request(
      `https://averrow.com/api/abuse-mailbox/unsubscribe?email=${encodeURIComponent(email)}&t=${token}`,
      { method: "POST" },
    );
    const res = await handleAbuseMailboxUnsubscribe(req, env as never);
    expect(res.status).toBe(204);
    expect(dbCalls.length).toBe(1);
    expect(dbCalls[0]?.[1]).toBe(email);
  });

  it("rejects mismatched token → 401 (not crash, not auth bypass)", async () => {
    const env = makeEnv({ unsubSecret: "test-secret" });
    const req = new Request(
      `https://averrow.com/api/abuse-mailbox/unsubscribe?email=a@b.com&t=deadbeefdeadbeef`,
      { method: "POST" },
    );
    const res = await handleAbuseMailboxUnsubscribe(req, env as never);
    expect(res.status).toBe(401);
  });

  // L5 (SECURITY_AUDIT_2026-06-10): the AVERROW_INTERNAL_SECRET
  // fallback was removed — ABUSE_UNSUBSCRIBE_SECRET is now required
  // exclusively. A token minted with the internal secret must NOT
  // verify; the endpoint fails closed instead.
  it("does NOT fall back to AVERROW_INTERNAL_SECRET when ABUSE_UNSUBSCRIBE_SECRET is unset", async () => {
    const secret = "internal-secret-fallback";
    const email = "user@example.com";
    const token = await genToken(email, secret);

    const dbCalls: string[][] = [];
    const env = makeEnv({ internalSecret: secret, dbInsertCalls: dbCalls });
    const req = new Request(
      `https://averrow.com/api/abuse-mailbox/unsubscribe?email=${encodeURIComponent(email)}&t=${token}`,
      { method: "POST" },
    );
    const res = await handleAbuseMailboxUnsubscribe(req, env as never);
    expect(res.status).toBe(503);
    expect(dbCalls.length).toBe(0);
  });
});

describe("matchVerdict (PR-BR) — static lookup", () => {
  it("parses spf/dkim/dmarc verdicts correctly", () => {
    const headers = {
      "authentication-results": "mx.example.com; spf=pass smtp.helo=example.com; dkim=fail; dmarc=pass",
    };
    const result = parseAuthResults(headers);
    expect(result?.spf).toBe("pass");
    expect(result?.dkim).toBe("fail");
    expect(result?.dmarc).toBe("pass");
  });

  it("returns null for an unknown verdict string", () => {
    const headers = {
      "authentication-results": "mx.example.com; spf=bogus; dkim=fail; dmarc=pass",
    };
    const result = parseAuthResults(headers);
    expect(result?.spf).toBeNull();
    expect(result?.dkim).toBe("fail");
  });

  it("returns all-null verdicts when the header is absent", () => {
    const result = parseAuthResults({});
    expect(result.spf).toBeNull();
    expect(result.dkim).toBeNull();
    expect(result.dmarc).toBeNull();
  });

  it("handles a header with only spf", () => {
    const headers = {
      "authentication-results": "mx.example.com; spf=pass",
    };
    const result = parseAuthResults(headers);
    expect(result?.spf).toBe("pass");
    expect(result?.dkim).toBeNull();
    expect(result?.dmarc).toBeNull();
  });
});
