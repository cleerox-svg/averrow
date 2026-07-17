/**
 * SSL certificate identity helpers (NEXUS Lane C).
 *
 * A single, shared SAN-set hash derivation so a certificate observed via
 * crt.sh (feeds/certstream.ts) and the same certificate observed via the
 * calidog WebSocket (durableObjects/CertStreamMonitor.ts) produce an
 * IDENTICAL ssl_san_hash. Lane C clusters on that hash, so cross-source
 * consistency is the whole point — both sources MUST call this function.
 */

/**
 * SHA-256 hex of the sorted, de-duplicated, lowercased SAN list.
 *
 * Normalization: trim each entry, lowercase, drop empties, de-duplicate,
 * then sort so ordering differences between sources never change the
 * hash. Returns null when the SAN set is empty (nothing to key on).
 *
 * Uses Web Crypto (crypto.subtle.digest) — available in the Workers
 * runtime and in Durable Objects. Async because subtle.digest is async.
 */
export async function computeSanHash(
  sans: readonly string[],
): Promise<string | null> {
  const normalized = [
    ...new Set(
      sans
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  ].sort();

  if (normalized.length === 0) return null;

  const bytes = new TextEncoder().encode(normalized.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
