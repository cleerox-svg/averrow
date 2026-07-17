/**
 * Web Push payload encryption — RFC 8291 (`aes128gcm` content encoding).
 *
 * Encrypts a plaintext payload to a subscriber's push endpoint using:
 *   1. ECDH on P-256 between an ephemeral keypair and the subscriber's
 *      `p256dh` public key.
 *   2. HKDF (SHA-256) keyed with the subscriber's `auth` secret to derive
 *      a content-encryption key + nonce.
 *   3. AES-128-GCM encryption with a single chunk + 0x02 padding delimiter.
 *
 * Output framing (sent as the request body, with header
 *   `Content-Encoding: aes128gcm`):
 *
 *     | salt (16) | rs (4 BE) | idlen (1) | keyid (65 — uncompressed pub) | ciphertext |
 *
 * Web Crypto only. Tested against fcm.googleapis.com and web.push.apple.com.
 */

// ─── Base64url helpers ─────────────────────────────────────────────────

export function base64UrlDecode(input: string): Uint8Array {
  // Pad and replace URL-safe chars with standard b64.
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(input.length / 4) * 4,
    '=',
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── HKDF (SHA-256) ────────────────────────────────────────────────────

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  // Web Crypto's HKDF expects the IKM as a CryptoKey and runs extract+expand
  // in one shot.
  const baseKey = await crypto.subtle.importKey(
    'raw',
    ikm as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ─── Main encrypt entrypoint ───────────────────────────────────────────

export interface PushPayload {
  /** Subscriber's P-256 public key (base64url, 65 bytes uncompressed). */
  p256dh: string;
  /** Subscriber's auth secret (base64url, 16 bytes). */
  auth: string;
  /** Plaintext bytes to encrypt — typically a JSON string. */
  plaintext: Uint8Array;
}

export interface EncryptedPushBody {
  /** Bytes to send as the request body. Already framed for `aes128gcm`. */
  body: Uint8Array;
  /** Content length, for the Content-Length header. */
  contentLength: number;
}

export async function encryptPushPayload(opts: PushPayload): Promise<EncryptedPushBody> {
  const subscriberPub = base64UrlDecode(opts.p256dh); // 65 bytes uncompressed
  const authSecret = base64UrlDecode(opts.auth);      // 16 bytes
  const plaintext = opts.plaintext;

  // 1. Generate ephemeral P-256 keypair.
  // generateKey returns CryptoKey | CryptoKeyPair in the type defs; for
  // asymmetric algorithms it's always a CryptoKeyPair at runtime.
  const ephemeral = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const ephPubJwk = (await crypto.subtle.exportKey('jwk', ephemeral.publicKey)) as JsonWebKey;
  if (!ephPubJwk.x || !ephPubJwk.y) throw new Error('Ephemeral keygen produced no x/y');
  const ephPub = new Uint8Array(65);
  ephPub[0] = 0x04;
  ephPub.set(base64UrlDecode(ephPubJwk.x), 1);
  ephPub.set(base64UrlDecode(ephPubJwk.y), 33);

  // 2. Import the subscriber's public key for ECDH.
  const subscriberPubKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(subscriberPub.slice(1, 33)),
      y: base64UrlEncode(subscriberPub.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // 3. ECDH: derive 32 bytes of shared secret.
  // The Cloudflare workers-types declaration uses `$public` instead of
  // `public` for the ECDH algorithm field — the spec name is `public` and
  // both runtimes accept it. Cast through `unknown` to silence the type
  // mismatch without giving up type-checking elsewhere.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ecdhBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subscriberPubKey } as any,
    ephemeral.privateKey,
    256,
  );
  const ecdhSecret = new Uint8Array(ecdhBits);

  // 4. RFC 8291 KDF (the "auth_secret" mix-in step).
  //    PRK_key = HKDF(auth, ecdh, "WebPush: info" || 0x00 || ua_pub || as_pub, 32)
  const keyInfo = concatBytes(
    new TextEncoder().encode('WebPush: info\x00'),
    subscriberPub,
    ephPub,
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // 5. Generate random 16-byte salt and derive CEK + nonce.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\x00');
  const cek = await hkdf(salt, ikm, cekInfo, 16);
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\x00');
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  // 6. AES-128-GCM encrypt (plaintext || 0x02 padding delimiter).
  const aesKey = await crypto.subtle.importKey(
    'raw',
    cek as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const padded = new Uint8Array(plaintext.length + 1);
  padded.set(plaintext);
  padded[plaintext.length] = 0x02; // single-record final delimiter
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    aesKey,
    padded as BufferSource,
  );
  const ciphertext = new Uint8Array(ciphertextBuf);

  // 7. Frame the output: salt(16) | rs(4 BE) | idlen(1) | keyid(65) | ct
  //    rs = record size, set to 4096 (the conventional default; ciphertext
  //    is always smaller in practice for our payload sizes).
  const rs = 4096;
  const idlen = ephPub.length; // 65 for uncompressed P-256
  const out = new Uint8Array(16 + 4 + 1 + idlen + ciphertext.length);
  let off = 0;
  out.set(salt, off); off += 16;
  out[off++] = (rs >>> 24) & 0xff;
  out[off++] = (rs >>> 16) & 0xff;
  out[off++] = (rs >>> 8) & 0xff;
  out[off++] = rs & 0xff;
  out[off++] = idlen;
  out.set(ephPub, off); off += idlen;
  out.set(ciphertext, off);

  return { body: out, contentLength: out.length };
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
