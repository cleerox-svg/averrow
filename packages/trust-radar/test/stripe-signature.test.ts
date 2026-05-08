import { describe, it, expect } from "vitest";
import { verifyStripeSignature } from "../src/lib/stripe-signature";

const SECRET = "whsec_test_secret_xxxxx";
const BODY = '{"id":"evt_123","type":"customer.subscription.created"}';

async function computeV1(timestamp: number, body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

describe("verifyStripeSignature", () => {
  it("accepts a valid signature within tolerance", async () => {
    const t = 1700000000;
    const v1 = await computeV1(t, BODY, SECRET);
    const header = `t=${t},v1=${v1}`;
    const r = await verifyStripeSignature(BODY, header, SECRET, { nowSeconds: t });
    expect(r.ok).toBe(true);
    expect(r.timestamp).toBe(t);
  });

  it("rejects when header is missing", async () => {
    const r = await verifyStripeSignature(BODY, null, SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_header");
  });

  it("rejects malformed header (no t=)", async () => {
    const r = await verifyStripeSignature(BODY, "v1=abcdef", SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("malformed_header");
  });

  it("rejects when no v1 signature present", async () => {
    const r = await verifyStripeSignature(BODY, "t=1700000000,v0=oldscheme", SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_v1_signatures");
  });

  it("rejects when timestamp is outside tolerance", async () => {
    const t = 1700000000;
    const v1 = await computeV1(t, BODY, SECRET);
    const header = `t=${t},v1=${v1}`;
    const r = await verifyStripeSignature(BODY, header, SECRET, {
      nowSeconds: t + 600,         // 10 min later
      toleranceSeconds: 300,       // 5 min tolerance
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timestamp_outside_tolerance");
  });

  it("rejects when v1 signature doesn't match the body", async () => {
    const t = 1700000000;
    const v1 = await computeV1(t, "different body", SECRET);
    const header = `t=${t},v1=${v1}`;
    const r = await verifyStripeSignature(BODY, header, SECRET, { nowSeconds: t });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("rejects when signed with the wrong secret", async () => {
    const t = 1700000000;
    const v1 = await computeV1(t, BODY, "wrong_secret");
    const header = `t=${t},v1=${v1}`;
    const r = await verifyStripeSignature(BODY, header, SECRET, { nowSeconds: t });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("accepts when one of multiple v1 entries matches (rotation case)", async () => {
    const t = 1700000000;
    const v1 = await computeV1(t, BODY, SECRET);
    const header = `t=${t},v1=deadbeef,v1=${v1}`;
    const r = await verifyStripeSignature(BODY, header, SECRET, { nowSeconds: t });
    expect(r.ok).toBe(true);
  });

  it("accepts a stale-but-tolerated past timestamp", async () => {
    const t = 1700000000;
    const v1 = await computeV1(t, BODY, SECRET);
    const header = `t=${t},v1=${v1}`;
    const r = await verifyStripeSignature(BODY, header, SECRET, {
      nowSeconds: t + 250,   // 250s after — still inside default 300s tolerance
    });
    expect(r.ok).toBe(true);
  });
});
