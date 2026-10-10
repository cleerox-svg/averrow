// Averrow — IdP impersonation tagging glue for threat writers
// (docs/IDP_IMPERSONATION_PLAN_2026-10.md, task T2).
//
// Thin adapter between the pure classifier (lib/idp-impersonation.ts — all
// detection rules live there) and the D1 writers: derives the classifier
// input from a threat row, and resolves brand tokens for the weak-lure path
// (acme-helpdesk.com is IdP-family only when "acme" is the targeted brand).

import { classifyIdpImpersonation, IDP_FAMILY_TECHNIQUES } from "./idp-impersonation";

export interface IdpTag {
  /** Value for threats.technique — the caller's existing value when not IdP-family. */
  technique: string | null;
  /** Value for threats.impersonated_idp. */
  impersonated_idp: string | null;
}

export interface IdpTaggable {
  malicious_domain?: string | null;
  malicious_url?: string | null;
  technique?: string | null;
}

/**
 * Classify one threat. Never overwrites a non-family technique (the
 * classifier returns null for it, and the existing value is passed through).
 */
export function tagThreat(row: IdpTaggable, brandTokens?: string[]): IdpTag {
  const existing = row.technique ?? null;
  const host = row.malicious_domain || row.malicious_url || "";
  if (!host) return { technique: existing, impersonated_idp: null };
  const c = classifyIdpImpersonation({
    host,
    url: row.malicious_url ?? null,
    brandTokens,
    existingTechnique: existing,
  });
  if (!c) return { technique: existing, impersonated_idp: null };
  return { technique: c.technique, impersonated_idp: c.idp };
}

/**
 * True when the row does NOT classify on its own but WOULD if a brand token
 * were present — i.e. the host carries a weak lure (helpdesk, servicedesk,
 * vpn, …). Probes the classifier with the host's own segments as stand-in
 * brand tokens, so the lure vocabulary is never duplicated here. Callers use
 * it to spend a brand lookup only on hosts that can benefit. Misses the
 * unhyphenated brand+weak-lure compound (acmehelpdesk.com); the backfill,
 * which always passes real brand tokens, catches those.
 */
export function needsBrandTokens(row: IdpTaggable): boolean {
  if (techniqueIsSet(row)) return false;
  const host = (row.malicious_domain || row.malicious_url || "").toLowerCase();
  if (!host) return false;
  if (tagThreat(row).impersonated_idp) return false;
  const probe = host
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/, 1)[0]!
    .split(/[.\-_]/)
    .filter((s) => s.length >= 3);
  if (probe.length === 0) return false;
  return tagThreat(row, probe).impersonated_idp !== null;
}

function techniqueIsSet(row: IdpTaggable): boolean {
  return row.technique !== null && row.technique !== undefined && row.technique !== "";
}

/** Brand tokens from a brand row: the full name and the canonical domain's
 *  owner label ("American Express" / americanexpress.com →
 *  ["American Express", "americanexpress"]). Individual name WORDS are
 *  deliberately not tokens: "express" would make expressvpn.com an
 *  American Express VPN lure. The classifier normalizes and drops tokens
 *  < 3 chars and lure words. */
export function brandTokensFrom(name: string | null, canonicalDomain: string | null): string[] {
  const out = new Set<string>();
  if (name) out.add(name);
  if (canonicalDomain) {
    const owner = canonicalDomain.toLowerCase().replace(/^www\./, "").split(".")[0];
    if (owner) out.add(owner);
  }
  return [...out];
}

/**
 * THE idp_lure rule for lookalike_domains rows — shared by the seeder, the
 * lure top-up and the lookalike backfill so they cannot disagree. A
 * permutation is generated from the brand's canonical domain, so that
 * domain's owner label is the brand token (acme.com → acme-helpdesk.com).
 */
export function lookalikeIdpLure(permutationDomain: string, canonicalDomain: string | null): string | null {
  return classifyIdpImpersonation({
    host: permutationDomain,
    brandTokens: brandTokensFrom(null, canonicalDomain),
  })?.idp ?? null;
}

const FAMILY_PH = IDP_FAMILY_TECHNIQUES.map(() => "?").join(", ");

/**
 * UPDATE stamping technique + impersonated_idp on one threat, guarded in SQL
 * so a non-family technique written concurrently is never overwritten.
 * 7 binds.
 */
export function idpTagUpdateStmt(db: D1Database, threatId: string, tag: IdpTag): D1PreparedStatement {
  return db.prepare(
    `UPDATE threats SET technique = ?, impersonated_idp = ?
      WHERE id = ? AND (technique IS NULL OR technique IN (${FAMILY_PH}))`,
  ).bind(tag.technique, tag.impersonated_idp, threatId, ...IDP_FAMILY_TECHNIQUES);
}

// Isolate-level cache: brand names / canonical domains are slow-changing,
// and a feed pull re-sees the same handful of brands every tick.
const TOKEN_CACHE = new Map<string, string[]>();
const TOKEN_CACHE_MAX = 2000;
/** D1 caps a statement at 100 bound parameters. */
const BRAND_LOOKUP_CHUNK = 90;

/** Resolve brand tokens for `brandIds` (deduped, chunked PK lookups,
 *  isolate-cached). Best-effort: a lookup failure yields no tokens for that
 *  chunk — strong lures and tenant hosts still classify without them. */
export async function loadBrandTokens(
  db: D1Database | D1DatabaseSession,
  brandIds: Iterable<string>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const missing: string[] = [];
  for (const id of new Set(brandIds)) {
    const hit = TOKEN_CACHE.get(id);
    if (hit) out.set(id, hit);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += BRAND_LOOKUP_CHUNK) {
    const chunk = missing.slice(i, i + BRAND_LOOKUP_CHUNK);
    try {
      const res = await db
        .prepare(`SELECT id, name, canonical_domain FROM brands WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<{ id: string; name: string | null; canonical_domain: string | null }>();
      if (TOKEN_CACHE.size + chunk.length > TOKEN_CACHE_MAX) TOKEN_CACHE.clear();
      for (const r of res.results ?? []) {
        const tokens = brandTokensFrom(r.name, r.canonical_domain);
        TOKEN_CACHE.set(r.id, tokens);
        out.set(r.id, tokens);
      }
    } catch {
      // Best-effort — see doc comment.
    }
  }
  return out;
}
