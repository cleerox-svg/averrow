// AES-GCM wrap/unwrap for org_integrations.config_encrypted.
//
// WS-B #4 fix. The column was named `config_encrypted` since migration
// 0XXX but was being written as plaintext JSON (Splunk HEC tokens,
// Jira API tokens, ServiceNow basic-auth creds, Elastic API keys).
// The TODO at handlers/organizations.ts:1359 lived there for months.
//
// On-disk format (versioned so we can rotate later):
//
//   v1:<base64url(96-bit nonce)>:<base64url(ciphertext+tag)>
//
// Strings that don't start with `v1:` are treated as legacy plaintext.
// That covers two cases:
//   1. Rows written before this helper shipped — they keep working
//      and get re-encrypted on the next write (or via the admin
//      bulk-rewrap endpoint).
//   2. Rows where INTEGRATION_CONFIG_KEY was missing at write time —
//      we refuse to fall back silently and the write throws, so
//      operators can't accidentally regress.
//
// Why per-record nonce (not derived): nonce reuse with AES-GCM
// catastrophically breaks confidentiality. A random 96-bit nonce per
// row makes collisions astronomically unlikely at our row counts.
//
// Why base64url (not raw base64): the column is opaque text and we
// want round-trippable strings without padding/`/`/`+` weirdness.

import type { Env } from "../types";

const VERSION_PREFIX = "v1:";

/** Returns true when `value` is a v1-encrypted ciphertext string. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(VERSION_PREFIX);
}

async function importKey(env: Env): Promise<CryptoKey> {
  const keyB64 = env.INTEGRATION_CONFIG_KEY;
  if (!keyB64) {
    throw new Error(
      "INTEGRATION_CONFIG_KEY worker secret is not set — refusing to handle integration config. " +
      "Set it with `wrangler secret put INTEGRATION_CONFIG_KEY` (32 random bytes, base64-encoded).",
    );
  }
  const raw = b64decode(keyB64);
  if (raw.length !== 32) {
    throw new Error(
      `INTEGRATION_CONFIG_KEY must decode to exactly 32 bytes (AES-256). Got ${raw.length}.`,
    );
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt a config object for storage in org_integrations.config_encrypted.
 * Pass `null` or `undefined` to clear the column.
 */
export async function encryptConfig(
  env: Env,
  config: Record<string, unknown> | null | undefined,
): Promise<string | null> {
  if (config == null) return null;
  const key = await importKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(config));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  return `${VERSION_PREFIX}${b64urlEncode(nonce)}:${b64urlEncode(ciphertext)}`;
}

/**
 * Decrypt a v1-prefixed ciphertext. Returns the parsed JSON object.
 *
 * If the string isn't v1-prefixed it's treated as legacy plaintext —
 * `JSON.parse(value)` is returned so callers don't have to handle the
 * transition separately. The bulk-rewrap admin endpoint cleans these
 * rows up over time.
 */
export async function decryptConfig(
  env: Env,
  value: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (value == null || value === "") return null;
  if (!isEncrypted(value)) {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const parts = value.slice(VERSION_PREFIX.length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("integration-secret: malformed v1 ciphertext");
  }
  const key = await importKey(env);
  const nonce = b64urlDecode(parts[0]);
  const ciphertext = b64urlDecode(parts[1]);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      ciphertext as BufferSource,
    ),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

// ── base64url helpers ─────────────────────────────────────────────
// URL-safe, no padding. Worker runtime has atob/btoa but no
// Buffer; these tiny helpers cover everything we need.

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64decode(s: string): Uint8Array {
  // Accepts both standard and url-safe base64.
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
