// Stripe webhook signature verification.
//
// Stripe sends a header like:
//
//   Stripe-Signature: t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
//
// where:
//   t  = unix timestamp (seconds) when the signature was computed
//   v1 = HMAC-SHA256 hex of `${t}.${rawBody}` keyed by our webhook secret
//
// Multiple v1 entries can appear (Stripe rotates secrets); any match
// validates. The timestamp tolerance defends against replay; default
// 5 minutes matches the official Stripe libraries.
//
// All crypto via the Web Crypto API so this works in Cloudflare
// Workers without polyfills.
//
// v3 Phase D Stripe sprint 4.

const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyResult {
  ok:       boolean;
  reason?:  "missing_header" | "malformed_header" | "no_v1_signatures"
          | "timestamp_outside_tolerance" | "signature_mismatch";
  timestamp?: number;
}

interface ParsedSignature {
  timestamp: number;
  v1:        string[];
}

function parseStripeSignatureHeader(header: string): ParsedSignature | null {
  const parts = header.split(",").map((p) => p.trim()).filter(Boolean);
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const key = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) timestamp = n;
    } else if (key === "v1") {
      v1.push(value);
    }
  }
  if (timestamp === null) return null;
  return { timestamp, v1 };
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Constant-time string equality. Avoids a timing oracle on the
 * v1 signature comparison. Both args must be the same length;
 * different lengths return false immediately (length is not
 * itself secret information).
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export interface VerifyOptions {
  /** Override now() in tests; seconds. */
  nowSeconds?:        number;
  /** Override the 5-minute default tolerance window. */
  toleranceSeconds?:  number;
}

export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  if (!signatureHeader) return { ok: false, reason: "missing_header" };

  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  if (parsed.v1.length === 0) return { ok: false, reason: "no_v1_signatures", timestamp: parsed.timestamp };

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "timestamp_outside_tolerance", timestamp: parsed.timestamp };
  }

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${rawBody}`);
  for (const candidate of parsed.v1) {
    if (timingSafeEqualHex(expected, candidate)) {
      return { ok: true, timestamp: parsed.timestamp };
    }
  }
  return { ok: false, reason: "signature_mismatch", timestamp: parsed.timestamp };
}
