/**
 * VAPID (RFC 8292) JWT signer for Web Push.
 *
 * Web Crypto only — no Node crypto, no third-party libs. Signs an ES256
 * JWT proving the Worker is authorized to push to a given push service
 * endpoint. The public key is shared with the push service alongside the
 * JWT so it can verify the signature.
 *
 * Used by `lib/push.ts` to build the `Authorization: vapid t=<jwt>, k=<pub>`
 * header on every send.
 *
 * Storage assumptions (see migration 0104):
 *   - VAPID public key  → platform_config.vapid_public_key (base64url, 65 bytes raw P-256)
 *   - VAPID subject     → platform_config.vapid_subject ('mailto:ops@averrow.com')
 *   - VAPID private key → wrangler secret VAPID_PRIVATE_KEY (base64url, 32 bytes raw P-256 d)
 */

import { base64UrlDecode, base64UrlEncode } from './push-encryption';

/** Build a JWT claiming the right to push to `audience` (push service origin). */
export async function buildVapidJWT(
  audience: string,
  subject: string,
  privateKeyBase64Url: string,
  publicKeyBase64Url: string,
): Promise<{ jwt: string; publicKey: string }> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    // 12-hour expiry is the conventional max for VAPID; push services reject
    // anything longer than 24h. Using 12h gives plenty of clock-skew slack.
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };

  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const claimsB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${claimsB64}`;

  const privateKey = await importVapidPrivateKey(privateKeyBase64Url, publicKeyBase64Url);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  // Web Crypto signs ES256 as raw r||s (64 bytes). VAPID expects exactly
  // that — no DER wrapping. So this maps 1:1.
  const sigB64 = base64UrlEncode(new Uint8Array(signature));
  return { jwt: `${signingInput}.${sigB64}`, publicKey: publicKeyBase64Url };
}

/** Import the raw P-256 private scalar `d` as a CryptoKey for ECDSA signing.
 *  We need the matching public key bytes to construct a JWK record because
 *  Web Crypto's `importKey('jwk', ...)` requires both `d` and `x`/`y`. */
async function importVapidPrivateKey(
  privateKeyBase64Url: string,
  publicKeyBase64Url: string,
): Promise<CryptoKey> {
  const dBytes = base64UrlDecode(privateKeyBase64Url);
  if (dBytes.length !== 32) {
    throw new Error(`VAPID private key must be 32 bytes, got ${dBytes.length}`);
  }

  const pubBytes = base64UrlDecode(publicKeyBase64Url);
  // Uncompressed point format: 0x04 || X (32) || Y (32). VAPID always uses uncompressed.
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error(`VAPID public key must be 65 bytes uncompressed (0x04 prefix), got ${pubBytes.length}`);
  }
  const x = pubBytes.slice(1, 33);
  const y = pubBytes.slice(33, 65);

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: base64UrlEncode(dBytes),
      x: base64UrlEncode(x),
      y: base64UrlEncode(y),
      ext: false,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** One-shot keypair generator — used by the admin bootstrap endpoint
 *  (and the standalone scripts/generate-vapid-keys.ts) to produce a fresh
 *  VAPID keypair. Returns base64url-encoded raw bytes. */
export async function generateVapidKeypair(): Promise<{
  publicKey: string;   // 65 bytes uncompressed (0x04 || X || Y), base64url
  privateKey: string;  // 32 bytes raw scalar d, base64url
}> {
  // generateKey returns CryptoKey | CryptoKeyPair in the type defs (the
  // shape depends on the algorithm); for asymmetric keygen it's always a
  // CryptoKeyPair at runtime, so cast.
  const keypair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  )) as CryptoKeyPair;

  const pubJwk = (await crypto.subtle.exportKey('jwk', keypair.publicKey)) as JsonWebKey;
  const prvJwk = (await crypto.subtle.exportKey('jwk', keypair.privateKey)) as JsonWebKey;

  if (!pubJwk.x || !pubJwk.y || !prvJwk.d) {
    throw new Error('Web Crypto returned an EC JWK without x/y/d — runtime is broken');
  }

  // Reconstruct uncompressed point: 0x04 || X || Y.
  const x = base64UrlDecode(pubJwk.x);
  const y = base64UrlDecode(pubJwk.y);
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);

  return {
    publicKey: base64UrlEncode(uncompressed),
    privateKey: prvJwk.d, // already base64url
  };
}
